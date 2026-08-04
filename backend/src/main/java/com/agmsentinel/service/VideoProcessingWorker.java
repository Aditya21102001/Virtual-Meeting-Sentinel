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
 *
 * <p>Persisting is incremental rather than a single pass at the end — see
 * {@link VideoSegmentDrainer}. That is what keeps the resident cost of a transcode independent of
 * how long the recording is, which is the difference between a small host segmenting an hour-long
 * upload and being killed part-way through one.
 */
@Component
public class VideoProcessingWorker {

    private static final Logger log = LoggerFactory.getLogger(VideoProcessingWorker.class);

    private final VideoRepository videos;
    private final VideoLibraryService library;
    private final VideoStorageService storage;
    private final VideoMediaStore media;
    private final VideoTranscodeService transcoder;
    private final VideoSegmentDrainer drainer;
    private final VideoProperties props;
    private final AiClient ai;

    public VideoProcessingWorker(VideoRepository videos,
                                 VideoLibraryService library,
                                 VideoStorageService storage,
                                 VideoMediaStore media,
                                 VideoTranscodeService transcoder,
                                 VideoSegmentDrainer drainer,
                                 VideoProperties props,
                                 AiClient ai) {
        this.videos = videos;
        this.library = library;
        this.storage = storage;
        this.media = media;
        this.transcoder = transcoder;
        this.drainer = drainer;
        this.props = props;
        this.ai = ai;
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

            TranscodeOutput output;
            // Segments move into the database as ffmpeg finishes them, so neither heap nor disk
            // has to hold the whole ladder at once. Without this the cost of a transcode scales
            // with the length of the recording and a long one kills a small container outright.
            try (VideoSegmentDrainer.Drain drain = drainer.start(video, videoDir)) {
                output = transcoder.transcodeToHls(videoDir, source, info,
                        percent -> {
                            // Surfaces a drain that has run out of storage budget, which aborts
                            // the encode here rather than an hour later.
                            drain.raiseIfFailed();
                            library.updateProgress(videoId, percent);
                        },
                        drain::sizeOf);

                // Poster and filmstrip are cosmetic — a failure in either must not fail the video,
                // so both return null rather than throwing.
                String poster = transcoder.renderPoster(videoDir, source, info);
                SpriteInfo sprite = transcoder.renderSprite(videoDir, source, info);

                // Sweep up the segments produced since the last sweep, then persist what the drain
                // deliberately left behind: the playlists (ffmpeg rewrites them until the very end)
                // plus the poster and sprite. All small, all read in one pass.
                drain.finish();

                // Persist BEFORE marking READY: a client must never be told a video is playable
                // while its bytes still live only in a directory that is about to be deleted.
                media.ingest(video, videoDir, skipList(video));
                library.storeResult(videoId, output, poster, sprite);
            }

            // After READY, and before the working directory goes: captions need the source audio,
            // and in database mode this directory is about to be deleted. Doing it here rather than
            // earlier means the recording is already playable while this runs.
            maybeGenerateTranscript(video, videoDir, source, info);

            discardWorkingDir(video, videoDir);

            log.info("Video {} ready — {} rendition(s), {} segment(s) indexed", videoId,
                     output.renditions().size(),
                     output.renditions().stream().mapToInt(r -> r.segments().size()).sum());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            log.warn("Transcode of {} was interrupted", videoId);
            discardPartialOutput(video);
            library.markFailed(videoId, "Processing was interrupted (server shutting down?).");
        } catch (Exception ex) {
            log.error("Transcode failed for video {}", videoId, ex);
            discardPartialOutput(video);
            library.markFailed(videoId, ex.getMessage());
        }
    }

    /**
     * Drop the half-written ladder of a transcode that did not finish.
     *
     * <p>Only needed since segments started being persisted as they are produced: a run that dies
     * at 80% now leaves 80% of a ladder in {@code video_assets} that nothing indexes and nothing
     * can play, because the segment index and the READY flip happen together at the very end. Left
     * alone those rows would sit against the storage budget forever and, on a small database,
     * a couple of failed uploads would be enough to start refusing good ones.
     *
     * <p>Safe precisely because the index is written last: if we are here, no {@code VideoSegment}
     * row references any of this. The original upload is untouched, so Re-process still works.
     */
    private void discardPartialOutput(Video video) {
        if (video.getStorageMode() != VideoStorageMode.DATABASE) return;
        try {
            media.deleteHlsOutput(video);
        } catch (RuntimeException ex) {
            // Best-effort: the video is already failing, and a cleanup error must not replace the
            // real reason with a misleading one.
            log.warn("Could not clear partial output for video {}: {}", video.getId(), ex.getMessage());
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
    /**
     * Generate captions for a recording that has none, if automatic transcription is turned on.
     *
     * <p>Runs after the video is already {@code READY}, so nothing here can delay playback — and
     * nothing here is allowed to fail the recording either. Every outcome short of success is a
     * logged warning: the video plays perfectly without captions, and a moderator can always upload
     * a {@code .vtt} or press <em>Index for answers</em> later.
     *
     * <p>Off by default. Extraction is cheap next to a transcode (no video encoder is created) but it
     * is still another FFmpeg process, and on a host that barely fits one that is not free.
     */
    private void maybeGenerateTranscript(Video video, Path videoDir, Path source,
                                         MediaInfo info) {
        VideoProperties.Transcript config = props.getTranscript();
        if (!config.isAutoGenerate()) return;
        if (video.getTranscriptRel() != null) {
            log.debug("Video {} already has a transcript — not generating one.", video.getId());
            return;
        }
        // From the probe, not from the entity: this instance was loaded before storeProbe ran, so
        // its hasAudio still holds the column default (true) rather than what the file contains.
        if (!info.hasAudio()) {
            log.info("Video {} has no audio track, so there is nothing to transcribe.", video.getId());
            return;
        }

        Path audio = null;
        try {
            audio = transcoder.extractAudio(videoDir, source, config.getAudioBitrateKbps());
            if (audio == null) return;   // already logged by extractAudio

            long bytes = Files.size(audio);
            if (bytes > config.getMaxAudioBytes()) {
                // Refused here rather than by the provider, so the reason is actionable.
                log.warn("Skipping automatic captions for video {}: the extracted audio is {} bytes, "
                         + "over the {} byte limit. Lower video.transcript.audio-bitrate-kbps, or "
                         + "upload a transcript for this recording.",
                         video.getId(), bytes, config.getMaxAudioBytes());
                return;
            }

            String webVtt = ai.transcribeAudio(audio.getFileName().toString(), Files.readAllBytes(audio));
            if (webVtt == null || webVtt.isBlank()) {
                log.warn("Transcription returned nothing for video {}.", video.getId());
                return;
            }
            library.saveTranscript(video.getId(), webVtt);
            log.info("Generated captions for video {} ({} characters).", video.getId(), webVtt.length());

            // Index straight away: the point of having a transcript here is that an answer can cite
            // what was said. Separately guarded — a knowledge-base failure must not discard captions
            // that were successfully produced and saved.
            try {
                ai.indexTranscript(video.getId().toString(), video.getTitle(), webVtt);
            } catch (RuntimeException ex) {
                log.warn("Saved generated captions for video {} but could not index them: {}. "
                         + "Use Index for answers to retry.", video.getId(), ex.getMessage());
            }
        } catch (Exception ex) {
            log.warn("Automatic captions failed for video {}: {}", video.getId(), ex.getMessage());
        } finally {
            // The extracted audio is scratch. In filesystem mode the directory persists, so leaving
            // it would quietly grow the share by a copy of every recording's soundtrack.
            if (audio != null) {
                try {
                    Files.deleteIfExists(audio);
                } catch (IOException ignored) {
                    // Removed with the working directory in database mode; harmless in filesystem mode.
                }
            }
        }
    }

    private void discardWorkingDir(Video video, Path videoDir) {
        if (video.getStorageMode() != VideoStorageMode.DATABASE) return;
        storage.deleteVideoDir(video);
        log.debug("Discarded working directory {} for video {}", videoDir, video.getId());
    }
}
