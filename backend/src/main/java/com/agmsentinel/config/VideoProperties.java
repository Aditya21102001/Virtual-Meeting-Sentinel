package com.agmsentinel.config;

import com.agmsentinel.model.VideoStorageMode;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Set;

/**
 * Everything about where video lives and how it is cut up.
 *
 * <p>The bytes live on the <b>NAS</b> ({@code video.nas-path}); the database only ever holds
 * metadata — the video row, its renditions, and the per-segment index. That split is deliberate:
 * a 2 GB recording in a BLOB column would be un-streamable, while a NAS file behind a
 * segment index streams on demand exactly like YouTube does.
 *
 * <p>Configure with env vars (see {@code application.yml}):
 * <pre>
 *   VIDEO_NAS_PATH=\\\\nas01\\media\\virtual-meeting\\videos   (Windows UNC)
 *   VIDEO_NAS_PATH=/mnt/nas/virtual-meeting/videos             (Linux mount)
 *   FFMPEG_PATH=ffmpeg        FFPROBE_PATH=ffprobe
 * </pre>
 */
@Component
@ConfigurationProperties(prefix = "video")
public class VideoProperties {

    /**
     * Where media bytes are kept for <b>new</b> uploads: {@code FILESYSTEM} (the NAS share) or
     * {@code DATABASE} (rows in {@code video_assets}).
     *
     * <p>Recorded per video at upload time, so changing this never strands existing recordings.
     * Use {@code DATABASE} when the host has no persistent volume — a container filesystem is wiped
     * on redeploy, which destroys recordings written to it.
     */
    private VideoStorageMode storageMode = VideoStorageMode.FILESYSTEM;

    /** Root directory on the NAS share. Every upload gets its own sub-folder under this. */
    private String nasPath = "./var/nas/videos";

    /**
     * When true the application refuses to start serving uploads unless {@link #nasPath} is
     * reachable. When false (default) an unreachable NAS degrades to {@link #fallbackPath} so a
     * developer without the share mounted can still use the feature.
     */
    private boolean requireNas = false;

    /** Used only when the NAS is unreachable and {@code requireNas} is false. */
    private String fallbackPath = "./var/videos";

    /** Hard ceiling per upload (bytes). Default 2 GiB. */
    private long maxUploadBytes = 2L * 1024 * 1024 * 1024;

    /** Container extensions an admin is allowed to upload. */
    private Set<String> allowedExtensions =
            Set.of("mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg", "wmv", "flv", "ts");

    private final Hls hls = new Hls();
    private final Tools tools = new Tools();
    private final Playback playback = new Playback();
    private final Database database = new Database();

    /** Settings that only apply to {@link VideoStorageMode#DATABASE}. */
    public static class Database {

        /**
         * Largest upload accepted while in database mode — deliberately far below the filesystem
         * ceiling, because a database is not bulk storage.
         *
         * <p>Checked before the bytes are accepted, so an over-sized upload fails in seconds rather
         * than after a multi-minute transcode.
         */
        private long maxUploadBytes = 200L * 1024 * 1024;

        /**
         * Total budget for all stored media across every video. Once reached, further uploads are
         * refused rather than being allowed to fill the database.
         *
         * <p>The 2 GiB default is comfortable for a self-hosted PostgreSQL and deliberately larger
         * than a free managed tier (Neon allows 0.5 GiB) — lower it to match whatever you actually
         * have.
         */
        private long maxTotalBytes = 2L * 1024 * 1024 * 1024;

        /**
         * Rough multiplier from source size to stored size, used to reject an upload up-front when
         * it clearly will not fit in the remaining budget.
         *
         * <p>The default comes from measurement, not a guess: a 13.2 MB 720p source produced
         * 26.1 MB across three rungs. It only has to be good enough to catch the obvious cases —
         * the real total is re-checked after transcoding, when it is known exactly.
         */
        private double sizeEstimateFactor = 2.0;

        /**
         * Largest single file that may be written into a database row. Segments are a few MB, so
         * the default is generous for HLS output; the limit exists to catch the case that would
         * otherwise try to buffer a whole recording in heap — an un-segmented source, which happens
         * when FFmpeg is missing.
         */
        private long maxAssetBytes = 64L * 1024 * 1024;

        /**
         * Whether to persist the original upload as well as the segments. Off by default: the
         * original is only needed for re-processing, and it is by far the largest object — keeping
         * it would multiply database usage for no playback benefit.
         *
         * <p>The source is persisted regardless when there is no segmented output to play instead
         * (no FFmpeg), because otherwise nothing could be served at all.
         */
        private boolean keepSource = false;

        public long getMaxUploadBytes() { return maxUploadBytes; }
        public void setMaxUploadBytes(long maxUploadBytes) { this.maxUploadBytes = maxUploadBytes; }
        public long getMaxTotalBytes() { return maxTotalBytes; }
        public void setMaxTotalBytes(long maxTotalBytes) { this.maxTotalBytes = maxTotalBytes; }
        public double getSizeEstimateFactor() { return sizeEstimateFactor; }
        public void setSizeEstimateFactor(double f) { this.sizeEstimateFactor = f; }
        public long getMaxAssetBytes() { return maxAssetBytes; }
        public void setMaxAssetBytes(long maxAssetBytes) { this.maxAssetBytes = maxAssetBytes; }
        public boolean isKeepSource() { return keepSource; }
        public void setKeepSource(boolean keepSource) { this.keepSource = keepSource; }
    }

    public static class Hls {
        /** Target segment length in seconds. 6 s is the HLS spec's sweet spot for VOD. */
        private int segmentSeconds = 6;

