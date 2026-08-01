package com.agmsentinel.service;

import com.agmsentinel.config.VideoProperties;
import com.agmsentinel.model.Video;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.Channels;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.*;
import java.util.Comparator;
import java.util.UUID;

/**
 * Owns the NAS share: where a video's folder is, how bytes get written there, and — most
 * importantly — the single place that turns a client-supplied relative path into a real file.
 *
 * <p>Every media URL the browser requests carries a relative path
 * ({@code hls/720p/seg_00042.ts}), so this class is the security boundary for path traversal:
 * {@link #resolveWithin} normalises the candidate and refuses anything that escapes the video's
 * own folder. Nothing else in the codebase is allowed to build a media path.
 */
@Service
public class VideoStorageService {

    private static final Logger log = LoggerFactory.getLogger(VideoStorageService.class);

    private final VideoProperties props;

    /** The resolved root actually in use — the NAS path, or the fallback if the NAS is absent. */
    private Path root;
    private boolean usingFallback;
    private String storageProblem;

    public VideoStorageService(VideoProperties props) {
        this.props = props;
    }

    @PostConstruct
    void initialise() {
        Path configured = Paths.get(props.getNasPath()).toAbsolutePath().normalize();
        try {
            Files.createDirectories(configured);
            // Creating the directory can succeed on a stale mount that then rejects writes, so
            // prove the share is actually writable before declaring it healthy.
            Path probe = Files.createTempFile(configured, ".nas-probe", ".tmp");
            Files.deleteIfExists(probe);
            this.root = configured;
            this.usingFallback = false;
            log.info("Video storage ready on NAS path {}", configured);
            return;
        } catch (IOException | RuntimeException ex) {
            this.storageProblem = ex.getMessage();
            if (props.isRequireNas()) {
                throw new IllegalStateException(
                        "NAS video path is not writable: " + configured + " (" + ex.getMessage()
                        + "). Set VIDEO_NAS_PATH correctly, or video.require-nas=false to allow "
                        + "the local fallback.", ex);
            }
        }

        Path fallback = Paths.get(props.getFallbackPath()).toAbsolutePath().normalize();
        try {
            Files.createDirectories(fallback);
        } catch (IOException ex) {
            throw new IllegalStateException("Neither the NAS path (" + configured
                    + ") nor the fallback path (" + fallback + ") is usable for video storage.", ex);
        }
        this.root = fallback;
        this.usingFallback = true;
        log.warn("NAS path {} unavailable ({}). Falling back to local storage at {} — set "
                 + "VIDEO_NAS_PATH to the share before production use.",
                 configured, storageProblem, fallback);
    }

    public Path root() {
        return root;
    }

    public boolean isUsingFallback() {
        return usingFallback;
    }

    /** Why the NAS was rejected, for the admin status panel. Null when the NAS is in use. */
    public String storageProblem() {
        return usingFallback ? storageProblem : null;
    }

    public String configuredNasPath() {
        return Paths.get(props.getNasPath()).toAbsolutePath().normalize().toString();
    }

    /** Free space on the share, or -1 if it can't be read. */
    public long usableSpaceBytes() {
        try {
            return Files.getFileStore(root).getUsableSpace();
        } catch (IOException ex) {
            return -1;
        }
    }

    // ---- per-video layout ----------------------------------------------------

    /**
     * Creates the folder for a new video. The id is the folder name, so two uploads of the same
     * filename never collide and a folder is trivially traceable back to its DB row.
     */
    public String createStorageDir(UUID videoId) throws IOException {
        String dirName = videoId.toString();
        Files.createDirectories(root.resolve(dirName));
        return dirName;
    }

    public Path videoDir(Video video) {
        return resolveWithin(root, video.getStorageDir());
    }

    /** Resolve a path relative to a video's own folder, rejecting traversal. */
    public Path resolveMedia(Video video, String relativePath) {
        return resolveWithin(videoDir(video), relativePath);
    }

    /**
     * Normalise {@code candidate} under {@code base} and fail if it escapes. Backslashes are
     * folded to '/' first because a Windows client may send either separator, and a bare
     * {@code Path.resolve} of {@code "..\\..\\secrets"} would otherwise land outside the share.
     */
    public Path resolveWithin(Path base, String candidate) {
        if (candidate == null || candidate.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Missing media path.");
        }
        String cleaned = candidate.replace('\\', '/');
        if (cleaned.startsWith("/")) {
            cleaned = cleaned.substring(1);
        }
        Path resolved = base.resolve(cleaned).normalize();
        if (!resolved.startsWith(base.normalize())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Invalid media path.");
        }
        return resolved;
    }

    // ---- writing / reading ---------------------------------------------------

    /**
     * Stream the upload straight to the NAS. {@code transferTo} hands off to the servlet
     * container's already-spooled temp file where possible, so a 2 GB upload never has to be
     * held in the JVM heap.
     */
    public Path storeSource(Video video, MultipartFile file, String filename) throws IOException {
        Path target = resolveMedia(video, filename);
        Files.createDirectories(target.getParent());
        try (InputStream in = file.getInputStream()) {
            Files.copy(in, target, StandardCopyOption.REPLACE_EXISTING);
        }
        return target;
    }

    public long sizeOf(Path path) {
        try {
            return Files.size(path);
        } catch (IOException ex) {
            return 0L;
        }
    }

    /**
     * Open exactly {@code length} bytes starting at {@code start} — the read behind a 206 response.
     *
     * <p>Seeking with a channel rather than reading and discarding means a request for the bytes
     * around the 50-minute mark touches only those bytes: the cost of serving a range is the size
     * of the range, not the offset into the file. The stream is bounded so a caller can never read
     * past the range it asked for.
     */
    public InputStream openRange(Path file, long start, long length) throws IOException {
        SeekableByteChannel channel = Files.newByteChannel(file, StandardOpenOption.READ);
        try {
            channel.position(start);
        } catch (IOException | RuntimeException ex) {
            channel.close();
            throw ex;
        }
        return new BoundedInputStream(Channels.newInputStream(channel), length);
    }

    /**
     * Caps an underlying stream at a byte count. The JDK has no such wrapper, and without one the
     * response body would run to the end of the file and contradict its own Content-Length.
     */
    private static final class BoundedInputStream extends FilterInputStream {
        private long remaining;

        private BoundedInputStream(InputStream in, long limit) {
            super(in);
            this.remaining = limit;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int value = super.read();
            if (value >= 0) remaining--;
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (remaining <= 0) return -1;
            int read = super.read(buffer, offset, (int) Math.min(length, remaining));
            if (read > 0) remaining -= read;
            return read;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min(super.available(), remaining);
        }
    }

    /** Delete a video's whole folder (source, manifests, every segment). Best-effort. */
    public void deleteVideoDir(Video video) {
        Path dir = videoDir(video);
        if (!Files.exists(dir)) return;
        try (var walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ex) {
                    log.warn("Could not delete {}: {}", p, ex.getMessage());
                }
            });
        } catch (IOException ex) {
            log.warn("Could not clean up video folder {}: {}", dir, ex.getMessage());
        }
    }

    /** Wipe just the transcode output, keeping the source, so a video can be re-processed. */
    public void deleteHlsOutput(Video video) {
        Path hls = resolveMedia(video, VideoTranscodeService.HLS_DIR);
        if (!Files.exists(hls)) return;
        try (var walk = Files.walk(hls)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // A locked segment just gets overwritten by the next transcode.
                }
            });
        } catch (IOException ex) {
            log.warn("Could not clean HLS output for {}: {}", video.getId(), ex.getMessage());
        }
    }
}
