package com.agmsentinel.service;

import com.agmsentinel.dto.Dtos.BoardUpdate;
import com.agmsentinel.dto.Dtos.Citation;
import com.agmsentinel.dto.Dtos.ClusterView;
import com.agmsentinel.dto.Dtos.DraftResult;
import com.agmsentinel.model.ClusterDraft;
import com.agmsentinel.model.ClusterDraft.DraftStatus;
import com.agmsentinel.repository.ClusterDraftRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Owns the durable half of the question board: which clusters exist, and the answer prepared for
 * each one.
 *
 * <p>The AI service still does the clustering and the RAG, but it holds all of it in memory. This
 * service keeps a row per cluster so that (a) a drafted answer outlives the AI service restarting,
 * (b) a moderator's hand-written answer is never lost, and (c) the board still renders when the AI
 * service is asleep — from the last thing we knew about each cluster, rather than as an empty page.
 *
 * @see ClusterDraftWorker for the retry loop that produces automatic drafts off the request thread
 */
@Service
public class ClusterDraftService {

    private static final Logger log = LoggerFactory.getLogger(ClusterDraftService.class);

    private final ClusterDraftRepository drafts;
    private final AiClient ai;
    private final SimpMessagingTemplate broker;
    /** Whether to filter to the live meeting, and which one. The single decision point. */
    private final MeetingScope scope;
    private final ObjectMapper json = new ObjectMapper();

    public ClusterDraftService(ClusterDraftRepository drafts, AiClient ai,
                               SimpMessagingTemplate broker, MeetingScope scope) {
        this.drafts = drafts;
        this.ai = ai;
        this.broker = broker;
        this.scope = scope;
    }

    // ---- board ---------------------------------------------------------------

    /**
     * The board as moderators see it: the AI service's live ranking, with each cluster's stored
     * answer laid over the top.
     *
     * <p>The overlay is not just a convenience. The AI service forgets drafts when it restarts, so
     * without this a board that looked complete before a redeploy comes back with every answer
     * blank. Reading them from here means the answers are as durable as the questions.
     *
     * <p>If the AI service cannot be reached at all, this falls back to the stored rows. The
     * ranking will be as of the last successful refresh, which is far better than showing a
     * moderator nothing during a cold start.
     */
    @Transactional(readOnly = true)
    public List<ClusterView> board(int limit) {
        // When a meeting is live and MEETINGS is on, the database decides which topics belong to it
        // — the AI service has no idea about meetings and returns everything it is holding. See
        // scopedBoard for why the direction of the join flips.
        Optional<UUID> meeting = scope.activeMeetingId();
        if (meeting.isPresent()) return scopedBoard(meeting.get(), limit);

        List<ClusterView> live;
        try {
            live = ai.clusters(limit);
        } catch (RuntimeException ex) {
            log.warn("AI service unreachable ({}); serving the board from stored clusters.",
                     ex.getMessage());
            return storedBoard(limit);
        }
        if (live == null || live.isEmpty()) return storedBoard(limit);

        List<UUID> ids = live.stream().map(c -> parseId(c.cluster_id()))
                .filter(java.util.Objects::nonNull).toList();
        Map<UUID, ClusterDraft> stored = new LinkedHashMap<>();
        for (ClusterDraft row : drafts.findByClusterIdIn(ids)) {
            stored.put(row.getClusterId(), row);
        }

        List<ClusterView> merged = new ArrayList<>(live.size());
        for (ClusterView view : live) {
            merged.add(overlay(view, stored.get(parseId(view.cluster_id()))));
        }
        return merged;
    }