        /**
         * Rendition ladder as source-capped heights, highest first. A rung is only produced when
         * the source is at least that tall, so we never upscale (which costs CPU and gains nothing).
         */
        private List<Integer> ladder = List.of(1080, 720, 480, 360);

        /** x264 speed/size trade-off. veryfast keeps a 1 h recording tractable on a single box. */
        private String preset = "veryfast";

        /** Seconds between seek-preview thumbnails on the sprite sheet (0 disables the sprite). */
        private int thumbnailIntervalSeconds = 10;

        /** Sprite grid width; the sheet grows in rows as the video gets longer. */
        private int thumbnailColumns = 10;

        /** Width in px of a single seek-preview thumbnail. */
        private int thumbnailWidth = 160;

        public int getSegmentSeconds() { return segmentSeconds; }
        public void setSegmentSeconds(int segmentSeconds) { this.segmentSeconds = segmentSeconds; }
        public List<Integer> getLadder() { return ladder; }
        public void setLadder(List<Integer> ladder) { this.ladder = ladder; }
        public String getPreset() { return preset; }
        public void setPreset(String preset) { this.preset = preset; }
        public int getThumbnailIntervalSeconds() { return thumbnailIntervalSeconds; }
        public void setThumbnailIntervalSeconds(int v) { this.thumbnailIntervalSeconds = v; }
        public int getThumbnailColumns() { return thumbnailColumns; }
        public void setThumbnailColumns(int thumbnailColumns) { this.thumbnailColumns = thumbnailColumns; }
        public int getThumbnailWidth() { return thumbnailWidth; }
        public void setThumbnailWidth(int thumbnailWidth) { this.thumbnailWidth = thumbnailWidth; }
    }

    public static class Tools {
        /**
         * Whether this host is allowed to transcode at all.
         *
         * <p>Set false to force progressive delivery even when ffmpeg is installed. Transcoding is
         * the single most resource-hungry thing the application does — a multi-rung H.264 encode
         * will exhaust a small container's memory and get the whole process killed, taking every
         * in-flight request with it. On a host that cannot afford that, refusing to start is far
         * better than discovering it through a dead container.
         *
         * <p>Uploads still work with this off; they are served whole over HTTP Range, so the source
         * must be in a format browsers can decode (MP4/H.264 or WebM).
         */
        private boolean enabled = true;

        /** ffmpeg executable (on PATH, or an absolute path). */
        private String ffmpeg = "ffmpeg";
        /** ffprobe executable (on PATH, or an absolute path). */
        private String ffprobe = "ffprobe";
        /**
         * Threads ffmpeg may use. 0 lets it decide, which means "one per visible core".
         *
         * <p>A container sees the host's core count, not its own CPU share, so on a fractional-CPU
         * instance ffmpeg happily starts a dozen encoding threads for a tenth of a core. Each one
         * costs memory, and together they starve the JVM of CPU — long enough that the platform's
         * health check times out and restarts the container mid-transcode. Pinning this low keeps
         * the application responsive while it encodes.
         */
        private int threads = 1;

        /** Kill a transcode that runs longer than this (minutes) so a wedged job can't leak. */
        private int timeoutMinutes = 240;
        /** How many videos may transcode at once. Transcoding is CPU-bound — keep this small. */
        private int workers = 1;

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public int getThreads() { return threads; }
        public void setThreads(int threads) { this.threads = threads; }
        public String getFfmpeg() { return ffmpeg; }
        public void setFfmpeg(String ffmpeg) { this.ffmpeg = ffmpeg; }
        public String getFfprobe() { return ffprobe; }
        public void setFfprobe(String ffprobe) { this.ffprobe = ffprobe; }
        public int getTimeoutMinutes() { return timeoutMinutes; }
        public void setTimeoutMinutes(int timeoutMinutes) { this.timeoutMinutes = timeoutMinutes; }
        public int getWorkers() { return workers; }
        public void setWorkers(int workers) { this.workers = workers; }
    }

    public static class Playback {
        /**
         * Lifetime of a playback ticket. A {@code <video>} / native-HLS request carries no
         * Authorization header, so media URLs are authorised by a short-lived signed ticket
         * instead. Long enough to watch a whole video, short enough that a leaked URL dies.
         */
        private long ticketTtlSeconds = 6 * 3600;

        public long getTicketTtlSeconds() { return ticketTtlSeconds; }
        public void setTicketTtlSeconds(long ticketTtlSeconds) { this.ticketTtlSeconds = ticketTtlSeconds; }
    }

    public VideoStorageMode getStorageMode() { return storageMode; }
    public void setStorageMode(VideoStorageMode storageMode) { this.storageMode = storageMode; }
    public String getNasPath() { return nasPath; }
    public void setNasPath(String nasPath) { this.nasPath = nasPath; }
    public boolean isRequireNas() { return requireNas; }
    public void setRequireNas(boolean requireNas) { this.requireNas = requireNas; }
    public String getFallbackPath() { return fallbackPath; }
    public void setFallbackPath(String fallbackPath) { this.fallbackPath = fallbackPath; }
    public long getMaxUploadBytes() { return maxUploadBytes; }
    public void setMaxUploadBytes(long maxUploadBytes) { this.maxUploadBytes = maxUploadBytes; }
    public Set<String> getAllowedExtensions() { return allowedExtensions; }
    public void setAllowedExtensions(Set<String> allowedExtensions) { this.allowedExtensions = allowedExtensions; }
    public Hls getHls() { return hls; }
    public Tools getTools() { return tools; }
    public Playback getPlayback() { return playback; }
    public Database getDatabase() { return database; }
}
