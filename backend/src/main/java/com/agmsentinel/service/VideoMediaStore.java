package com.agmsentinel.service;

import com.agmsentinel.config.VideoProperties;
import com.agmsentinel.model.Video;
import com.agmsentinel.model.VideoAsset;
import com.agmsentinel.model.VideoStorageMode;
import com.agmsentinel.repository.VideoAssetRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.InputStreamResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;

/**
 * Reads and writes a video's media, whichever backend holds it.
 *
 * <p>Every caller addresses media as {@code (video, relative path)} — {@code hls/720p/seg_00042.ts},
 * {@code poster.jpg} — and this class answers from either the filesystem or the {@code video_assets}
 * table according to {@link Video#getStorageMode()}. Nothing upstream branches on the backend.
 *
 * <p>The mode is stored per video, so flipping the server default cannot strand recordings written
 * the other way: an old filesystem video keeps being served from the filesystem.
 *
 * @see VideoStorageMode for why database storage exists at all
 */
@Service
public class VideoMediaStore {

    private static final Logger log = LoggerFactory.getLogger(VideoMediaStore.class);

    private final VideoStorageService filesystem;
    private final VideoAssetRepository assets;
    private final VideoProperties props;

    public VideoMediaStore(VideoStorageService filesystem,
                           VideoAssetRepository assets,
                           VideoProperties props) {
        this.filesystem = filesystem;
        this.assets = assets;
        this.props = props;
    }

    /** The mode new uploads will use. */
    public VideoStorageMode defaultMode() {
        return props.getStorageMode();
    }

    private boolean inDatabase(Video video) {
        return video.getStorageMode() == VideoStorageMode.DATABASE;
    }

    // ---- reading -------------------------------------------------------------

    @Transactional(readOnly = true)
    public boolean exists(Video video, String relPath) {
        if (inDatabase(video)) {
            return assets.findSize(video.getId(), normalise(relPath)).isPresent();
        }
        return Files.isRegularFile(filesystem.resolveMedia(video, relPath));
    }

    @Transactional(readOnly = true)
    public long size(Video video, String relPath) {
        if (inDatabase(video)) {
            return assets.findSize(video.getId(), normalise(relPath)).orElse(0L);
        }
        return filesystem.sizeOf(filesystem.resolveMedia(video, relPath));
    }