    /**
     * The board for one meeting.
     *
     * <p><b>Driven from the stored rows, not the live list.</b> Unscoped, the AI service's ranking
     * leads and stored answers are laid over it. That cannot work here: the AI service knows nothing
     * about meetings, so filtering its list would mean dropping anything we could not find a row
     * for — including a topic whose row simply had not been written yet, which would make questions
     * flicker off the board.
     *
     * <p>So membership comes from the database, which is the only thing that knows it, and the live
     * ranking is applied where it exists. A meeting with no topics yields an empty board, which is
     * the correct and intended answer for a meeting nobody has asked anything at.
     */
    private List<ClusterView> scopedBoard(UUID meetingId, int limit) {
        List<ClusterDraft> rows = drafts.findByMeetingIdOrderByPriorityScoreDesc(meetingId);
        if (rows.isEmpty()) return List.of();

        // The live ranking is an enrichment, never a filter. If the AI service is unreachable the
        // board still renders from the stored rows — the same fallback as the unscoped path.
        Map<UUID, ClusterView> live = new LinkedHashMap<>();
        try {
            // Asked for THIS meeting's ranking, not everything: the AI service partitions by
            // meeting too, so requesting the merged board would fetch every meeting's topics
            // and discard all but one meeting's worth.
            List<ClusterView> ranked = ai.clusters(Math.max(limit, rows.size()), meetingId);
            if (ranked != null) {
                for (ClusterView view : ranked) {
                    UUID id = parseId(view.cluster_id());
                    if (id != null) live.put(id, view);
                }
            }
        } catch (RuntimeException ex) {
            log.warn("AI service unreachable ({}); ranking this meeting's board from stored rows.",
                     ex.getMessage());
        }

        List<ClusterView> merged = new ArrayList<>(rows.size());
        for (ClusterDraft row : rows) {
            ClusterView ranked = live.get(row.getClusterId());
            merged.add(ranked == null ? toView(row) : overlay(ranked, row));
        }
        // Re-sorted on the live score where one arrived, since the stored ordering is only as fresh
        // as the last refresh.
        merged.sort(Comparator.comparingDouble(ClusterView::priority_score).reversed());
        return merged.stream().limit(Math.max(1, limit)).toList();
    }

    /** Everything we know without asking the AI service. Ranked as of the last refresh. */
    private List<ClusterView> storedBoard(int limit) {
        return drafts.findAll().stream()
                .sorted(Comparator.comparingDouble(ClusterDraft::getPriorityScore).reversed())
                .limit(Math.max(1, limit))
                .map(row -> toView(row))
                .toList();
    }

    /**
     * Combine a live cluster with its stored answer.
     *
     * <p>The stored answer always wins over the AI service's own copy. After a restart the live
     * copy is empty, and a moderator's hand-written answer only ever exists here.
     */
    private ClusterView overlay(ClusterView live, ClusterDraft row) {
        if (row == null) {
            return new ClusterView(live.cluster_id(), live.representative_question(), live.size(),
                    live.priority_score(), live.draft(), live.citations(),
                    live.draft() == null ? DraftStatus.PENDING.name() : DraftStatus.DRAFTED.name(),
                    null, null);
        }
        boolean haveStoredAnswer = row.getDraftAnswer() != null && !row.getDraftAnswer().isBlank();
        return new ClusterView(
                live.cluster_id(),
                live.representative_question(),
                live.size(),
                live.priority_score(),
                haveStoredAnswer ? row.getDraftAnswer() : live.draft(),
                haveStoredAnswer ? citationsOf(row) : live.citations(),
                row.getStatus().name(),
                row.getDraftError(),
                row.getAnsweredBy());
    }

    private ClusterView toView(ClusterDraft row) {
        return new ClusterView(row.getClusterId().toString(), row.getRepresentativeQuestion(),
                row.getSize(), row.getPriorityScore(), row.getDraftAnswer(), citationsOf(row),
                row.getStatus().name(), row.getDraftError(), row.getAnsweredBy());
    }

    /** Push the current board to every subscribed moderator. */
    public void broadcastBoard() {
        broker.convertAndSend("/topic/board", new BoardUpdate("board", board(20)));
    }

    // ---- lifecycle -----------------------------------------------------------

    /**
     * Record a cluster the moment a question lands in it, and say whether it still needs an answer.
     *
     * <p>Returns true only for a cluster nothing has answered yet — so the second and third person
     * to ask the same thing do not each trigger another LLM call for an answer that already exists.
     * That distinction is what makes "draft on arrival" affordable on a free model tier.
     */
    @Transactional
    public boolean recordAndNeedsDraft(UUID clusterId, String representativeQuestion,
                                       int size, double priorityScore, UUID meetingId) {
        ClusterDraft row = drafts.findById(clusterId).orElse(null);
        if (row == null) {
            row = new ClusterDraft(clusterId, representativeQuestion, size, priorityScore);
            // Stamped from the ACTIVE MEETING, never from MeetingScope.
            //
            // The distinction matters and is easy to get backwards. Scope answers "should the board
            // filter right now", which is false while the MEETINGS flag is off. If the stamp
            // followed that, every topic raised with the flag off would be recorded with no meeting
            // — and the moment somebody switched the flag on, the board would filter to a meeting
            // whose topics all carry null and show nothing.
            //
            // Recording is unconditional; only FILTERING is conditional. That way turning the flag
            // on is instant and turning it off loses nothing.
            row.setMeetingId(meetingId);
            drafts.save(row);
            return true;
        }
        // An existing topic raised again while a meeting is live: adopt it, but never move it from
        // one meeting to another. A topic belongs to the meeting it was first raised at.
        if (row.getMeetingId() == null && meetingId != null) {
            row.setMeetingId(meetingId);
        }
        // Keep the snapshot current so the offline board does not go stale.
        row.setSize(size);
        row.setPriorityScore(priorityScore);
        if (representativeQuestion != null && !representativeQuestion.isBlank()
                && row.getRepresentativeQuestion() == null) {
            row.setRepresentativeQuestion(representativeQuestion);
        }
        drafts.save(row);

        // A moderator's answer is final; a successful draft does not need redoing. A cluster left
        // NEEDS_MANUAL is not retried automatically either — it already exhausted its attempts, and
        // hammering a model that is down on every new question would be the wrong response.
        return row.getStatus() == DraftStatus.PENDING
               && (row.getDraftAnswer() == null || row.getDraftAnswer().isBlank());
    }

