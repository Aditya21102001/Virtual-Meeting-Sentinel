package com.agmsentinel.service;

import com.agmsentinel.config.DraftAsyncConfig;
import com.agmsentinel.dto.Dtos.DraftResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Produces the automatic answer for a cluster, off the request thread.
 *
 * <p>A separate bean from {@link ClusterDraftService} on purpose: {@code @Async} and
 * {@code @Transactional} are proxy-based, so a service calling its own annotated method gets
 * neither. This runs the model call with no transaction open — a 60-second LLM round trip must not
 * hold a database connection — and calls back into the service for each short write.
 *
 * <h2>Why it retries</h2>
 * The usual reason a free-tier model fails is not that it is broken but that it is busy: a 429, a
 * cold start, a timeout. Handing those straight to a moderator as "write this yourself" would push
 * work onto a person that waiting ten seconds would have done. So transient failures are retried
 * with a widening delay, and only a cluster that has exhausted its attempts is flagged
 * {@code NEEDS_MANUAL}. At that point it stops being retried automatically — a model that is
 * genuinely down should not be hammered once per incoming question.
 */
@Component
public class ClusterDraftWorker {

    private static final Logger log = LoggerFactory.getLogger(ClusterDraftWorker.class);

    private final ClusterDraftService drafts;
    private final AiClient ai;
    /** Confines retrieval to the live meeting's documents when scoping is on. */
    private final MeetingScope scope;
    private final int maxAttempts;
    private final long baseDelayMs;

    /**
     * Clusters with a draft already in flight.
     *
     * <p>Two people asking the same question within a second both create work for the same cluster;
     * without this they would both call the model for the same answer. Cheap insurance against
     * paying twice for one draft.
     */
    private final Set<UUID> inFlight = ConcurrentHashMap.newKeySet();

    public ClusterDraftWorker(ClusterDraftService drafts, AiClient ai, MeetingScope scope,
                              @Value("${draft.max-attempts:3}") int maxAttempts,
                              @Value("${draft.retry-delay-ms:6000}") long baseDelayMs) {
        this.drafts = drafts;
        this.ai = ai;
        this.scope = scope;
        this.maxAttempts = Math.max(1, maxAttempts);
        this.baseDelayMs = Math.max(0, baseDelayMs);
    }

    /**
     * Draft an answer for {@code clusterId}, retrying transient model failures.
     *
     * <p>Never throws: it is called fire-and-forget from the ingest path, where an exception would
     * have nowhere to go. Every outcome — success, or giving up — is recorded on the cluster row and
     * broadcast, so the moderator board is the place both are visible.
     */
    @Async(DraftAsyncConfig.EXECUTOR)
    public void draftInBackground(UUID clusterId, String representativeQuestion) {
        if (!inFlight.add(clusterId)) {
            log.debug("Draft already in flight for cluster {} — skipping duplicate request.", clusterId);
            return;
        }
        try {
            for (int attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    // Same scoping as the synchronous path: an answer must not be grounded in
                    // a document belonging to a different meeting just because it was drafted
                    // in the background.
                    DraftResult result = ai.draft(clusterId.toString(), representativeQuestion,
                                                  scope.knowledgeMeetingId().orElse(null));
                    if (result == null || result.answer() == null || result.answer().isBlank()) {
                        throw new IllegalStateException("The model returned an empty answer.");
                    }
                    drafts.applyDraft(clusterId, result);
                    drafts.broadcastBoard();
                    log.info("Drafted an answer for cluster {} on attempt {}.", clusterId, attempt);
                    return;
                } catch (Exception ex) {
                    boolean lastAttempt = attempt == maxAttempts;
                    String reason = describe(ex);
                    drafts.recordFailure(clusterId, reason, lastAttempt);

                    if (lastAttempt) {
                        log.warn("Giving up on drafting cluster {} after {} attempt(s): {} — a "
                                 + "moderator will be asked to write it.", clusterId, attempt, reason);
                        drafts.broadcastBoard();
                        return;
                    }
                    // Widening delay: a rate-limited or cold-starting model needs time, not volume.
                    long delay = baseDelayMs * (1L << (attempt - 1));
                    log.info("Draft attempt {}/{} for cluster {} failed ({}); retrying in {}ms.",
                             attempt, maxAttempts, clusterId, reason, delay);
                    if (!sleep(delay)) return;   // interrupted: shutting down, stop quietly
                }
            }
        } finally {
            inFlight.remove(clusterId);
        }
    }

    /** True if the wait completed; false if the thread was interrupted and should stop. */
    private boolean sleep(long millis) {
        if (millis <= 0) return true;
        try {
            Thread.sleep(millis);
            return true;
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * A short reason a moderator can act on. The wrapped WebClient exceptions carry stack traces
     * and URLs that mean nothing on a board, so only the message survives.
     */
    private String describe(Exception ex) {
        String message = ex.getMessage();
        if (message == null || message.isBlank()) message = ex.getClass().getSimpleName();
        message = message.replaceAll("\\s+", " ").trim();
        return message.length() > 300 ? message.substring(0, 300) : message;
    }
}
