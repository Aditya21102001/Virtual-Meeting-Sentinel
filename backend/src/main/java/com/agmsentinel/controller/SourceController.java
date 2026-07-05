package com.agmsentinel.controller;

import com.agmsentinel.service.AiClient;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Serves source documents (annual-report PDFs) behind citation links. Deliberately PUBLIC:
 * the browser's PDF viewer opens these in a new tab and won't send the Authorization header,
 * and an annual report is a public disclosure anyway. Path traversal is blocked by the AI
 * service (it basenames the filename before resolving).
 */
@RestController
@RequestMapping("/api/source")
public class SourceController {

    private final AiClient ai;

    public SourceController(AiClient ai) {
        this.ai = ai;
    }

    @GetMapping("/{filename}")
    public ResponseEntity<byte[]> source(@PathVariable String filename) {
        byte[] pdf = ai.fetchKnowledgeFile(filename);
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + filename + "\"")
                .body(pdf);
    }
}