    @Transactional
    public void applyDraft(UUID clusterId, DraftResult result) {
        drafts.findById(clusterId).ifPresent(row -> {
            if (row.isHumanWritten()) return;   // never overwrite a person's answer
            row.setDraftAnswer(result.answer());
            row.setCitationsJson(writeCitations(result.citations()));
            row.setStatus(DraftStatus.DRAFTED);
            row.setDraftError(null);
            drafts.save(row);
        });
    }

    /** Record a failed attempt. {@code giveUp} flips the cluster to the moderator's queue. */
    @Transactional
    public void recordFailure(UUID clusterId, String error, boolean giveUp) {
        drafts.findById(clusterId).ifPresent(row -> {
            if (row.isHumanWritten()) return;
            row.setAttempts(row.getAttempts() + 1);
            row.setDraftError(error);
            if (giveUp) row.setStatus(DraftStatus.NEEDS_MANUAL);
            drafts.save(row);
        });
    }

    /**
     * A moderator writes the answer themselves — the fallback for when the model could not.
     *
     * <p>Marked MANUAL permanently, so a later automatic pass cannot quietly replace it.
     */
    @Transactional
    public ClusterView saveManualAnswer(UUID clusterId, String answer, String author) {
        if (answer == null || answer.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "An answer is required.");
        }
        ClusterDraft row = drafts.findById(clusterId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "No such cluster. It may have been cleared when the AI service restarted."));
        row.setDraftAnswer(answer.trim());
        row.setStatus(DraftStatus.MANUAL);
        row.setDraftError(null);
        row.setAnsweredBy(author);
        drafts.save(row);
        return toView(row);
    }

    /** Clusters waiting on a human, most important first — the moderator's to-do list. */
    @Transactional(readOnly = true)
    public List<ClusterView> awaitingManualAnswer() {
        // Scoped in step with the board. A to-do list showing an item the board does not have would
        // send a moderator hunting for a topic they cannot reach — two screens disagreeing about
        // what exists is worse than either rule applied consistently.
        List<ClusterDraft> rows = scope.activeMeetingId()
                .map(id -> drafts.findByMeetingIdAndStatusOrderByPriorityScoreDesc(
                        id, DraftStatus.NEEDS_MANUAL))
                .orElseGet(() -> drafts.findByStatusOrderByPriorityScoreDesc(
                        DraftStatus.NEEDS_MANUAL));
        return rows.stream().map(this::toView).toList();
    }

    /** Let a moderator ask the model to try again after it was flagged as needing a manual answer. */
    @Transactional
    public void resetForRetry(UUID clusterId) {
        drafts.findById(clusterId).ifPresent(row -> {
            row.setStatus(DraftStatus.PENDING);
            row.setAttempts(0);
            row.setDraftError(null);
            drafts.save(row);
        });
    }

    @Transactional(readOnly = true)
    public Optional<ClusterDraft> find(UUID clusterId) {
        return drafts.findById(clusterId);
    }

    // ---- helpers -------------------------------------------------------------

    private UUID parseId(String raw) {
        try {
            return raw == null ? null : UUID.fromString(raw);
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }

    private String writeCitations(List<Citation> citations) {
        if (citations == null || citations.isEmpty()) return null;
        try {
            return json.writeValueAsString(citations);
        } catch (Exception ex) {
            // The answer is the valuable part; losing its citations must not lose the answer.
            log.warn("Could not serialise citations: {}", ex.getMessage());
            return null;
        }
    }

    private List<Citation> citationsOf(ClusterDraft row) {
        if (row.getCitationsJson() == null || row.getCitationsJson().isBlank()) return List.of();
        try {
            return json.readValue(row.getCitationsJson(), new TypeReference<List<Citation>>() { });
        } catch (Exception ex) {
            return List.of();
        }
    }
}
