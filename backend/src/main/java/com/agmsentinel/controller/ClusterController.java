package com.agmsentinel.controller;

import com.agmsentinel.dto.Dtos.*;
import com.agmsentinel.service.AiClient;
import com.agmsentinel.service.QuestionService;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/clusters")
public class ClusterController {

    private final AiClient ai;
    private final QuestionService service;

    public ClusterController(AiClient ai, QuestionService service) {
        this.ai = ai;
        this.service = service;
    }

    /** Moderator board — the current ranked, deduplicated clusters. */
    @PostMapping("/question-board")
    public List<ClusterView> questionBoard(@RequestBody(required = false) BoardRequest req) {
        int limit = req == null || req.limit() == null ? 20 : req.limit();
        return ai.clusters(limit);
    }

    /** Moderator asks for a grounded draft answer for a specific cluster. */
    @PostMapping("/draft-answer")
    public DraftResult draftAnswer(@RequestBody DraftRequestBody body) {
        return service.draftFor(body.clusterId(), body.representativeQuestion());
    }

    public record BoardRequest(Integer limit) { }

    /** The cluster id moves into the body so the route keeps a readable name. */
    public record DraftRequestBody(String clusterId, String representativeQuestion) { }
}
