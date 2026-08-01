package com.agmsentinel.service;

import com.agmsentinel.config.VideoProperties;
import com.agmsentinel.model.Video;
import com.agmsentinel.model.VideoStorageMode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

/**
 * Moves finished HLS segments off the working disk and into {@code video_assets} <em>while ffmpeg
 * is still encoding</em>, instead of waiting for the whole ladder and ingesting it in one go.
 *
 * <h2>Why this exists</h2>
 * The original flow transcoded everything, then walked the output directory and called
 * {@code Files.readAllBytes} on every file inside a single transaction. That is fine for a two
 * minute clip and fatal for a long one: an hour of video at 6 s segments across four rungs is a few
 * thousand files, and every one of them stays in heap as a {@code byte[]} on a managed entity until
 * the transaction commits — twice over, because Hibernate keeps a snapshot of each loaded blob for
 * dirty checking. On a 512 MB free-tier container the JVM is killed long before the commit, which
 * is exactly the "works for small videos, dies on big ones" symptom. The whole ladder also had to
 * fit on the container's ephemeral disk at once, on top of the source.
 *
 * <p>Draining as we go bounds both: peak heap is one segment, and peak disk is the handful of
 * segments ffmpeg has produced since the last sweep. Neither grows with the length of the
 * recording, so a three-hour upload costs the same resident memory as a three-minute one — it just
 * takes longer.
 *
 * <p>The other benefit is durability. Each segment lands in its own committed transaction, so a
 * container restart at 90% no longer throws away 90% of the work: the rows are already there and a
 * re-process overwrites them by path rather than starting from an empty table.
 *
 * <p>Only meaningful in {@link VideoStorageMode#DATABASE}. In filesystem mode the files on disk
 * <em>are</em> the storage, so {@link #start} hands back a drain that does nothing.
 *
 * @see VideoMediaStore#ingest for the tail end — playlists, poster and sprite, which are small,
 *      rewritten until the last moment, and therefore still persisted in one pass at the end
 */
@Service
public class VideoSegmentDrainer {

    private static final Logger log = LoggerFactory.getLogger(VideoSegmentDrainer.class);

    private final VideoMediaStore media;
    private final VideoProperties props;

    public VideoSegmentDrainer(VideoMediaStore media, VideoProperties props) {
        this.media = media;
        this.props = props;
    }

    /**
     * Begin draining {@code workingDir} in the background. Always returns a usable handle; close it
     * when the transcode finishes (or fails) to stop the sweeper and flush what is left.
     */
    public Drain start(Video video, Path workingDir) {
        boolean active = video.getStorageMode() == VideoStorageMode.DATABASE
                         && props.getDatabase().isDrainSegments();
        Drain drain = new Drain(video, workingDir, active);
        if (active) drain.startSweeping();
        return drain;
    }

    /**
     * A running drain. Sweeps on its own thread; every public method is safe to call from the
     * transcode thread while it does.
     */
    public final class Drain implements AutoCloseable {

        private final Video video;
        private final Path workingDir;
        private final Path hlsDir;
        private final boolean active;

        /** Byte size of every segment already moved, keyed by relative path. */
        private final Map<String, Long> drained = new ConcurrentHashMap<>();
        private final AtomicLong drainedBytes = new AtomicLong();
        /** First budget/IO failure seen by the sweeper, re-thrown on the transcode thread. */
        private final AtomicReference<RuntimeException> failure = new AtomicReference<>();

        private final long budget;
        private final long maxAssetBytes;
        /** Bytes other videos already occupy — fixed for the run, so no repeated sum queries. */
        private final long usedElsewhere;

        private ScheduledExecutorService sweeper;

        private Drain(Video video, Path workingDir, boolean active) {
            this.video = video;
            this.workingDir = workingDir;
            this.hlsDir = workingDir.resolve(VideoTranscodeService.HLS_DIR);
            this.active = active;
            this.budget = props.getDatabase().getMaxTotalBytes();
            this.maxAssetBytes = props.getDatabase().getMaxAssetBytes();
            // Measured once. A re-process overwrites this video's own rows rather than adding to
            // them, so its existing usage must not count against it.
            this.usedElsewhere = active
                    ? Math.max(0, media.storedBytesTotal() - media.storedBytes(video))
                    : 0;
        }

