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
    @GetMapping
    public List<ClusterView> board(@RequestParam(defaultValue = "20") int limit) {
        return ai.clusters(limit);
    }

    /** Moderator asks for a grounded draft answer for a specific cluster. */
    @PostMapping("/{clusterId}/draft")
    public DraftResult draft(@PathVariable String clusterId,
                             @RequestBody DraftRequestBody body) {
        return service.draftFor(clusterId, body.representativeQuestion());
    }

    public record DraftRequestBody(String representativeQuestion) { }
}
