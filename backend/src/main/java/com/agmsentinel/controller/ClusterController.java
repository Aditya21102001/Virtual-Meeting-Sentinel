package com.agmsentinel.controller;

import com.agmsentinel.dto.Dtos.*;
import com.agmsentinel.security.Feature;
import com.agmsentinel.security.RequiresFeature;
import com.agmsentinel.service.ClusterCurationService;
import com.agmsentinel.service.ClusterDraftService;
import com.agmsentinel.service.QuestionService;
import org.springframework.web.bind.annotation.*;

import java.security.Principal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * The moderator's question board and the answers attached to it.
 *
 * <p>Answers arrive one of two ways. Normally the model drafts one as soon as a cluster appears,
 * in the background (see {@code ClusterDraftWorker}). When it cannot — the model is down, rate
 * limited, or returning nothing usable — the cluster is flagged and a moderator writes the answer
 * here instead. Either way the result is stored, so it outlives the AI service restarting.
 */
@RestController
@RequestMapping("/api/clusters")
public class ClusterController {

    private final QuestionService service;
    private final ClusterDraftService drafts;
    private final ClusterCurationService curation;

    public ClusterController(QuestionService service, ClusterDraftService drafts,
                             ClusterCurationService curation) {
        this.service = service;
        this.drafts = drafts;
        this.curation = curation;
    }

    /** Moderator board — the current ranked, deduplicated clusters with their answers. */
    @PostMapping("/question-board")
    public List<ClusterView> questionBoard(@RequestBody(required = false) BoardRequest req) {
        int limit = req == null || req.limit() == null ? 20 : req.limit();
        return drafts.board(limit);
    }

    /**
     * Ask the model for a grounded answer now — the manual trigger, and the retry after automatic
     * drafting has given up. Unlike the background attempt this one is synchronous, so the moderator
     * who pressed the button learns whether it worked.
     */
    @RequiresFeature(Feature.AI_DRAFTING)
    @PostMapping("/draft-answer")
    public DraftResult draftAnswer(@RequestBody DraftRequestBody body) {
        return service.draftFor(body.clusterId(), body.representativeQuestion());
    }

    /**
     * A moderator writes the answer themselves.
     *
     * <p>Stored as MANUAL, which automatic drafting will not overwrite: once a person has answered,
     * a model that comes back online must not quietly replace their words.
     */
    @PostMapping("/save-answer")
    public ClusterView saveAnswer(@RequestBody SaveAnswerRequest req, Principal me) {
        return drafts.saveManualAnswer(UUID.fromString(req.clusterId()), req.answer(),
                me == null ? "moderator" : me.getName());
    }

    /** Clusters the model could not answer, most important first — the moderator's to-do list. */
    @PostMapping("/awaiting-answers")
    public List<ClusterView> awaitingAnswers() {
        return drafts.awaitingManualAnswer();
    }

    // ---- curation: fixing the grouping when it is wrong ------------------------

    /**
     * The questions inside one cluster, so a moderator can see what was actually grouped.
     *
     * <p>Needed before any of the actions below are usable: deciding whether a cluster should be
     * split means reading the questions in it, and the board only ever shows the representative one.
     */
    @RequiresFeature(Feature.CLUSTER_CURATION)
    @PostMapping("/cluster-questions")
    public ClusterQuestionsView clusterQuestions(@RequestBody ClusterRef req) {
        UUID id = curation.resolve(UUID.fromString(req.clusterId()));
        List<QuestionInCluster> inside = curation.questionsIn(id).stream()
                .map(q -> new QuestionInCluster(q.getId().toString(), q.getText(), q.getCreatedAt()))
                .toList();
        List<MergedAway> merged = curation.mergedInto(id).stream()
                .map(m -> new MergedAway(m.getSourceClusterId().toString(), m.getSourceQuestion(),
                                         m.getMergedBy(), m.getMergedAt()))
                .toList();
        return new ClusterQuestionsView(id.toString(), inside, merged);
    }

    /**
     * Merge one cluster into another — the fix for one topic split across two groups.
     *
     * <p>Durable: later questions the clusterer would have put in the merged-away cluster are
     * redirected too. See {@code ClusterCurationService} for why that is necessary.
     */
    @RequiresFeature(Feature.CLUSTER_CURATION)
    @PostMapping("/merge-clusters")
    public List<ClusterView> mergeClusters(@RequestBody MergeRequest req, Principal me) {
        curation.merge(UUID.fromString(req.sourceClusterId()),
                       UUID.fromString(req.targetClusterId()),
                       actor(me));
        service.broadcastBoard();   // every moderator's board just changed shape
        return drafts.board(20);
    }

    /**
     * Separate chosen questions out of a cluster — the fix for two topics lumped together.
     *
     * <p>Applies only to the questions already asked; the clusterer has no centroid for the new
     * group, so similar questions arriving later will land wherever it puts them.
     */
    @RequiresFeature(Feature.CLUSTER_CURATION)
    @PostMapping("/split-cluster")
    public List<ClusterView> splitCluster(@RequestBody SplitRequest req, Principal me) {
        curation.split(UUID.fromString(req.clusterId()),
                       req.questionIds().stream().map(UUID::fromString).toList(),
                       actor(me));
        service.broadcastBoard();
        return drafts.board(20);
    }

    /** Move a single misfiled question to another cluster. */
    @RequiresFeature(Feature.CLUSTER_CURATION)
    @PostMapping("/move-question")
    public List<ClusterView> moveQuestion(@RequestBody MoveQuestionRequest req, Principal me) {
        curation.moveQuestion(UUID.fromString(req.questionId()),
                              UUID.fromString(req.targetClusterId()),
                              actor(me));
        service.broadcastBoard();
        return drafts.board(20);
    }

    private String actor(Principal me) {
        return me == null ? "moderator" : me.getName();
    }

    public record BoardRequest(Integer limit) { }

    public record ClusterRef(String clusterId) { }

    public record MergeRequest(String sourceClusterId, String targetClusterId) { }

    public record SplitRequest(String clusterId, List<String> questionIds) { }

    public record MoveQuestionRequest(String questionId, String targetClusterId) { }

    public record QuestionInCluster(String id, String text, Instant createdAt) { }

    /** What was folded into this cluster, so its size is explainable rather than mysterious. */
    public record MergedAway(String clusterId, String question, String mergedBy, Instant mergedAt) { }

    public record ClusterQuestionsView(String clusterId, List<QuestionInCluster> questions,
                                       List<MergedAway> mergedIn) { }

    /** The cluster id moves into the body so the route keeps a readable name. */
    public record DraftRequestBody(String clusterId, String representativeQuestion) { }

    public record SaveAnswerRequest(String clusterId, String answer) { }
}
