package com.agmsentinel.controller;

import com.agmsentinel.service.AiClient;
import com.agmsentinel.service.QuestionService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Moderator setup endpoints: upload the company's annual report (indexed into the RAG
 * knowledge base) and upload a question bank (bulk-ingested into the live board).
 * All routes require the MODERATOR role (see SecurityConfig).
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final AiClient ai;
    private final QuestionService questions;

    public AdminController(AiClient ai, QuestionService questions) {
        this.ai = ai;
        this.questions = questions;
    }

    /** Current knowledge-base status (which reports are indexed, chunk count). */
    @GetMapping("/knowledge")
    public Map<String, Object> knowledgeStatus() {
        return ai.knowledgeStatus();
    }

    /** Upload an annual-report PDF -> indexed into RAG at runtime. */
    @PostMapping("/knowledge")
    public ResponseEntity<?> uploadKnowledge(@RequestParam("file") MultipartFile file) throws IOException {
        if (file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "No file provided."));
        }
        String name = file.getOriginalFilename();
        if (name == null || !name.toLowerCase().endsWith(".pdf")) {
            return ResponseEntity.badRequest().body(Map.of("error", "Only PDF files are supported."));
        }
        Map<String, Object> result = ai.uploadKnowledge(name, file.getBytes());
        return ResponseEntity.ok(result);
    }

    /**
     * Upload a question bank (one question per line; .txt or .csv). A first line equal to
     * "question" is treated as a header and skipped. Each line is clustered like a live question.
     */
    @PostMapping("/question-bank")
    public Map<String, Object> uploadQuestionBank(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "weight", defaultValue = "0.1") float weight) throws IOException {

        String content = new String(file.getBytes(), StandardCharsets.UTF_8);
        List<String> lines = Arrays.stream(content.split("\\r?\\n"))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .filter(s -> !s.equalsIgnoreCase("question"))   // drop a CSV header line
                .toList();

        int ingested = questions.submitBulk(lines, weight);
        return Map.of("received", lines.size(), "ingested", ingested);
    }
}
