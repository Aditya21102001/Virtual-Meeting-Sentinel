package com.agmsentinel.controller;

import com.agmsentinel.dto.VideoDtos.VideoCard;
import com.agmsentinel.dto.VideoDtos.VideoStorageStatus;
import com.agmsentinel.service.SubtitleConverter;
import com.agmsentinel.service.VideoLibraryService;
import com.agmsentinel.service.VideoUrlFactory;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;

import java.util.List;
import java.util.UUID;

/**
 * Admin-side video management: upload, watch processing progress, edit, re-process, delete.
 *
 * <p>Under {@code /api/admin/**}, so {@code SecurityConfig} already restricts every route here to
 * MODERATOR/ADMIN.
 *
 * <p>The upload returns as soon as the bytes are on the NAS, with {@code status=PROCESSING} and
 * {@code progressPercent=0}. Segmentation happens on the transcode worker and the UI polls
 * {@code /api/admin/videos/video-details} for progress — holding the HTTP request open for the
 * length of an ffmpeg run would simply time out for anything longer than a few minutes.
 *
 * <h2>Why every route is a named POST</h2>
 * Each endpoint is {@code POST} to a fixed, verb-shaped path, with any identifier in the request
 * body rather than the URL. The browser's network panel labels a request with the last path
 * segment, so the previous REST-style routes showed a column of bare UUIDs — indistinguishable from
 * each other and useless for debugging a page that fires several calls at once. {@code upload-video}
 * and {@code reprocess-video} say what happened. One verb across the whole API also removes the
 * class of bug where a route is reachable by a method its security rule did not anticipate.
 *
 * <p>Media delivery is the deliberate exception and stays {@code GET} — see {@link VideoController}.
 */
@RestController
@RequestMapping("/api/admin/videos")
public class VideoAdminController {

    private final VideoLibraryService library;
    private final VideoUrlFactory urls;
    private final SubtitleConverter subtitles;

    public VideoAdminController(VideoLibraryService library, VideoUrlFactory urls,
                                SubtitleConverter subtitles) {
        this.library = library;
        this.urls = urls;
        this.subtitles = subtitles;
    }

    /** Identifies one video. In the body rather than the path, so the URL stays a readable name. */
    public record VideoRef(@NotNull UUID id) { }

    public record UpdateVideoRequest(@NotNull UUID id, String title, String description) { }

    /** Acknowledges a delete. A 204 would carry nothing for the caller to check. */
    public record DeletedResponse(UUID id, boolean deleted) { }

    /** Storage + ffmpeg health, shown as a banner so a misconfigured NAS is obvious before upload. */
    @PostMapping("/storage-status")
    public VideoStorageStatus storageStatus() {
        return library.status();
    }

    /** Every video regardless of state, so failures and in-flight transcodes are visible. */
    @PostMapping("/list-all-videos")
    public List<VideoCard> listAllVideos() {
        String subject = currentSubject();
        return library.listAll().stream().map(v -> urls.card(v, subject)).toList();
    }

    @PostMapping("/video-details")
    public VideoCard videoDetails(@RequestBody VideoRef req) {
        return urls.card(library.get(req.id()), currentSubject());
    }

    /**
     * Upload a recording. {@code file} streams to the NAS; {@code title}/{@code description} are
     * optional (the filename becomes the title when omitted).
     *
     * <p>Multipart rather than JSON, so the bytes are never base64-inflated and the browser can
     * report real upload progress.
     */
    @PostMapping("/upload-video")
    public VideoCard uploadVideo(@RequestParam("file") MultipartFile file,
                                 @RequestParam(required = false) String title,
                                 @RequestParam(required = false) String description) {
        return urls.card(library.upload(file, title, description, currentSubject()), currentSubject());
    }

    @PostMapping("/update-video-details")
    public VideoCard updateVideoDetails(@RequestBody UpdateVideoRequest req) {
        return urls.card(library.updateMetadata(req.id(), req.title(), req.description()),
                currentSubject());
    }

    /**
     * Re-run segmentation from the stored original — the fix for a failed transcode, a changed
     * ladder, or a video that landed while ffmpeg was missing.
     */
    @PostMapping("/reprocess-video")
    public VideoCard reprocessVideo(@RequestBody VideoRef req) {
        return urls.card(library.reprocess(req.id()), currentSubject());
    }

    /**
     * Attach captions to a recording, from an uploaded {@code .vtt} or {@code .srt}.
     *
     * <p>Uploaded rather than generated on purpose. Producing a transcript means speech-to-text, and
     * running that alongside the transcode on a small instance would reintroduce exactly the
     * resource exhaustion the segmenting pipeline was reworked to avoid. An SRT is converted to
     * WebVTT on the way in, because {@code <track>} accepts nothing else.
     */
    @PostMapping("/upload-transcript")
    public VideoCard uploadTranscript(@RequestParam("id") UUID id,
                                      @RequestParam("file") MultipartFile file) throws IOException {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No subtitle file provided.");
        }
        String webVtt = subtitles.toWebVtt(file.getOriginalFilename(), file.getBytes());
        return urls.card(library.saveTranscript(id, webVtt), currentSubject());
    }

    @PostMapping("/delete-transcript")
    public VideoCard deleteTranscript(@RequestBody VideoRef req) {
        return urls.card(library.deleteTranscript(req.id()), currentSubject());
    }

    /** Remove the catalogue row, its segment index, and the whole folder on the NAS. */
    @PostMapping("/delete-video")
    public DeletedResponse deleteVideo(@RequestBody VideoRef req) {
        library.delete(req.id());
        return new DeletedResponse(req.id(), true);
    }

    private String currentSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth == null ? "admin" : String.valueOf(auth.getName());
    }
}
