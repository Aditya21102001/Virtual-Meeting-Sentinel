package com.agmsentinel.controller;

import com.agmsentinel.dto.Dtos.*;
import com.agmsentinel.service.QuestionService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/questions")
public class QuestionController {

    private final QuestionService service;

    public QuestionController(QuestionService service) {
        this.service = service;
    }

    /** Attendees submit questions here. Returns the cluster the question folded into. */
    @PostMapping
    public IngestResult submit(@Valid @RequestBody SubmitQuestionRequest req) {
        return service.submit(req);
    }
}
