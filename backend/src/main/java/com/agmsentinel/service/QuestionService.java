package com.agmsentinel.service;

import com.agmsentinel.dto.Dtos.*;
import com.agmsentinel.model.Question;
import com.agmsentinel.repository.QuestionRepository;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;

/**
 * Orchestrates the ingest pipeline:
 *   persist question -> AI cluster assignment -> store cluster id -> push live board.
 *
 * Draft generation is triggered when a cluster gets "hot" (crosses a size threshold) or
 * on explicit moderator request, keeping bounded/free LLM usage focused on what matters.
 */
@Service
public class QuestionService {

    private static final int HOT_CLUSTER_THRESHOLD = 3;   // auto-draft once N people ask the same thing

    private final QuestionRepository questions;
    private final AiClient ai;
    private final SimpMessagingTemplate broker;
    private final ObjectProvider<KafkaQuestionProducer> kafkaProducer;  // present only in kafka mode
    private final boolean kafkaMode;

    public QuestionService(QuestionRepository questions, AiClient ai, SimpMessagingTemplate broker,
                           ObjectProvider<KafkaQuestionProducer> kafkaProducer,
                           @Value("${queue.mode:http}") String queueMode) {
        this.questions = questions;
        this.ai = ai;
        this.broker = broker;
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

        // Auto-draft a grounded answer for freshly-hot clusters (fire-and-forget-ish).
        if (result.cluster_size() == HOT_CLUSTER_THRESHOLD) {
            try {
                ai.draft(result.cluster_id(), req.text());
            } catch (Exception ignored) {
                // Drafting is best-effort; never fail an attendee's submission because of it.
            }
        }

        broadcastBoard();
        return result;
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
                }
                ingested++;
            } catch (Exception ignored) {
                // Skip a bad line rather than aborting the whole upload.
            }
        }
        broadcastBoard();
        return ingested;
    }

    /** Push the current ranked, deduplicated board to all subscribed moderators. */
    public void broadcastBoard() {
        List<ClusterView> board = ai.clusters(20);
        broker.convertAndSend("/topic/board", new BoardUpdate("board", board));
    }

    public DraftResult draftFor(String clusterId, String representativeQuestion) {
        DraftResult draft = ai.draft(clusterId, representativeQuestion);
        broadcastBoard();
        return draft;
    }
}
