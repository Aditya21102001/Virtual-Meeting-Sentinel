package com.agmsentinel.service;

import com.agmsentinel.config.VideoAsyncConfig;
import com.agmsentinel.config.VideoProperties;
import com.agmsentinel.model.Video;
import com.agmsentinel.model.VideoStorageMode;
import com.agmsentinel.repository.VideoRepository;
import com.agmsentinel.service.VideoLibraryService.VideoQueuedEvent;
import com.agmsentinel.service.VideoTranscodeService.MediaInfo;
import com.agmsentinel.service.VideoTranscodeService.SpriteInfo;
import com.agmsentinel.service.VideoTranscodeService.TranscodeOutput;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;

/**
 * Runs the actual transcode, off the request thread.
 *
 * <p>Deliberately a separate bean from {@link VideoLibraryService}: {@code @Async} and
 * {@code @Transactional} are proxy-based, so a service calling its own annotated method would get
 * neither — the "async" transcode would run inline on the HTTP thread and each "transaction" would
 * silently join the caller's. Crossing a bean boundary is what makes both annotations real.
 *
 * <p>{@code @TransactionalEventListener(AFTER_COMMIT)} matters too: the worker must not start until
 * the upload's row and its {@code storageDir} are committed, or it would look up a video that isn't
 * visible to its own connection yet.
 *
 * <p>FFmpeg reads and writes real files, so work always happens in the video's filesystem
 * directory regardless of {@link VideoStorageMode}. In {@code DATABASE} mode that directory is a
 * <em>working</em> directory: its contents are persisted to the database and it is then deleted, so
 * the host's disk is free to be ephemeral.
 */
@Component
public class VideoProcessingWorker {

    private static final Logger log = LoggerFactory.getLogger(VideoProcessingWorker.class);

    private final VideoRepository videos;
    private final VideoLibraryService library;
    private final VideoStorageService storage;
    private final VideoMediaStore media;
    private final VideoTranscodeService transcoder;
    private final VideoProperties props;

    public VideoProcessingWorker(VideoRepository videos,
                                 VideoLibraryService library,
                                 VideoStorageService storage,
                                 VideoMediaStore media,
                                 VideoTranscodeService transcoder,
                                 VideoProperties props) {
        this.videos = videos;
        this.library = library;
        this.storage = storage;
        this.media = media;
        this.transcoder = transcoder;
        this.props = props;
    }

    /** fallbackExecution: also process when queued outside a transaction (e.g. from a test). */
    @Async(VideoAsyncConfig.EXECUTOR)
    @TransactionalEventListener(fallbackExecution = true)
    public void onVideoQueued(VideoQueuedEvent event) {
        process(event.videoId());
    }