        private void startSweeping() {
            long period = Math.max(1, props.getDatabase().getDrainSweepSeconds());
            sweeper = Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "video-drain-" + video.getId());
                thread.setDaemon(true);
                return thread;
            });
            sweeper.scheduleWithFixedDelay(this::sweepQuietly, period, period, TimeUnit.SECONDS);
            log.info("Draining segments for video {} into database storage every {}s "
                     + "(budget {} , {} already used by other videos)",
                     video.getId(), period, VideoLibraryService.humanBytes(budget),
                     VideoLibraryService.humanBytes(usedElsewhere));
        }

        /**
         * Size of a segment this drain has already moved, or -1 if it never saw it.
         *
         * <p>The segment index is built by reading ffmpeg's playlists back and stat-ing each
         * segment file — which no longer exists once it has been drained. Without this the index
         * would record every segment as zero bytes.
         */
        public long sizeOf(String relPath) {
            Long bytes = drained.get(relPath);
            return bytes == null ? -1 : bytes;
        }

        public long drainedBytes() {
            return drainedBytes.get();
        }

        /**
         * Re-throw anything the sweeper hit, on the caller's thread.
         *
         * <p>Called from the progress callback so a blown storage budget stops the encode within a
         * second or two, rather than after another hour of work that cannot be stored anyway.
         */
        public void raiseIfFailed() {
            RuntimeException ex = failure.get();
            if (ex != null) throw ex;
        }

        /**
         * Move everything still on disk, including the segment ffmpeg was mid-write on when the
         * last sweep ran. Call once the encoder has exited and the playlists have been read.
         */
        public void finish() {
            if (!active) return;
            stopSweeping();
            sweep(true);
            raiseIfFailed();
            log.info("Video {}: drained {} segment(s), {} into database storage during transcode",
                     video.getId(), drained.size(),
                     VideoLibraryService.humanBytes(drainedBytes.get()));
        }

        /** Idempotent, and never throws — {@link #finish} is where failures surface. */
        @Override
        public void close() {
            stopSweeping();
        }

        private void stopSweeping() {
            ScheduledExecutorService running = sweeper;
            sweeper = null;
            if (running == null) return;
            running.shutdownNow();
            try {
                running.awaitTermination(30, TimeUnit.SECONDS);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
        }

        // ---- sweeping --------------------------------------------------------

        private void sweepQuietly() {
            try {
                sweep(false);
            } catch (RuntimeException ex) {
                // Recorded rather than thrown: this runs on the scheduler, where an escaping
                // exception silently cancels all further sweeps and nothing would ever notice.
                failure.compareAndSet(null, ex);
            }
        }

        /**
         * @param last true once ffmpeg has exited, so the newest segment in each rung is safe to
         *             take as well
         */
        private void sweep(boolean last) {
            if (!active || !Files.isDirectory(hlsDir)) return;
            for (Path rungDir : rungDirectories()) {
                List<Path> segments = completedSegments(rungDir, last);
                for (Path segment : segments) {
                    if (!last && Thread.currentThread().isInterrupted()) return;
                    store(segment);
                }
            }
        }

        private List<Path> rungDirectories() {
            try (Stream<Path> entries = Files.list(hlsDir)) {
                return entries.filter(Files::isDirectory).sorted().toList();
            } catch (IOException ex) {
                return List.of();
            }
        }

        /**
         * Segments in this rung that ffmpeg has definitely finished writing.
         *
         * <p>Two independent guarantees, because a half-written segment stored as if it were whole
         * produces a video that plays up to that point and then stalls — the worst possible failure
         * mode, since nothing reports an error. First, {@code -hls_flags temp_file} makes ffmpeg
         * write to {@code seg_00042.ts.tmp} and rename only on completion, so a visible
         * {@code .ts} is already final. Second, mid-run we still hold back the highest-numbered
         * file, which costs one segment of disk and covers the case of an ffmpeg build that ignores
         * the flag. The final sweep takes everything, by which point the encoder has exited.
         */
        private List<Path> completedSegments(Path rungDir, boolean last) {
            List<Path> segments = new ArrayList<>();
            try (Stream<Path> entries = Files.list(rungDir)) {
                entries.filter(Files::isRegularFile)
                       .filter(p -> p.getFileName().toString().endsWith(".ts"))
                       .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                       .forEach(segments::add);
            } catch (IOException ex) {
                return List.of();
            }
            if (segments.isEmpty()) return segments;
            return last ? segments : segments.subList(0, segments.size() - 1);
        }

        /** Persist one segment in its own transaction, then reclaim its disk space. */
        private void store(Path segment) {
            String rel = relativePath(segment);
            if (drained.containsKey(rel)) return;

            long bytes;
            try {
                bytes = Files.size(segment);
            } catch (IOException ex) {
                return;   // vanished between listing and reading; nothing to do
            }
            if (bytes <= 0) return;

            if (bytes > maxAssetBytes) {
                throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                        "Segment '" + rel + "' is " + VideoLibraryService.humanBytes(bytes)
                        + ", over the " + VideoLibraryService.humanBytes(maxAssetBytes)
                        + " per-file limit for database storage. Lower video.hls.segment-seconds "
                        + "or raise video.database.max-asset-bytes.");
            }
            long total = usedElsewhere + drainedBytes.get() + bytes;
            if (total > budget) {
                throw new ResponseStatusException(HttpStatus.INSUFFICIENT_STORAGE,
                        "Ran out of database storage part-way through this recording: it needs more "
                        + "than the " + VideoLibraryService.humanBytes(budget) + " total budget "
                        + "allows (" + VideoLibraryService.humanBytes(usedElsewhere)
                        + " already used by other videos). Delete an older recording, upload "
                        + "something shorter, or raise video.database.max-total-bytes.");
            }

            byte[] data;
            try {
                data = Files.readAllBytes(segment);
            } catch (IOException ex) {
                return;   // as above — a missing file is not a failure of the transcode
            }
            media.put(video, rel, data, "video/mp2t");
            drained.put(rel, bytes);
            drainedBytes.addAndGet(bytes);

            try {
                Files.deleteIfExists(segment);
            } catch (IOException ex) {
                // Reclaiming the space is the whole point, but the bytes are safely stored either
                // way and the working directory is deleted wholesale at the end.
                log.debug("Could not delete drained segment {}: {}", segment, ex.getMessage());
            }
        }

        /** {@code hls/720p/seg_00042.ts} — the same addressing both storage backends use. */
        private String relativePath(Path file) {
            return workingDir.relativize(file).toString().replace('\\', '/');
        }
    }
}
