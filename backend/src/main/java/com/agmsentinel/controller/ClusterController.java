package com.agmsentinel.controller;

import com.agmsentinel.dto.Dtos.*;
import com.agmsentinel.service.ClusterDraftService;
import com.agmsentinel.service.QuestionService;
import org.springframework.web.bind.annotation.*;

import java.security.Principal;
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

    public ClusterController(QuestionService service, ClusterDraftService drafts) {
        this.service = service;
        this.drafts = drafts;
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

    public record BoardRequest(Integer limit) { }

    /** The cluster id moves into the body so the route keeps a readable name. */
    public record DraftRequestBody(String clusterId, String representativeQuestion) { }

    public record SaveAnswerRequest(String clusterId, String answer) { }
}