    /**
     * Clear out transcodes that died with the previous process.
     *
     * <p>Nothing survives a container restart: the {@code @Async} pool and the ffmpeg subprocess go
     * with it, and a row left in {@code PROCESSING} has no owner any more. Without this it stays
     * that way permanently — the admin screen polls a percentage that will never move and the
     * recording never reaches the member library. Running at {@code ApplicationReadyEvent} means it
     * happens once per boot, before anyone can look at a stale row.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void recoverInterruptedOnStartup() {
        int recovered = library.recoverInterrupted();
        if (recovered > 0) {
            log.warn("Marked {} interrupted video transcode(s) as FAILED at startup.", recovered);
        }
        // Same class of problem, different cause: the transcode above died with the process,
        // whereas these rows outlived their files entirely. Both leave the catalogue describing
        // something that no longer exists, and both are only detectable at boot.
        int missing = library.flagMissingMedia();
        if (missing > 0) {
            log.error("{} recording(s) have no media left in storage. This host is not keeping "
                      + "files across restarts — mount a persistent volume, or set "
                      + "VIDEO_STORAGE_MODE=database to store media in the database instead.",
                      missing);
        }
    }

    void process(UUID videoId) {
        Video video = videos.findWithRenditionsById(videoId).orElse(null);
        if (video == null) {
            log.warn("Transcode requested for unknown video {}", videoId);
            return;
        }
        Path videoDir = storage.videoDir(video);

        try {
            Path source = prepareSource(video);
            library.markProcessing(videoId);

            if (!transcoder.toolsAvailable()) {
                // No ffmpeg: keep the original and serve it over HTTP Range. Playback and seeking
                // still work; there is simply no adaptive ladder to switch between. The source is
                // the only thing there is to play, so it is persisted even in database mode —
                // hence no skip list here.
                log.warn("Video {} stored without segmentation — ffmpeg unavailable.", videoId);
                media.ingest(video, videoDir, List.of());
                library.completeProgressive(videoId);
                discardWorkingDir(video, videoDir);
                return;
            }

            MediaInfo info = transcoder.probe(source);
            log.info("Probed {}: {}x{}, {}s @ {}fps, audio={}", video.getOriginalFilename(),
                     info.width(), info.height(), Math.round(info.durationSeconds()),
                     Math.round(info.frameRate()), info.hasAudio());
            library.storeProbe(videoId, info);

            TranscodeOutput output = transcoder.transcodeToHls(
                    videoDir, source, info, percent -> library.updateProgress(videoId, percent));

            // Poster and filmstrip are cosmetic — a failure in either must not fail the video, so
            // both return null rather than throwing.
            String poster = transcoder.renderPoster(videoDir, source, info);
            SpriteInfo sprite = transcoder.renderSprite(videoDir, source, info);

            // Persist BEFORE marking READY: a client must never be told a video is playable while
            // its bytes still live only in a directory that is about to be deleted.
            media.ingest(video, videoDir, skipList(video));
            library.storeResult(videoId, output, poster, sprite);
            discardWorkingDir(video, videoDir);

            log.info("Video {} ready — {} rendition(s), {} segment(s) indexed", videoId,
                     output.renditions().size(),
                     output.renditions().stream().mapToInt(r -> r.segments().size()).sum());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            log.warn("Transcode of {} was interrupted", videoId);
            library.markFailed(videoId, "Processing was interrupted (server shutting down?).");
        } catch (Exception ex) {
            log.error("Transcode failed for video {}", videoId, ex);
            library.markFailed(videoId, ex.getMessage());
        }
    }

    /**
     * Guarantee the original is on disk for FFmpeg to read.
     *
     * <p>In database mode the working directory was deleted after the first run, so a re-process has
     * to write the stored original back out first. Without this, re-processing a database-backed
     * video would fail on a missing file even though the bytes are safely in the database.
     */
    private Path prepareSource(Video video) throws IOException {
        if (video.getSourceRel() == null) {
            throw new IOException("This video has no stored original to process.");
        }
        Path source = storage.resolveMedia(video, video.getSourceRel());
        if (Files.exists(source)) return source;

        if (video.getStorageMode() == VideoStorageMode.DATABASE
                && media.exists(video, video.getSourceRel())) {
            log.info("Restoring source for video {} from database storage", video.getId());
            return media.materialise(video, video.getSourceRel(), source);
        }
        throw new IOException("Source file is missing from storage: " + source);
    }

    /**
     * Paths not worth persisting. The original is only needed to re-process, and it is far larger
     * than every segment combined — so by default it is dropped rather than doubling database usage.
     */
    private List<String> skipList(Video video) {
        if (video.getStorageMode() != VideoStorageMode.DATABASE) return List.of();
        if (props.getDatabase().isKeepSource()) return List.of();
        return List.of(video.getSourceRel());
    }

    /**
     * In database mode the directory was scratch space and its contents are now safely stored, so
     * remove it. In filesystem mode that same directory <em>is</em> the storage — deleting it would
     * destroy the recording, which is why this checks the mode rather than always cleaning up.
     */
    private void discardWorkingDir(Video video, Path videoDir) {
        if (video.getStorageMode() != VideoStorageMode.DATABASE) return;
        storage.deleteVideoDir(video);
        log.debug("Discarded working directory {} for video {}", videoDir, video.getId());
    }
}
