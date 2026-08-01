package com.agmsentinel.service;

import com.agmsentinel.config.VideoProperties;
import com.agmsentinel.dto.VideoDtos.VideoStorageStatus;
import com.agmsentinel.model.Video;
import com.agmsentinel.model.VideoRendition;
import com.agmsentinel.model.VideoSegment;
import com.agmsentinel.model.VideoStatus;
import com.agmsentinel.model.VideoStorageMode;
import com.agmsentinel.repository.VideoRepository;
import com.agmsentinel.repository.VideoSegmentRepository;
import com.agmsentinel.service.VideoTranscodeService.MediaInfo;
import com.agmsentinel.service.VideoTranscodeService.RenditionOutput;
import com.agmsentinel.service.VideoTranscodeService.SpriteInfo;
import com.agmsentinel.service.VideoTranscodeService.TranscodeOutput;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;

/**
 * The video catalogue: queries, uploads, and every state transition a video goes through.
 *
 * <p>The upload request does only what must happen synchronously — validate, create the row, stream
 * the bytes to the NAS — and then publishes {@link VideoQueuedEvent}. {@link VideoProcessingWorker}
 * picks that up after the transaction commits and runs ffmpeg off-request, so the admin's browser
 * gets an immediate {@code PROCESSING} response and polls for progress rather than holding a
 * connection open for the length of a transcode.
 *
 * <p>The state transitions are separate short transactions on purpose. One transaction spanning the
 * ffmpeg run would pin a database connection for minutes and make progress invisible until the end.
 */
@Service
public class VideoLibraryService {

    private static final Logger log = LoggerFactory.getLogger(VideoLibraryService.class);

    /**
     * Published when a video needs (re-)processing. Consumed after commit by the transcode worker,
     * which is a separate bean — an {@code @Async} method called on {@code this} would bypass the
     * proxy and run inline on the request thread.
     */
    public record VideoQueuedEvent(UUID videoId) { }

    private final VideoRepository videos;
    private final VideoSegmentRepository segments;
    private final VideoStorageService storage;
    private final VideoMediaStore media;
    private final VideoTranscodeService transcoder;
    private final VideoProperties props;
    private final ApplicationEventPublisher events;

    public VideoLibraryService(VideoRepository videos,
                               VideoSegmentRepository segments,
                               VideoStorageService storage,
                               VideoMediaStore media,
                               VideoTranscodeService transcoder,
                               VideoProperties props,
                               ApplicationEventPublisher events) {
        this.videos = videos;
        this.segments = segments;
        this.storage = storage;
        this.media = media;
        this.transcoder = transcoder;
        this.props = props;
        this.events = events;
    }

    // ---- queries -------------------------------------------------------------

    @Transactional(readOnly = true)
    public List<Video> listAll() {
        return videos.findAllByOrderByCreatedAtDesc();
    }

    @Transactional(readOnly = true)
    public List<Video> listReady() {
        return videos.findByStatusOrderByCreatedAtDesc(VideoStatus.READY);
    }

    @Transactional(readOnly = true)
    public Video get(UUID id) {
        return videos.findWithRenditionsById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Video not found."));
    }