    /** Manifests are text and small; read them whole regardless of backend. */
    @Transactional(readOnly = true)
    public String readText(Video video, String relPath) {
        if (inDatabase(video)) {
            return new String(requireAsset(video, relPath).getData(), StandardCharsets.UTF_8);
        }
        try {
            return Files.readString(filesystem.resolveMedia(video, relPath), StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Playlist is missing from storage — the video may need re-processing.");
        }
    }

    /**
     * The whole file as a response body. Filesystem-backed media is streamed from disk rather than
     * buffered, so serving a segment never depends on its size.
     */
    @Transactional(readOnly = true)
    public Resource resource(Video video, String relPath) {
        if (inDatabase(video)) {
            return new ByteArrayResource(requireAsset(video, relPath).getData());
        }
        Path file = filesystem.resolveMedia(video, relPath);
        if (!Files.isRegularFile(file)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Media file not found.");
        }
        return new FileSystemResource(file);
    }

    /**
     * Exactly {@code length} bytes from {@code start} — the body of a 206 response. Both backends
     * read only the requested window, so the cost of a range is the size of the range and not the
     * size of the file.
     */
    @Transactional(readOnly = true)
    public Resource range(Video video, String relPath, long start, long length) {
        if (inDatabase(video)) {
            byte[] slice = assets.readRange(video.getId(), normalise(relPath), start, length)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                            "Media file not found."));
            return new ByteArrayResource(slice);
        }
        try {
            Path file = filesystem.resolveMedia(video, relPath);
            return new InputStreamResource(filesystem.openRange(file, start, length));
        } catch (IOException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Could not read the media file.");
        }
    }

    private VideoAsset requireAsset(Video video, String relPath) {
        return assets.findByVideoIdAndRelPath(video.getId(), normalise(relPath))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Media file not found in database storage."));
    }

    // ---- writing -------------------------------------------------------------

    /**
     * Persist whatever FFmpeg left under {@code workingDir} into the database. Called once, after a
     * successful transcode and <b>before</b> the video is marked READY — a client must never be told
     * a video is playable while its bytes are still only on a disk about to be deleted.
     *
     * <p>By the time this runs, {@link VideoSegmentDrainer} has normally already moved the segments
     * — the bulk of the output, and the part that scales with the length of the recording — into
     * the database one at a time and deleted them from disk. What is left here is a handful of
     * small files: the playlists (rewritten by ffmpeg until the last segment, so they cannot be
     * drained early), the poster and the sprite. Reading those into heap together is bounded and
     * safe in a way that reading a whole ladder was not.
     *
     * <p>Only meaningful in {@link VideoStorageMode#DATABASE}; a no-op otherwise, so the caller
     * doesn't have to check.
     *
     * @param skipPaths relative paths not to persist — they are discarded with the working
     *                  directory. Used for the original upload, which is only needed for
     *                  re-processing and is by far the largest object.
     */
    @Transactional
    public void ingest(Video video, Path workingDir, List<String> skipPaths) {
        if (!inDatabase(video)) return;
        if (!Files.isDirectory(workingDir)) return;

        long budget = props.getDatabase().getMaxTotalBytes();
        // What this video already occupies: the segments the drain committed during the transcode.
        long alreadyStored = assets.totalBytes(video.getId());
        // Everything already stored, excluding this video's own rows — a re-process replaces them
        // rather than adding to them, so counting them would make re-processing progressively
        // harder as the library filled up.
        long usedElsewhere = Math.max(0, assets.totalBytesStored() - alreadyStored);

        // Seeded with the drained segments so the budget check below covers the whole recording
        // and not just this last pass. An overwritten path is briefly double-counted, which errs
        // towards refusing an upload rather than overfilling the database.
        long ingested = alreadyStored;
        int count = 0;
        try (Stream<Path> walk = Files.walk(workingDir)) {
            List<Path> files = walk.filter(Files::isRegularFile).toList();
            for (Path file : files) {
                String rel = normalise(workingDir.relativize(file).toString());
                if (skipPaths.contains(rel)) continue;

                long bytes = Files.size(file);
                if (bytes > props.getDatabase().getMaxAssetBytes()) {
                    throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                            "Cannot store '" + rel + "' (" + VideoLibraryService.humanBytes(bytes)
                            + ") in the database: over the "
                            + VideoLibraryService.humanBytes(props.getDatabase().getMaxAssetBytes())
                            + " per-file limit. Install FFmpeg so the recording is split into small "
                            + "segments, raise video.database.max-asset-bytes, or use filesystem "
                            + "storage.");
                }
                // The real total, checked as it accumulates. The upload-time check was only an
                // estimate; this is the one that actually cannot be exceeded. Failing here rolls the
                // whole transaction back, so a part-stored video is never left behind.
                if (usedElsewhere + ingested + bytes > budget) {
                    throw new ResponseStatusException(HttpStatus.INSUFFICIENT_STORAGE,
                            "Ran out of database storage while storing this recording: it needs more "
                            + "than the " + VideoLibraryService.humanBytes(budget) + " total budget "
                            + "allows (" + VideoLibraryService.humanBytes(usedElsewhere)
                            + " already used by other videos). Delete an older recording, upload "
                            + "something shorter, or raise video.database.max-total-bytes.");
                }
                put(video, rel, Files.readAllBytes(file), guessContentType(rel));
                ingested += bytes;
                count++;
            }
        } catch (IOException ex) {
            throw new UncheckedIOException("Failed to ingest video " + video.getId()
                                           + " into database storage", ex);
        }

        log.info("Video {}: stored {} further file(s); {} total in database storage",
                 video.getId(), count, VideoLibraryService.humanBytes(ingested));
    }

    /**
     * Write a stored asset back out to {@code target} and return it.
     *
     * <p>The inverse of {@link #ingest}: FFmpeg can only read real files, so re-processing a
     * database-backed video has to restore the original to disk first.
     */
    @Transactional(readOnly = true)
    public Path materialise(Video video, String relPath, Path target) throws IOException {
        byte[] data = requireAsset(video, relPath).getData();
        Files.createDirectories(target.getParent());
        Files.write(target, data);
        return target;
    }

    /** Upsert one asset, so re-processing overwrites in place instead of duplicating the path. */
    @Transactional
    public void put(Video video, String relPath, byte[] data, String contentType) {
        String path = normalise(relPath);
        assets.findByVideoIdAndRelPath(video.getId(), path)
                .ifPresentOrElse(
                        existing -> existing.setData(data),
                        () -> assets.save(new VideoAsset(video.getId(), path, contentType, data)));
    }

    /** Total bytes this video occupies in database storage (0 when filesystem-backed). */
    @Transactional(readOnly = true)
    public long storedBytes(Video video) {
        return inDatabase(video) ? assets.totalBytes(video.getId()) : 0;
    }

    @Transactional(readOnly = true)
    public long storedBytesTotal() {
        return assets.totalBytesStored();
    }

    // ---- deleting ------------------------------------------------------------

    /** Everything belonging to a video, in whichever backend holds it. */
    @Transactional
    public void deleteAll(Video video) {
        assets.deleteByVideoId(video.getId());   // harmless when there are none
        filesystem.deleteVideoDir(video);
    }

    /**
     * Just the transcode output, before a re-process rebuilds it. The original upload survives.
     * The segment index must never mix runs — a stale {@code seq} pointing at a rewritten segment
     * would produce corrupt playback.
     */
    @Transactional
    public void deleteHlsOutput(Video video) {
        assets.deleteByVideoIdAndRelPathStartingWith(video.getId(),
                                                     VideoTranscodeService.HLS_DIR + "/");
        filesystem.deleteHlsOutput(video);
    }

    // ---- helpers -------------------------------------------------------------

    /**
     * One canonical spelling for a stored path. Windows produces {@code hls\720p\seg_00000.ts} when
     * relativising, and a lookup by the forward-slash form must still find it.
     */
    private String normalise(String relPath) {
        if (relPath == null || relPath.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Missing media path.");
        }
        String cleaned = relPath.replace('\\', '/');
        while (cleaned.startsWith("/")) cleaned = cleaned.substring(1);
        // Database storage has no directories to escape, but a traversal segment would still be a
        // lookup for a path this video never wrote — reject it for the same reason as on disk.
        if (cleaned.contains("../")) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Invalid media path.");
        }
        return cleaned;
    }

    private String guessContentType(String relPath) {
        String lower = relPath.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
        if (lower.endsWith(".ts")) return "video/mp2t";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".mp4") || lower.endsWith(".m4s")) return "video/mp4";
        if (lower.endsWith(".webm")) return "video/webm";
        return "application/octet-stream";
    }
}
