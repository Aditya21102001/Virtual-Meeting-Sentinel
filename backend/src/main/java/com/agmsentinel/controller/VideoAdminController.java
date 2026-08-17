package com.agmsentinel.controller;

import com.agmsentinel.dto.VideoDtos.ChapterView;
import com.agmsentinel.dto.VideoDtos.SaveChaptersRequest;
import com.agmsentinel.dto.VideoDtos.VideoCard;
import com.agmsentinel.model.Video;
import com.agmsentinel.dto.VideoDtos.VideoStorageStatus;
import com.agmsentinel.security.Feature;
import com.agmsentinel.security.RequiresFeature;
import com.agmsentinel.service.AiClient;
import com.agmsentinel.service.SubtitleConverter;
import com.agmsentinel.service.VideoChapterService;
import com.agmsentinel.service.VideoLibraryService;
import com.agmsentinel.service.VideoUrlFactory;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Map;

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
@RequiresFeature(Feature.VIDEO_LIBRARY)
@RestController
@RequestMapping("/api/admin/videos")
public class VideoAdminController {

    private static final Logger log = LoggerFactory.getLogger(VideoAdminController.class);

    private final VideoLibraryService library;
    private final VideoUrlFactory urls;
    private final SubtitleConverter subtitles;
    private final AiClient ai;
    private final VideoChapterService chapters;

    public VideoAdminController(VideoLibraryService library, VideoUrlFactory urls,
                                SubtitleConverter subtitles, AiClient ai,
                                VideoChapterService chapters) {
        this.library = library;
        this.urls = urls;
        this.subtitles = subtitles;
        this.ai = ai;
        this.chapters = chapters;
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
        Video video = library.saveTranscript(id, webVtt);
        indexTranscriptQuietly(video, webVtt);
        return urls.card(video, currentSubject());
    }

    /**
     * Add this recording's captions to the RAG knowledge base, so a drafted answer can cite what was
     * said on the call — with the second, so the citation opens the player at that moment.
     *
     * <p>Separate from the upload as well as automatic, because the two fail independently: the AI
     * service can be asleep or missing an API key while the transcript itself saved perfectly. This
     * is the retry, and the way to backfill recordings whose captions predate the feature.
     */
    @PostMapping("/index-transcript")
    public Map<String, Object> indexTranscript(@RequestBody VideoRef req) {
        Video video = library.get(req.id());
        String webVtt = library.readTranscript(video).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.CONFLICT,
                        "This recording has no transcript to index. Upload a .vtt or .srt first."));
        // Tagged with the recording's own meeting. Null makes it shared with every meeting,
        // which is the right default for a recording whose meeting was never recorded.
        return ai.indexTranscript(video.getId().toString(), video.getTitle(), webVtt,
                                  video.getMeetingId());
    }

    /**
     * Index on upload, but never let it fail the upload.
     *
     * <p>The captions are already saved by this point and are useful on their own — they drive the
     * player's transcript panel whether or not the knowledge base ever sees them. A model service
     * that is down is a reason to press <em>Index transcript</em> later, not a reason to reject a
     * file that was accepted.
     */
    private void indexTranscriptQuietly(Video video, String webVtt) {
        try {
            ai.indexTranscript(video.getId().toString(), video.getTitle(), webVtt,
                               video.getMeetingId());
        } catch (RuntimeException ex) {
            log.warn("Saved the transcript for video {} but could not index it into the knowledge "
                     + "base: {}. Use index-transcript to retry.", video.getId(), ex.getMessage());
        }
    }

    @PostMapping("/delete-transcript")
    public VideoCard deleteTranscript(@RequestBody VideoRef req) {
        return urls.card(library.deleteTranscript(req.id()), currentSubject());
    }

    // ---- chapters ------------------------------------------------------------

    /**
     * Replace this recording's agenda — the named points a viewer can jump to.
     *
     * <p>The whole list every time, not one chapter at a time. Editing an agenda means renaming,
     * moving and deleting entries together, and a per-row API would let a client leave the set
     * half-applied: markers on the progress bar that disagree with the chapter list beside it.
     *
     * <p>Ordinals and ordering are decided here from the start times, so the client can send its
     * rows in whatever order the moderator happened to type them.
     */
    @RequiresFeature(Feature.VIDEO_CHAPTERS)
    @PostMapping("/save-chapters")
    public VideoCard saveChapters(@RequestBody SaveChaptersRequest req) {
        Video video = library.get(req.id());
        chapters.replace(video.getId(), req.chapters());
        return urls.card(video, currentSubject())
                   .withChapters(chapters.forVideo(video.getId()));
    }

    /** Read them back for the editor. Also the way to confirm a save actually landed. */
    @RequiresFeature(Feature.VIDEO_CHAPTERS)
    @PostMapping("/list-chapters")
    public List<ChapterView> listChapters(@RequestBody VideoRef req) {
        return chapters.forVideo(library.get(req.id()).getId());
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
