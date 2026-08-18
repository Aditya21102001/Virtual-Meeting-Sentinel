package com.agmsentinel.controller;

import com.agmsentinel.service.AiClient;
import com.agmsentinel.service.AiUnavailable;
import com.agmsentinel.service.MeetingScope;
import com.agmsentinel.service.QuestionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
import java.util.UUID;

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

    private static final Logger log = LoggerFactory.getLogger(AdminController.class);

    private final AiClient ai;
    private final QuestionService questions;

    /** Which meeting is live — decides what may be removed. */
    private final MeetingScope scope;

    public AdminController(AiClient ai, QuestionService questions, MeetingScope scope) {
        this.ai = ai;
        this.questions = questions;
        this.scope = scope;
    }

    /**
     * Current knowledge-base status (which documents are indexed, chunk count).
     *
     * <p>Failure is translated rather than propagated. A free-tier AI service that has been idle
     * takes tens of seconds to wake, and any failure to reach it arrives here as an unhandled
     * {@code WebClient} runtime exception — which {@code GlobalExceptionHandler} does not cover, so
     * it would reach the browser as a bare 500 carrying no message the Setup page could display.
     * A 503 with a sentence is the difference between "something broke" and "wait and retry".
     *
     * <p>The catch stays broad — one screen for every failure — but the MESSAGE is classified. The
     * screen is the same; the next action is not. A rate limit, an absent endpoint and a cold start
     * need three different responses from whoever is reading it.
     */
    @PostMapping("/knowledge-status")
    public ResponseEntity<?> knowledgeStatus() {
        try {
            return ResponseEntity.ok(ai.knowledgeStatus());
        } catch (RuntimeException ex) {
            // Logged, because the message returned below is the same for every cause. A timeout, a
            // pool-acquire failure, a prematurely closed connection and a refused connection are
            // four different problems with four different fixes, and without this line they are
            // indistinguishable from each other in production — which is precisely what made this
            // symptom hard to explain.
            log.warn("knowledge-status failed ({}): {}",
                     ex.getClass().getSimpleName(), ex.getMessage());
            // Classified rather than generic. The old single message said "it sleeps when idle" for
            // every cause, which was wrong for a 429 (waiting cannot clear a rate limit) and wrong
            // for a 404 (the endpoint was genuinely missing from a deployment that had drifted).
            // Both were reported as cold starts, and both sent somebody to do the one thing that
            // could not help. See AiUnavailable.
            return ResponseEntity.status(503).body(Map.of("error", AiUnavailable.explain(ex)));
        }
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
            // The live meeting decides what may be removed: a document belonging to a different
            // one is refused by the AI service, which owns the tag.
            return ResponseEntity.ok(
                    ai.removeKnowledgeSource(name, scope.knowledgeMeetingId().orElse(null)));
        } catch (WebClientResponseException.NotFound ex) {
            // The only AI-service 404 that is an expected, operator-caused outcome rather than a
            // fault — a stale sources list — so it is the only one worth translating here. Left
            // unhandled it would reach the SPA as a bare 500 with no message to show.
            return ResponseEntity.status(404).body(Map.of("error",
                    "That document is not in the knowledge base — the list may be out of date."));
        } catch (WebClientResponseException.BadRequest ex) {
            return ResponseEntity.badRequest().body(Map.of("error", "That is not a document name."));
        } catch (WebClientResponseException.Conflict ex) {
            // The document belongs to another meeting. The AI service's message names the way
            // forward — activate that meeting first — so it is passed through rather than replaced.
            return ResponseEntity.status(409).body(Map.of("error", detailOf(ex,
                    "That document belongs to another meeting. Activate that meeting first.")));
        }
    }

    /**
     * Per-endpoint ceiling for report PDFs. The container's multipart limit is sized for video
     * uploads now, so the document path enforces its own (much smaller) limit here rather than
     * relying on a shared global one.
     */
    private static final long MAX_PDF_BYTES = 25L * 1024 * 1024;

    /**
     * The AI service's own explanation, or a fallback.
     *
     * <p>FastAPI puts it in a {@code detail} field. Worth digging out: it is the sentence that says
     * WHICH meeting owns the document, which the generic message cannot.
     */
    private String detailOf(WebClientResponseException ex, String fallback) {
        try {
            Object detail = ex.getResponseBodyAs(Map.class).get("detail");
            if (detail instanceof String text && !text.isBlank()) return text;
        } catch (RuntimeException ignored) {
            // Body was not the expected shape; the fallback is fine.
        }
        return fallback;
    }

    /** Upload an annual-report PDF -> indexed into RAG at runtime. */
    @PostMapping("/upload-annual-report")
    public ResponseEntity<?> uploadKnowledge(
            @RequestParam("file") MultipartFile file,
            /**
             * Which meeting this document belongs to. Absent means SHARED with every meeting,
             * which is the right default for the articles or a standing policy — and the reason a
             * document uploaded without a choice appears against a brand-new meeting.
             */
            @RequestParam(value = "meetingId", required = false) UUID meetingId) throws IOException {
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
        try {
            Map<String, Object> result = ai.uploadKnowledge(name, file.getBytes(), meetingId);
            return ResponseEntity.ok(result);
        } catch (WebClientResponseException ex) {
            // The AI service answered, and said no. Pass its own reason through — it knows things
            // this layer does not, such as a PDF with no extractable text.
            log.warn("Indexing {} failed: AI service returned {} — {}",
                     name, ex.getStatusCode(), ex.getResponseBodyAsString());
            // The AI service's own sentence, not the HTTP status text. It is the one that says WHY
            // — "this document has 1167 pages and this instance can index at most 400" — and
            // "Bad Request" tells the operator nothing they can act on.
            return ResponseEntity.status(502).body(Map.of("error", detailOf(ex,
                    "The AI service could not index that document.")));
        } catch (RuntimeException ex) {
            // It did not answer at all: asleep, restarting, or still blocked by earlier work.
            //
            // Previously this escaped uncaught and became a bare 500 with no message — the same
            // response for a sleeping service, a timeout and a dropped connection, and nothing in
            // the logs to tell them apart. Indexing a large report legitimately takes minutes, so
            // this is the failure most likely to be a timeout rather than a fault.
            log.warn("Indexing {} failed ({}): {}", name, ex.getClass().getSimpleName(),
                     ex.getMessage());
            return ResponseEntity.status(503).body(Map.of("error",
                    "The AI service did not respond while indexing that document. It sleeps when "
                    + "idle and a large report can take a few minutes — check its logs, then try "
                    + "again."));
        }
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
