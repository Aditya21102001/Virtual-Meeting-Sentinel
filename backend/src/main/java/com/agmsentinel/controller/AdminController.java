package com.agmsentinel.controller;

import com.agmsentinel.service.AiClient;
import com.agmsentinel.service.QuestionService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Moderator setup endpoints: upload source PDFs (indexed into the RAG knowledge base — several may
 * be indexed side by side), remove an indexed document again, and upload a question bank
 * (bulk-ingested into the live board).
 * All routes require the MODERATOR role (see SecurityConfig) — load-bearing here, because removing
 * a document is destructive and cannot be undone from the UI.
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
    @PostMapping("/knowledge-status")
    public Map<String, Object> knowledgeStatus() {
        return ai.knowledgeStatus();
    }

    /** Names one indexed document. In the body rather than the path, so the URL stays readable. */
    public record KnowledgeSourceRef(String filename) { }

    /**
     * Remove one indexed document: its stored file, its chunks and its embeddings.
     *
     * <p>A named POST rather than {@code DELETE}, and the filename in the body rather than the path.
     * Neither is decoration: {@code SecurityConfig}'s CORS configuration advertises only
     * GET/POST/OPTIONS, so a DELETE would fail the browser's preflight, and a path variable would
     * put a hostile, URL-encoded filename into the route template for no benefit.
     *
     * <p>The name is checked here and checked again at the filesystem inside the AI service. Two
     * independent guards, neither trusting the other, because this one deletes files.
     */
    @PostMapping("/remove-knowledge-source")
    public ResponseEntity<?> removeKnowledgeSource(@RequestBody KnowledgeSourceRef req) {
        String name = req == null || req.filename() == null ? "" : req.filename().trim();
        if (name.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "No document name provided."));
        }
        // Tested, never normalised. Quietly reducing "../../app/main.py" to "main.py" would still
        // delete a file — just not the one the request named, which is worse than refusing.
        if (name.contains("/") || name.contains("\\") || name.startsWith(".")
                || !name.equals(Paths.get(name).getFileName().toString())) {
            return ResponseEntity.badRequest().body(Map.of("error", "That is not a document name."));
        }
        // Deliberately no ".pdf" check, unlike the upload above: transcript sources are indexed as
        // recording-<videoId>.vtt, and demanding a PDF extension would make them unremovable.
        try {
            // The AI service returns the post-rebuild status, so the caller can refresh its whole
            // panel from this one response without a second round-trip.
            return ResponseEntity.ok(ai.removeKnowledgeSource(name));
        } catch (WebClientResponseException.NotFound ex) {
            // The only AI-service 404 that is an expected, operator-caused outcome rather than a
            // fault — a stale sources list — so it is the only one worth translating here. Left
            // unhandled it would reach the SPA as a bare 500 with no message to show.
            return ResponseEntity.status(404).body(Map.of("error",
                    "That document is not in the knowledge base — the list may be out of date."));
        } catch (WebClientResponseException.BadRequest ex) {
            return ResponseEntity.badRequest().body(Map.of("error", "That is not a document name."));
        }
    }

    /**
     * Per-endpoint ceiling for report PDFs. The container's multipart limit is sized for video
     * uploads now, so the document path enforces its own (much smaller) limit here rather than
     * relying on a shared global one.
     */
    private static final long MAX_PDF_BYTES = 25L * 1024 * 1024;

    /** Upload an annual-report PDF -> indexed into RAG at runtime. */
    @PostMapping("/upload-annual-report")
    public ResponseEntity<?> uploadKnowledge(@RequestParam("file") MultipartFile file) throws IOException {
        if (file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "No file provided."));
        }
        String name = file.getOriginalFilename();
        if (name == null || !name.toLowerCase().endsWith(".pdf")) {
            return ResponseEntity.badRequest().body(Map.of("error", "Only PDF files are supported."));
        }
        if (file.getSize() > MAX_PDF_BYTES) {
            return ResponseEntity.badRequest().body(Map.of("error", "PDF is larger than the 25 MB limit."));
        }
        Map<String, Object> result = ai.uploadKnowledge(name, file.getBytes());
        return ResponseEntity.ok(result);
    }

    /**
     * Upload a question bank (one question per line; .txt or .csv). A first line equal to
     * "question" is treated as a header and skipped. Each line is clustered like a live question.
     */
    @PostMapping("/upload-question-bank")
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
