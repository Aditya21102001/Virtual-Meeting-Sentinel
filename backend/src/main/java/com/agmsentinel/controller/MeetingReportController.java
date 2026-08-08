package com.agmsentinel.controller;

import com.agmsentinel.security.Feature;
import com.agmsentinel.security.RequiresFeature;
import com.agmsentinel.service.MeetingReportService;
import com.agmsentinel.service.MeetingReportService.MeetingReport;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;

/**
 * What happened at a meeting: decisions taken, questions answered, questions left hanging.
 *
 * <p>Behind the {@code MEETING_REPORTS} flag and restricted to MODERATOR/ADMIN by
 * {@code SecurityConfig} — a report gathers the whole meeting into one place, including topics
 * nobody answered, and that is a moderator's working document before it is anything else.
 *
 * <p>Two shapes of the same thing. {@code meeting-report} returns JSON for the screen;
 * {@code download-minutes} returns Markdown as a file, for pasting into the actual minutes. Both
 * come from one assembler, so what is on screen and what gets filed cannot drift apart.
 */
@RequiresFeature(Feature.MEETING_REPORTS)
@RestController
@RequestMapping("/api/reports")
public class MeetingReportController {

    private final MeetingReportService reports;

    public MeetingReportController(MeetingReportService reports) {
        this.reports = reports;
    }

    public record MeetingRef(@NotNull UUID meetingId) { }

    @PostMapping("/meeting-report")
    public MeetingReport meetingReport(@RequestBody MeetingRef req) {
        return reports.build(req.meetingId());
    }

    /**
     * The same report as a Markdown file.
     *
     * <p>POST like everything else, and the browser saves it from the response rather than by
     * navigating — which also means it travels with the Authorization header instead of needing a
     * signed URL, as the media routes do.
     */
    @PostMapping("/download-minutes")
    public ResponseEntity<byte[]> downloadMinutes(@RequestBody MeetingRef req) {
        MeetingReport report = reports.build(req.meetingId());
        byte[] body = reports.toMarkdown(report).getBytes(StandardCharsets.UTF_8);

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + filenameFor(report) + "\"")
                .contentType(new MediaType("text", "markdown", StandardCharsets.UTF_8))
                .body(body);
    }

    /**
     * A filename someone can find again later.
     *
     * <p>Built from the meeting title rather than its id, and stripped to characters that are safe
     * on every filesystem — a title with a slash or a colon in it would otherwise produce a download
     * that Windows refuses to save.
     */
    private String filenameFor(MeetingReport report) {
        String safe = report.title()
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("(^-|-$)", "");
        if (safe.isBlank()) safe = "meeting";
        if (safe.length() > 60) safe = safe.substring(0, 60);
        return safe + "-minutes.md";
    }
}
