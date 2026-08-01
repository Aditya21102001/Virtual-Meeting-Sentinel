package com.agmsentinel.controller;

import com.agmsentinel.dto.VideoDtos.VideoCard;
import com.agmsentinel.dto.VideoDtos.VideoStorageStatus;
import com.agmsentinel.service.VideoLibraryService;
import com.agmsentinel.service.VideoUrlFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Admin-side video management: upload, watch processing progress, edit, re-process, delete.
 *
 * <p>Under {@code /api/admin/**}, so {@code SecurityConfig} already restricts every route here to
 * MODERATOR/ADMIN.
 *
 * <p>The upload returns as soon as the bytes are on the NAS, with {@code status=PROCESSING} and
 * {@code progressPercent=0}. Segmentation happens on the transcode worker, and the UI polls
 * {@code GET /api/admin/videos/{id}} for progress — holding the HTTP request open for the length of
 * an ffmpeg run would simply time out for anything longer than a few minutes.
 */
@RestController
@RequestMapping("/api/admin/videos")
public class VideoAdminController {

    private final VideoLibraryService library;
    private final VideoUrlFactory urls;

    public VideoAdminController(VideoLibraryService library, VideoUrlFactory urls) {
        this.library = library;
        this.urls = urls;
    }

    /** Storage + ffmpeg health, shown as a banner so a misconfigured NAS is obvious before upload. */
    @GetMapping("/status")
    public VideoStorageStatus status() {
        return library.status();
    }

    /** Every video regardless of state, so failures and in-flight transcodes are visible. */
    @GetMapping
    public List<VideoCard> list() {
        String subject = currentSubject();
        return library.listAll().stream().map(v -> urls.card(v, subject)).toList();
    }

    @GetMapping("/{id}")
    public VideoCard one(@PathVariable UUID id) {
        return urls.card(library.get(id), currentSubject());
    }

    /**
     * Upload a recording. {@code file} streams to the NAS; {@code title}/{@code description} are
     * optional (the filename becomes the title when omitted).
     */
    @PostMapping
    public VideoCard upload(@RequestParam("file") MultipartFile file,
                           @RequestParam(required = false) String title,
                           @RequestParam(required = false) String description) {
        return urls.card(library.upload(file, title, description, currentSubject()), currentSubject());
    }

    @PatchMapping("/{id}")
    public VideoCard update(@PathVariable UUID id, @RequestBody Map<String, String> body) {
        return urls.card(library.updateMetadata(id, body.get("title"), body.get("description")),
                currentSubject());
    }

    /**
     * Re-run segmentation from the stored original — the fix for a failed transcode, a changed
     * ladder, or a video that landed while ffmpeg was missing.
     */
    @PostMapping("/{id}/reprocess")
    public VideoCard reprocess(@PathVariable UUID id) {
        return urls.card(library.reprocess(id), currentSubject());
    }

    /** Remove the catalogue row, its segment index, and the whole folder on the NAS. */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable UUID id) {
        library.delete(id);
        return ResponseEntity.noContent().build();
    }

    private String currentSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth == null ? "admin" : String.valueOf(auth.getName());
    }
}
