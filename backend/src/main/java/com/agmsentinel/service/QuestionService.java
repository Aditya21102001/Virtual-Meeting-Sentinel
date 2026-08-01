package com.agmsentinel.service;

import com.agmsentinel.dto.Dtos.*;
import com.agmsentinel.model.Question;
import com.agmsentinel.repository.QuestionRepository;
import org.springframework.beans.factory.ObjectProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;

/**
 * Orchestrates the ingest pipeline:
 *   persist question -> AI cluster assignment -> store cluster id -> draft an answer -> push board.
 *
 * <h2>Drafting on arrival</h2>
 * A cluster gets its answer as soon as it exists, not once three people have asked the same thing.
 * Two things keep that affordable. It happens <b>once per cluster</b> — the second and third person
 * to ask inherit the answer rather than each triggering another model call — and it happens
 * <b>off this thread</b> ({@link ClusterDraftWorker}), because an attendee pressing Submit should
 * not wait on a 60-second LLM round trip to find out their question was received.
 *
 * <p>When the model cannot produce one, the cluster is flagged for a moderator to write by hand
 * instead of silently having no answer. Both outcomes are durable — see {@link ClusterDraftService}.
 */
@Service
public class QuestionService {

    private static final Logger log = LoggerFactory.getLogger(QuestionService.class);

    private final QuestionRepository questions;
    private final AiClient ai;
    private final ClusterDraftService drafts;
    private final ClusterDraftWorker draftWorker;
    private final ObjectProvider<KafkaQuestionProducer> kafkaProducer;  // present only in kafka mode
    private final boolean kafkaMode;

    public QuestionService(QuestionRepository questions, AiClient ai,
                           ClusterDraftService drafts, ClusterDraftWorker draftWorker,
                           ObjectProvider<KafkaQuestionProducer> kafkaProducer,
                           @Value("${queue.mode:http}") String queueMode) {
        this.questions = questions;
        this.ai = ai;
        this.drafts = drafts;
        this.draftWorker = draftWorker;
        this.kafkaProducer = kafkaProducer;
        this.kafkaMode = "kafka".equalsIgnoreCase(queueMode);
    }

    public IngestResult submit(SubmitQuestionRequest req) {
        Question q = questions.save(new Question(req.text(), req.attendeeId(), req.weight()));

        if (kafkaMode) {
            // Async ingest: append to the durable log and return immediately. The AI service
            // consumes + clusters it, and the scheduled board push (BoardRefreshScheduler)
            // reflects the new/updated cluster to moderators. Auto-drafting hot clusters is
            // handled inside the AI consumer in this mode.
            kafkaProducer.getObject().publish(q.getId().toString(), req.text(), req.attendeeId(), req.weight());
            return new IngestResult(q.getId().toString(), "pending", false, 0.0, 0);
        }

        // Synchronous HTTP path (queue.mode=http): call the AI service and get the assignment now.
        IngestResult result = ai.ingest(q.getId().toString(), req.text(), req.attendeeId(), req.weight());
        q.setClusterId(UUID.fromString(result.cluster_id()));
        questions.save(q);

        queueDraft(result, req.text());
        broadcastBoard();
        return result;
    }

    /**
     * Record the cluster and, if it has no answer yet, start drafting one in the background.
     *
     * <p>Wrapped because this must never be the reason a submission fails. The attendee's question
     * is already saved by this point; a clusterer or model problem is the board's concern, not
     * theirs, and returning an error here would invite them to submit the same question again.
     */
    private void queueDraft(IngestResult result, String questionText) {
        try {
            UUID clusterId = UUID.fromString(result.cluster_id());
            boolean needsDraft = drafts.recordAndNeedsDraft(
                    clusterId, questionText, result.cluster_size(), 0);
            if (needsDraft) {
                draftWorker.draftInBackground(clusterId, questionText);
            }
        } catch (Exception ex) {
            log.warn("Could not queue a draft for cluster {}: {}", result.cluster_id(), ex.getMessage());
        }
    }

    /**
     * Bulk-ingest an uploaded question bank. Each line is clustered like a live question,
     * but we broadcast the board only ONCE at the end instead of per line.
     * Returns the number of questions ingested.
     */
    public int submitBulk(List<String> texts, float weight) {
        int ingested = 0;
        for (String text : texts) {
            String clean = text.trim();
            if (clean.isEmpty()) continue;
            Question q = questions.save(new Question(clean, "question-bank", weight));
            try {
                if (kafkaMode) {
                    kafkaProducer.getObject().publish(q.getId().toString(), clean, "question-bank", weight);
                } else {
                    IngestResult result = ai.ingest(q.getId().toString(), clean, "question-bank", weight);
                    q.setClusterId(UUID.fromString(result.cluster_id()));
                    questions.save(q);
                    queueDraft(result, clean);
                }
                ingested++;
            } catch (Exception ignored) {
                // Skip a bad line rather than aborting the whole upload.
            }
        }
        broadcastBoard();
        return ingested;
    }

    /**
     * Push the current ranked, deduplicated board to all subscribed moderators.
     *
     * <p>Delegated, because the board is no longer purely the AI service's answer: stored drafts are
     * laid over it so answers survive that service restarting. One implementation, so a WebSocket
     * push and a REST fetch can never disagree about what the board says.
     */
    public void broadcastBoard() {
        drafts.broadcastBoard();
    }

    /** Moderator asks for a draft explicitly — including a retry after automatic drafting gave up. */
    public DraftResult draftFor(String clusterId, String representativeQuestion) {
        UUID id = UUID.fromString(clusterId);
        drafts.resetForRetry(id);
        DraftResult draft = ai.draft(clusterId, representativeQuestion);
        drafts.applyDraft(id, draft);
        broadcastBoard();
        return draft;
    }
}