    @Transactional(readOnly = true)
    public Video getPlayable(UUID id) {
        Video video = get(id);
        if (video.getStatus() != VideoStatus.READY) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This video is still " + video.getStatus().name().toLowerCase(Locale.ROOT) + ".");
        }
        return video;
    }

    @Transactional(readOnly = true)
    public List<VideoSegment> segmentsOf(UUID videoId, String renditionName) {
        Video video = get(videoId);
        VideoRendition rendition = pickRendition(video, renditionName);
        return segments.findByRenditionIdOrderBySeqAsc(rendition.getId());
    }

    /**
     * Segment-level seek: which slice covers {@code positionSeconds}. This is the database doing
     * what a player would otherwise do by walking the whole playlist, and it is what lets a client
     * jump straight to the right segment instead of streaming from the start.
     */
    @Transactional(readOnly = true)
    public Optional<VideoSegment> segmentAt(UUID videoId, String renditionName, double positionSeconds) {
        Video video = get(videoId);
        VideoRendition rendition = pickRendition(video, renditionName);
        return segments.findSegmentAt(rendition.getId(), Math.max(0, positionSeconds));
    }

    /** Named rendition, or the highest-quality one when no name is given. */
    public VideoRendition pickRendition(Video video, String name) {
        List<VideoRendition> all = video.getRenditions();
        if (all.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This video has no segmented renditions (it uses progressive delivery).");
        }
        if (name == null || name.isBlank()) return all.get(0);
        return all.stream()
                .filter(r -> r.getName().equalsIgnoreCase(name))
                .findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "No such rendition: " + name));
    }

    @Transactional(readOnly = true)
    public VideoStorageStatus status() {
        List<Video> all = videos.findAll();
        return new VideoStorageStatus(
                media.defaultMode().name(),
                storage.root().toString(),
                storage.configuredNasPath(),
                !storage.isUsingFallback(),
                storage.storageProblem(),
                storage.usableSpaceBytes(),
                media.storedBytesTotal(),
                props.getDatabase().getMaxTotalBytes(),
                transcoder.toolsAvailable(),
                transcoder.toolsVersion(),
                props.getHls().getSegmentSeconds(),
                props.getHls().getLadder(),
                effectiveUploadLimit(),
                all.size(),
                (int) all.stream().filter(v -> v.getStatus() == VideoStatus.READY).count());
    }

    // ---- upload --------------------------------------------------------------

    /**
     * Validate, persist, write to the NAS, queue the transcode. Returns the row in
     * {@code PROCESSING} so the UI can start polling immediately.
     */
    @Transactional
    public Video upload(MultipartFile file, String title, String description, String uploadedBy) {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No file provided.");
        }
        if (file.getSize() > effectiveUploadLimit()) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "File is " + humanBytes(file.getSize()) + " — larger than the "
                    + humanBytes(effectiveUploadLimit()) + " upload limit"
                    + (media.defaultMode() == VideoStorageMode.DATABASE
                       ? " for database storage. Keep recordings short, raise "
                         + "video.database.max-upload-bytes, or switch to filesystem storage."
                       : "."));
        }
        checkDatabaseBudget(file.getSize());
        String original = sanitiseFilename(file.getOriginalFilename());
        String extension = extensionOf(original);
        if (extension.isEmpty() || !props.getAllowedExtensions().contains(extension)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unsupported video format '" + extension + "'. Allowed: "
                    + String.join(", ", props.getAllowedExtensions().stream().sorted().toList()) + ".");
        }

        String resolvedTitle = (title == null || title.isBlank()) ? stripExtension(original) : title.trim();

        // Save first so the generated id can name the folder on the NAS; storageDir is a
        // placeholder for exactly that one statement.
        Video video = videos.saveAndFlush(new Video(resolvedTitle, description, original,
                file.getContentType(), file.getSize(), "pending", uploadedBy));

        try {
            // Bytes always land on the filesystem first: FFmpeg reads and writes real files, so
            // even DATABASE-mode videos are processed in a working directory and ingested after.
            video.setStorageMode(media.defaultMode());
            video.setStorageDir(storage.createStorageDir(video.getId()));
            String sourceName = "source." + extension;
            Path stored = storage.storeSource(video, file, sourceName);
            video.setSourceRel(sourceName);
            video.setSizeBytes(storage.sizeOf(stored));
            video.setStatus(VideoStatus.PROCESSING);
            video.setProgressPercent(0);
            video.setDeliveryMode(transcoder.toolsAvailable()
                    ? Video.DeliveryMode.HLS
                    : Video.DeliveryMode.PROGRESSIVE);
            video = videos.save(video);
        } catch (IOException | RuntimeException ex) {
            log.error("Failed to store upload for video {}", video.getId(), ex);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "Could not write the upload to " + storage.root() + ": " + ex.getMessage());
        }

        events.publishEvent(new VideoQueuedEvent(video.getId()));
        return video;
    }

    /**
     * The upload ceiling actually in force. Database storage gets its own, much smaller limit: a
     * database is not bulk storage, and the filesystem ceiling (2 GiB by default) would let a single
     * recording swamp it.
     */
    public long effectiveUploadLimit() {
        return media.defaultMode() == VideoStorageMode.DATABASE
                ? Math.min(props.getMaxUploadBytes(), props.getDatabase().getMaxUploadBytes())
                : props.getMaxUploadBytes();
    }

    /**
     * Refuse an upload that clearly will not fit in the remaining database budget.
     *
     * <p>Only an estimate — the stored size isn't known until the transcode finishes — but checking
     * up-front turns "wait five minutes, then fail" into "fail immediately". {@link VideoMediaStore}
     * re-checks against the real total during ingestion, so a bad estimate cannot overfill the
     * database; it only means the rejection comes later.
     */
    private void checkDatabaseBudget(long uploadBytes) {
        if (media.defaultMode() != VideoStorageMode.DATABASE) return;

        long budget = props.getDatabase().getMaxTotalBytes();
        long used = media.storedBytesTotal();
        long estimated = Math.round(uploadBytes * props.getDatabase().getSizeEstimateFactor());
        if (used + estimated <= budget) return;

        throw new ResponseStatusException(HttpStatus.INSUFFICIENT_STORAGE,
                "Not enough database storage: " + humanBytes(used) + " of " + humanBytes(budget)
                + " already used, and this recording needs about " + humanBytes(estimated)
                + " once segmented. Delete an older recording, upload something shorter, or raise "
                + "video.database.max-total-bytes.");
    }

    /** Re-run processing for a video — after a failure, or once ffmpeg becomes available. */
    @Transactional
    public Video reprocess(UUID videoId) {
        Video video = get(videoId);
        // Database storage drops the original by default (video.database.keep-source), so check the
        // bytes are actually still there rather than just that a path was recorded.
        if (video.getSourceRel() == null || !media.exists(video, video.getSourceRel())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "The original file is no longer available, so this video cannot be re-processed."
                    + (video.getStorageMode() == VideoStorageMode.DATABASE
                       ? " Database storage discards the original after segmenting; set "
                         + "video.database.keep-source=true to retain it for future re-processing."
                       : ""));
        }
        // Drop the old ladder: the segment index must never mix runs, or a stale seq would point at
        // a segment file the new transcode has already overwritten with different content.
        video.getRenditions().clear();
        video.setStatus(VideoStatus.PROCESSING);
        video.setProgressPercent(0);
        video.setErrorMessage(null);
        video.setMasterPlaylistRel(null);
        video.setDeliveryMode(transcoder.toolsAvailable()
                ? Video.DeliveryMode.HLS
                : Video.DeliveryMode.PROGRESSIVE);
        Video saved = videos.saveAndFlush(video);
        media.deleteHlsOutput(saved);
        events.publishEvent(new VideoQueuedEvent(videoId));
        return saved;
    }

    @Transactional
    public Video updateMetadata(UUID videoId, String title, String description) {
        Video video = get(videoId);
        if (title != null && !title.isBlank()) video.setTitle(title.trim());
        if (description != null) video.setDescription(description.trim());
        return videos.save(video);
    }

    @Transactional
    public void delete(UUID videoId) {
        Video video = get(videoId);
        media.deleteAll(video);   // database assets and/or the NAS folder
        videos.delete(video);     // cascades to renditions -> segments
    }

    // ---- state transitions used by the transcode worker ----------------------
    // Public and called from another bean so the @Transactional proxy actually applies.

    @Transactional
    public void markProcessing(UUID videoId) {
        videos.findById(videoId).ifPresent(v -> {
            v.setStatus(VideoStatus.PROCESSING);
            v.setErrorMessage(null);
            videos.save(v);
        });
    }

    @Transactional
    public void storeProbe(UUID videoId, MediaInfo info) {
        videos.findById(videoId).ifPresent(v -> {
            v.setDurationSeconds(info.durationSeconds());
            v.setWidth(info.width());
            v.setHeight(info.height());
            v.setFrameRate(info.frameRate());
            v.setHasAudio(info.hasAudio());
            videos.save(v);
        });
    }

    /**
     * Progress ticks arrive several times a second; only whole-percent changes (all the UI shows)
     * are persisted, so a long transcode doesn't turn into a write storm.
     */
    @Transactional
    public void updateProgress(UUID videoId, int percent) {
        videos.findById(videoId).ifPresent(v -> {
            if (v.getProgressPercent() != percent) {
                v.setProgressPercent(percent);
                videos.save(v);
            }
        });
    }

    /** Persist the ladder + the full segment index, and flip the video to READY. */
    @Transactional
    public void storeResult(UUID videoId, TranscodeOutput output, String posterRel, SpriteInfo sprite) {
        Video video = videos.findWithRenditionsById(videoId).orElseThrow();
        video.getRenditions().clear();

        for (RenditionOutput rendition : output.renditions()) {
            VideoRendition entity = new VideoRendition(rendition.name(), rendition.width(),
                    rendition.height(), rendition.videoKbps(), rendition.audioKbps(),
                    rendition.playlistRel());
            for (var segment : rendition.segments()) {
                entity.addSegment(new VideoSegment(segment.seq(), segment.filename(),
                        segment.durationSeconds(), segment.startSeconds(), segment.byteSize()));
            }
            video.addRendition(entity);
        }

        video.setMasterPlaylistRel(output.masterPlaylistRel());
        video.setPosterRel(posterRel);
        if (sprite != null) {
            video.setSpriteRel(sprite.relativePath());
            video.setSpriteIntervalSeconds(sprite.intervalSeconds());
            video.setSpriteColumns(sprite.columns());
            video.setSpriteTileWidth(sprite.tileWidth());
            video.setSpriteTileHeight(sprite.tileHeight());
        }
        video.setSegmentSeconds(props.getHls().getSegmentSeconds());
        video.setDeliveryMode(Video.DeliveryMode.HLS);
        video.setProgressPercent(100);
        video.setStatus(VideoStatus.READY);
        video.setErrorMessage(null);
        videos.save(video);
    }

    /** ffmpeg-free path: mark the original playable via HTTP Range instead of HLS. */
    @Transactional
    public void completeProgressive(UUID videoId) {
        videos.findById(videoId).ifPresent(v -> {
            v.setDeliveryMode(Video.DeliveryMode.PROGRESSIVE);
            v.setStatus(VideoStatus.READY);
            v.setProgressPercent(100);
            v.setErrorMessage("FFmpeg is not installed, so this video was not split into an adaptive "
                    + "ladder. It streams over HTTP Range requests instead — playback and seeking "
                    + "work, but there is no quality switching. Install FFmpeg and use Re-process "
                    + "to segment it.");
            videos.save(v);
        });
    }

    @Transactional
    public void markFailed(UUID videoId, String message) {
        videos.findById(videoId).ifPresent(v -> {
            v.setStatus(VideoStatus.FAILED);
            v.setErrorMessage(message == null ? "Processing failed." : message);
            videos.save(v);
        });
    }

    // ---- helpers -------------------------------------------------------------

    /** Keep only the base name: an upload must never be able to steer where it lands. */
    private String sanitiseFilename(String name) {
        if (name == null || name.isBlank()) return "upload";
        String base = name.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) base = base.substring(slash + 1);
        return base.replaceAll("\\p{Cntrl}", "").trim();
    }

    private String extensionOf(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot < 0 ? "" : filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private String stripExtension(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot <= 0 ? filename : filename.substring(0, dot);
    }

    public static String humanBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        String[] units = {"KB", "MB", "GB", "TB"};
        double value = bytes / 1024.0;
        int unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }
        return String.format(Locale.ROOT, "%.1f %s", value, units[unit]);
    }
}
