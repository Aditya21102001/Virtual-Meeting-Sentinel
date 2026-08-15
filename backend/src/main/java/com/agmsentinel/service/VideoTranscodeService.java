package com.agmsentinel.service;

import com.agmsentinel.config.VideoProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.function.IntConsumer;
import java.util.regex.Pattern;

/**
 * The segmentation engine: drives ffmpeg/ffprobe to turn one uploaded file into an adaptive HLS
 * ladder, then reads the generated playlists back so every segment can be indexed in the database.
 *
 * <p>Why HLS rather than "just serve the mp4": a media playlist is a list of independently
 * downloadable ~6 s segments, so the browser fetches only the seconds it is about to play, and it
 * can switch to a lower rung mid-stream when bandwidth drops. That is precisely the mechanism that
 * makes YouTube feel like it never buffers — the player keeps a small forward buffer topped up and
 * degrades quality instead of stalling.
 *
 * <p>Everything here is a plain external process; if ffmpeg is not installed, {@link #toolsAvailable()}
 * returns false and the caller falls back to progressive Range streaming.
 */
@Service
public class VideoTranscodeService {

    private static final Logger log = LoggerFactory.getLogger(VideoTranscodeService.class);

    /** Sub-folder of a video's storage dir that holds the ladder. */
    public static final String HLS_DIR = "hls";
    public static final String MASTER_PLAYLIST = "master.m3u8";
    public static final String MEDIA_PLAYLIST = "index.m3u8";
    public static final String POSTER_FILE = "poster.jpg";
    public static final String SPRITE_FILE = "sprite.jpg";

    /** height -> { video kbps, audio kbps }. Standard VOD ladder targets. */
    private static final Map<Integer, int[]> LADDER_BITRATES = new LinkedHashMap<>();
    static {
        LADDER_BITRATES.put(2160, new int[]{14000, 256});
        LADDER_BITRATES.put(1440, new int[]{8000, 192});
        LADDER_BITRATES.put(1080, new int[]{5000, 192});
        LADDER_BITRATES.put(720,  new int[]{2800, 128});
        LADDER_BITRATES.put(480,  new int[]{1400, 128});
        LADDER_BITRATES.put(360,  new int[]{800, 96});
        LADDER_BITRATES.put(240,  new int[]{400, 64});
    }

    /** Cap on seek-preview tiles so a 3-hour recording doesn't produce a 40-megapixel sprite. */
    private static final int MAX_SPRITE_TILES = 400;

    private final VideoProperties props;
    private final ObjectMapper json = new ObjectMapper();

    /**
     * Extract a speech-oriented audio track, for sending to a transcription service.
     *
     * <p>Far cheaper than anything else here: no video is decoded to an output, no x264 encoder is
     * created. It is a demux plus an audio re-encode, so it costs a fraction of one ladder rung.
     *
     * <p>Mono at 16 kHz because that is what speech models consume — sending stereo at 44.1 kHz
     * would triple the upload for no gain in recognition. The bitrate is configurable because
     * hosted transcription APIs cap the file size, and length × bitrate is the only lever on that.
     *
     * @return the extracted file, or null if extraction failed (never throws — a transcript is
     *         an enhancement and must not be able to fail a recording that already processed)
     */
    public Path extractAudio(Path videoDir, Path source, int bitrateKbps) {
        Path target = videoDir.resolve("audio.mp3");
        try {
            List<String> command = ffmpegCommand(List.of(
                    "-hide_banner", "-nostdin", "-y",
                    "-i", source.toString(),
                    "-vn",                                  // drop video entirely
                    "-ac", "1",                             // mono
                    "-ar", "16000",                         // what speech models expect
                    "-c:a", "libmp3lame",
                    "-b:a", Math.max(8, bitrateKbps) + "k",
                    target.toString()));
            log.debug("audio extraction: {}", String.join(" ", command));

            ProcessResult result = run(command, props.getTools().getTimeoutMinutes() * 60L);
            if (result.exitCode() != 0 || !Files.isRegularFile(target)) {
                log.warn("Could not extract audio from {} (exit {}): {}",
                         source.getFileName(), result.exitCode(), result.tail());
                return null;
            }
            return target;
        } catch (Exception ex) {
            log.warn("Could not extract audio from {}: {}", source.getFileName(), ex.getMessage());
            return null;
        }
    }

    /** Tri-state cache of the ffmpeg probe: null = not checked yet. */
    private volatile Boolean toolsPresent;
    private volatile String toolsVersion;

    /** Resolved once: the `nice` binary to prefix ffmpeg with, or null for normal priority. */
    private volatile boolean niceProbed;
    private volatile String nicePath;

    public VideoTranscodeService(VideoProperties props) {
        this.props = props;
    }

    // ---- records -------------------------------------------------------------

    /** What ffprobe learned about the uploaded file. */
    public record MediaInfo(double durationSeconds, int width, int height,
                            double frameRate, boolean hasAudio, String videoCodec, String audioCodec) { }

    public record SegmentInfo(int seq, String filename, double durationSeconds,
                              double startSeconds, long byteSize) { }

    public record RenditionOutput(String name, int width, int height, int videoKbps, int audioKbps,
                                  String playlistRel, List<SegmentInfo> segments) { }

    public record TranscodeOutput(String masterPlaylistRel, List<RenditionOutput> renditions) { }

    public record SpriteInfo(String relativePath, int intervalSeconds, int columns,
                             int tileWidth, int tileHeight) { }

    /** One rung of the ladder, already capped to the source resolution. */
    private record Rung(String name, int height, int videoKbps, int audioKbps) { }

    /**
     * Byte size of a segment that is no longer on disk because it was moved into database storage
     * mid-transcode, addressed as {@code hls/720p/seg_00042.ts}. Returns -1 when unknown.
     *
     * <p>The segment index is built by stat-ing the files ffmpeg's playlists name, so without this
     * every drained segment would be indexed as zero bytes.
     *
     * @see VideoSegmentDrainer
     */
    @FunctionalInterface
    public interface DrainedSizes {
        long sizeOf(String relPath);

        /** Nothing has been drained — every segment is still where ffmpeg left it. */
        DrainedSizes NONE = relPath -> -1;
    }

    // ---- tool discovery ------------------------------------------------------

    /** True when both ffmpeg and ffprobe can be executed. Probed once, then cached. */
    public boolean toolsAvailable() {
        Boolean cached = toolsPresent;
        if (cached != null) return cached;
        synchronized (this) {
            if (toolsPresent != null) return toolsPresent;
            if (!props.getTools().isEnabled()) {
                // Explicitly switched off for this host. Checked before probing so the answer does
                // not depend on whether the binary happens to be installed.
                log.info("Video segmentation is disabled (video.tools.enabled=false). Uploads will "
                         + "be served progressively over HTTP Range.");
                toolsVersion = "disabled";
                toolsPresent = false;
                return false;
            }
            boolean ok = false;
            try {
                ProcessResult ffmpeg = run(List.of(props.getTools().getFfmpeg(), "-version"), 20);
                ProcessResult ffprobe = run(List.of(props.getTools().getFfprobe(), "-version"), 20);
                ok = ffmpeg.exitCode() == 0 && ffprobe.exitCode() == 0;
                if (ok) {
                    toolsVersion = ffmpeg.output().lines().findFirst().orElse("ffmpeg");
                    log.info("Video segmentation enabled — {}", toolsVersion);
                } else {
                    log.warn("ffmpeg/ffprobe found but not runnable; falling back to progressive streaming.");
                }
            } catch (Exception ex) {
                log.warn("ffmpeg not found ({}). Uploads will be served progressively over HTTP Range "
                         + "instead of HLS segments. Install FFmpeg and set FFMPEG_PATH to enable "
                         + "adaptive segmentation.", ex.getMessage());
            }
            toolsPresent = ok;
            return ok;
        }
    }

    public String toolsVersion() {
        toolsAvailable();
        return toolsVersion;
    }

    /**
     * Path to {@code nice}, or null when ffmpeg should run at normal priority.
     *
     * <p>Probed by looking for the binary rather than by trying it: a missing {@code nice} makes
     * {@link ProcessBuilder} throw, which would turn "we could not lower the priority" into "the
     * transcode failed". Resolved once and cached — {@code niceProbed} being the flag rather than
     * a null {@code nicePath}, since null is also the answer we cache on Windows.
     */
    private String niceBinary() {
        if (niceProbed) return nicePath;
        synchronized (this) {
            if (niceProbed) return nicePath;
            String resolved = null;
            if (props.getTools().getNiceness() > 0
                    && !System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) {
                for (String candidate : List.of("/usr/bin/nice", "/bin/nice")) {
                    if (Files.isExecutable(Path.of(candidate))) {
                        resolved = candidate;
                        break;
                    }
                }
                if (resolved == null) {
                    log.info("`nice` not found — ffmpeg will run at normal priority. On a small "
                             + "instance a transcode may then starve the API of CPU.");
                } else {
                    log.info("ffmpeg will run at nice +{} so the API keeps its share of the CPU.",
                             props.getTools().getNiceness());
                }
            }
            nicePath = resolved;
            niceProbed = true;
            return nicePath;
        }
    }

    // ---- probe ---------------------------------------------------------------

    /** Read duration / dimensions / frame rate / audio presence from the source file. */
    public MediaInfo probe(Path source) throws IOException, InterruptedException {
        ProcessResult result = run(List.of(
                props.getTools().getFfprobe(),
                "-v", "error",
                "-print_format", "json",
                "-show_format", "-show_streams",
                source.toString()), 120);

        if (result.exitCode() != 0) {
            throw new IOException("ffprobe failed: " + result.tail());
        }

        JsonNode probe = json.readTree(result.output());
        JsonNode videoStream = null;
        boolean hasAudio = false;
        String audioCodec = null;
        for (JsonNode stream : probe.path("streams")) {
            String type = stream.path("codec_type").asText("");
            if ("video".equals(type) && videoStream == null
                    // Cover art is stored as a video stream; a real track has a frame rate.
                    && !"mjpeg".equals(stream.path("codec_name").asText(""))) {
                videoStream = stream;
            } else if ("audio".equals(type)) {
                hasAudio = true;
                if (audioCodec == null) audioCodec = stream.path("codec_name").asText(null);
            }
        }
        if (videoStream == null) {
            throw new IOException("No video track found in the uploaded file.");
        }

        int width = videoStream.path("width").asInt(0);
        int height = videoStream.path("height").asInt(0);
        // A phone recording carries its orientation as rotation metadata; the stored frame is
        // landscape but it must play portrait. Swap so the ladder is built on displayed height.
        if (isQuarterTurn(videoStream)) {
            int swap = width;
            width = height;
            height = swap;
        }

        double duration = videoStream.path("duration").asDouble(0);
        if (duration <= 0) duration = probe.path("format").path("duration").asDouble(0);

        return new MediaInfo(duration, width, height,
                parseFrameRate(videoStream.path("r_frame_rate").asText("")),
                hasAudio,
                videoStream.path("codec_name").asText(null),
                audioCodec);
    }

    /** True when rotation metadata turns the stored frame 90° or 270°. */
    private boolean isQuarterTurn(JsonNode videoStream) {
        double rotation = 0;
        for (JsonNode side : videoStream.path("side_data_list")) {
            if (side.has("rotation")) rotation = side.path("rotation").asDouble(0);
        }
        if (rotation == 0) {
            rotation = videoStream.path("tags").path("rotate").asDouble(0);
        }
        int normalised = Math.abs((int) Math.round(rotation)) % 180;
        return normalised == 90;
    }

    private double parseFrameRate(String rFrameRate) {
        try {
            String[] parts = rFrameRate.split("/");
            if (parts.length == 2) {
                double den = Double.parseDouble(parts[1]);
                return den == 0 ? 25 : Double.parseDouble(parts[0]) / den;
            }
            return Double.parseDouble(rFrameRate);
        } catch (RuntimeException ex) {
            return 25;   // a sane default only used to pick the GOP length
        }
    }

    // ---- transcode -----------------------------------------------------------

    /**
     * Cut {@code source} into an HLS ladder under {@code <videoDir>/hls}, then read the generated
     * playlists back into a segment index.
     *
     * @param progress receives 0-100 as ffmpeg reports its output timestamp. Throwing from it
     *                 aborts the encode — that is how a drain that has run out of database budget
     *                 stops the run instead of letting it finish into storage that cannot hold it.
     * @param drained  sizes of segments already moved into database storage and deleted from disk
     */
    public TranscodeOutput transcodeToHls(Path videoDir, Path source, MediaInfo info,
                                          IntConsumer progress, DrainedSizes drained)
            throws IOException, InterruptedException {
        return transcodeToHls(videoDir, source, info, progress, drained, null);
    }

    /**
     * Transcode, optionally encrypting every segment with AES-128.
     *
     * @param contentKey the raw 16-byte key, or null to leave the segments in the clear. The caller
     *                   owns wrapping and storing it — this method only hands it to ffmpeg and makes
     *                   sure the plaintext copy does not outlive the encode.
     */
    public TranscodeOutput transcodeToHls(Path videoDir, Path source, MediaInfo info,
                                          IntConsumer progress, DrainedSizes drained,
                                          byte[] contentKey)
            throws IOException, InterruptedException {
        List<Rung> ladder = buildLadder(info);
        Path hlsDir = videoDir.resolve(HLS_DIR);
        Files.createDirectories(hlsDir);
        // ffmpeg substitutes %v into the output path but will NOT create the directory, so every
        // rung folder has to exist before it starts writing segments.
        for (Rung rung : ladder) {
            Files.createDirectories(hlsDir.resolve(rung.name()));
        }

        log.info("Transcoding {} into {} rendition(s): {} ({})", source.getFileName(), ladder.size(),
                 ladder.stream().map(Rung::name).toList(),
                 props.getHls().isParallelRungs() ? "one pass" : "one rung at a time");

        // The key info file, and the raw key it points at, live in a temporary directory — NOT in
        // videoDir. Everything under videoDir is ingested into storage when the encode finishes, so
        // a key written there would be filed alongside the segments it unlocks, and encrypting them
        // would have achieved nothing at all.
        Path keyDir = contentKey == null ? null : Files.createTempDirectory("hlskey-");
        Path keyInfo = contentKey == null ? null : writeKeyInfo(keyDir, contentKey);

        List<RenditionOutput> renditions;
        try {
            renditions = props.getHls().isParallelRungs()
                    ? encodeInOnePass(hlsDir, source, info, ladder, progress, drained, keyInfo)
                    : encodeRungByRung(hlsDir, source, info, ladder, progress, drained, keyInfo);
        } finally {
            // Best effort, but attempted on every path including failure: a plaintext content key
            // left on disk is the one artefact that undoes the encryption entirely.
            shredKeyMaterial(keyDir);
        }

        if (renditions.isEmpty()) {
            throw new IOException("Transcode produced no playable renditions.");
        }
        return new TranscodeOutput(HLS_DIR + "/" + MASTER_PLAYLIST, renditions);
    }

    /**
     * One ffmpeg run, one decode, every rung encoded simultaneously. Fastest, and the reason the
     * default is the other one: N x264 encoders allocate their frame buffers at start-up, so peak
     * memory is the sum of the whole ladder and it arrives within seconds of the job beginning.
     */
    private List<RenditionOutput> encodeInOnePass(Path hlsDir, Path source, MediaInfo info,
                                                  List<Rung> ladder, IntConsumer progress,
                                                  DrainedSizes drained, Path keyInfo)
            throws IOException, InterruptedException {
        List<String> command = buildFfmpegCommand(hlsDir, source, info, ladder, keyInfo);
        log.debug("ffmpeg command: {}", String.join(" ", command));

        ProcessResult result = runWithProgress(command, info.durationSeconds(), progress);
        if (result.exitCode() != 0) {
            throw new IOException("ffmpeg exited with code " + result.exitCode() + ": " + result.tail());
        }

        Path master = hlsDir.resolve(MASTER_PLAYLIST);
        if (!Files.exists(master)) {
            throw new IOException("ffmpeg finished but no master playlist was produced: " + result.tail());
        }

        // The master playlist reports the width/bandwidth ffmpeg actually chose (our -2 scale means
        // the width is derived from the aspect ratio), so prefer it over our requested values.
        Map<String, int[]> actual = readMasterVariants(master);

        List<RenditionOutput> renditions = new ArrayList<>();
        for (Rung rung : ladder) {
            Path playlist = hlsDir.resolve(rung.name()).resolve(MEDIA_PLAYLIST);
            if (!Files.exists(playlist)) {
                log.warn("Rendition {} produced no playlist — skipping.", rung.name());
                continue;
            }
            int[] measured = actual.get(rung.name());
            int width = measured != null && measured[0] > 0 ? measured[0] : evenWidth(info, rung.height());
            int height = measured != null && measured[1] > 0 ? measured[1] : rung.height();
            renditions.add(renditionOf(hlsDir, rung, width, height, drained));
        }
        return renditions;
    }

    /**
     * One ffmpeg run per rung, in sequence. The source is decoded once per rung — genuinely more
     * total work — but only ever one encoder exists at a time, so the peak memory of the job is the
     * cost of its largest rung rather than of the whole ladder.
     *
     * <p>This is the default because the failure it avoids is not a slow transcode, it is the
     * container being killed. A recording that takes three times as long still arrives; one that
     * takes the server down with it never does, and takes every other request with it on the way.
     *
     * <p>A rung that fails is logged and skipped rather than failing the whole job: three working
     * quality levels are worth more than none, and the ladder degrades gracefully.
     */
    private List<RenditionOutput> encodeRungByRung(Path hlsDir, Path source, MediaInfo info,
                                                   List<Rung> ladder, IntConsumer progress,
                                                   DrainedSizes drained, Path keyInfo)
            throws IOException, InterruptedException {
        List<RenditionOutput> renditions = new ArrayList<>();
        int total = ladder.size();

        for (int i = 0; i < total; i++) {
            Rung rung = ladder.get(i);
            final int done = i;
            List<String> command = buildSingleRungCommand(hlsDir, source, info, rung, keyInfo);
            log.info("Encoding rung {}/{}: {}", i + 1, total, rung.name());
            log.debug("ffmpeg command: {}", String.join(" ", command));

            // Each rung covers its own slice of the overall bar, so the percentage the admin sees
            // still runs 0-100 across the job rather than resetting for every rung.
            ProcessResult result = runWithProgress(command, info.durationSeconds(),
                    percent -> progress.accept((done * 100 + percent) / total));

            if (result.exitCode() != 0) {
                if (renditions.isEmpty() && i == total - 1) {
                    throw new IOException("ffmpeg exited with code " + result.exitCode()
                                          + ": " + result.tail());
                }
                log.warn("Rendition {} failed (exit {}): {} — continuing with the other rungs.",
                         rung.name(), result.exitCode(), result.tail());
                continue;
            }
            Path playlist = hlsDir.resolve(rung.name()).resolve(MEDIA_PLAYLIST);
            if (!Files.exists(playlist)) {
                log.warn("Rendition {} produced no playlist — skipping.", rung.name());
                continue;
            }
            renditions.add(renditionOf(hlsDir, rung, evenWidth(info, rung.height()), rung.height(),
                                       drained));
        }

        // Nobody wrote a master: -master_pl_name only applies to a multi-variant run.
        writeMasterPlaylist(hlsDir, renditions);
        return renditions;
    }

    private RenditionOutput renditionOf(Path hlsDir, Rung rung, int width, int height,
                                        DrainedSizes drained) throws IOException {
        String rungRel = HLS_DIR + "/" + rung.name() + "/";
        Path playlist = hlsDir.resolve(rung.name()).resolve(MEDIA_PLAYLIST);
        List<SegmentInfo> segments = readMediaPlaylist(playlist, rungRel, drained);
        return new RenditionOutput(rung.name(), width, height, rung.videoKbps(), rung.audioKbps(),
                                   rungRel + MEDIA_PLAYLIST, segments);
    }

    /**
     * Write the variant list by hand for the rung-by-rung path.
     *
     * <p>{@code BANDWIDTH} is what the player actually selects on, so it is the one attribute that
     * must be right; {@code RESOLUTION} lets a quality menu label the rungs. {@code CODECS} is
     * deliberately omitted — it is optional, and a player will refuse a variant whose declared
     * codec string is wrong, which is a worse outcome than not declaring one.
     */
    private void writeMasterPlaylist(Path hlsDir, List<RenditionOutput> renditions) throws IOException {
        StringBuilder master = new StringBuilder("#EXTM3U\n#EXT-X-VERSION:3\n");
        for (RenditionOutput rendition : renditions) {
            long bandwidth = (rendition.videoKbps() + rendition.audioKbps()) * 1000L;
            master.append("#EXT-X-STREAM-INF:BANDWIDTH=").append(bandwidth);
            if (rendition.width() > 0 && rendition.height() > 0) {
                master.append(",RESOLUTION=").append(rendition.width())
                      .append('x').append(rendition.height());
            }
            master.append('\n')
                  .append(rendition.name()).append('/').append(MEDIA_PLAYLIST).append('\n');
        }
        Files.writeString(hlsDir.resolve(MASTER_PLAYLIST), master.toString(), StandardCharsets.UTF_8);
    }

    /**
     * Pick the ladder rungs: the configured heights that the source can actually supply. Upscaling
     * a 480p recording to 1080p only burns CPU and bandwidth, so rungs taller than the source are
     * dropped; if the source is shorter than every configured rung we emit a single rung at the
     * source's own height so there is still something to play.
     */
    private List<Rung> buildLadder(MediaInfo info) {
        List<Integer> configured = new ArrayList<>(props.getHls().getLadder());
        configured.sort(Comparator.reverseOrder());

        List<Rung> ladder = new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        for (int height : configured) {
            // Skip rungs taller than the source, unless upscaling was asked for. Upscaling adds
            // no detail — a 720p rung from a 576p master is the 480p picture in a bigger file — so
            // the default is to cap. See VideoProperties.Hls.upscale for when to turn it on.
            if (!props.getHls().isUpscale() && info.height() > 0 && height > info.height()) continue;
            if (!seen.add(height)) continue;
            int[] bitrates = bitratesFor(height);
            ladder.add(new Rung(height + "p", height, bitrates[0], bitrates[1]));
        }
        if (ladder.isEmpty()) {
            int height = Math.max(144, even(info.height() > 0 ? info.height() : 360));
            int[] bitrates = bitratesFor(height);
            ladder.add(new Rung(height + "p", height, bitrates[0], bitrates[1]));
        }
        return ladder;
    }

    /** Bitrate targets for a height, interpolated from the nearest standard rung. */
    private int[] bitratesFor(int height) {
        int[] exact = LADDER_BITRATES.get(height);
        if (exact != null) return exact;
        int nearest = LADDER_BITRATES.keySet().stream()
                .min(Comparator.comparingInt(h -> Math.abs(h - height)))
                .orElse(720);
        int[] base = LADDER_BITRATES.get(nearest);
        // Scale the video bitrate with pixel count; keep audio at the neighbour's rate.
        double ratio = (double) (height * height) / (nearest * nearest);
        return new int[]{Math.max(200, (int) Math.round(base[0] * ratio)), base[1]};
    }

    private int evenWidth(MediaInfo info, int height) {
        if (info.width() <= 0 || info.height() <= 0) return 0;
        return even((int) Math.round(height * (double) info.width() / info.height()));
    }

    private int even(int value) {
        return value % 2 == 0 ? value : value + 1;
    }

    /**
     * {@code nice ffmpeg <args>}.
     *
     * <p>Running the encoder below the JVM is what keeps the application answerable while it works.
     * Capping threads bounds how much ffmpeg does at once; this bounds how much it does <em>at the
     * JVM's expense</em>, which is what decides whether the health check is still answered during a
     * transcode — and therefore whether the platform leaves the container alone or restarts it
     * mid-job.
     */
    private List<String> ffmpegCommand(List<String> args) {
        List<String> cmd = new ArrayList<>();
        String nice = niceBinary();
        if (nice != null) {
            cmd.addAll(List.of(nice, "-n", String.valueOf(props.getTools().getNiceness())));
        }
        cmd.add(props.getTools().getFfmpeg());
        cmd.addAll(args);
        return cmd;
    }

    /**
     * The invocation prefix every <em>encoding</em> run shares: {@link #ffmpegCommand} plus the
     * progress stream and the thread cap.
     */
    private List<String> ffmpegPrefix() {
        List<String> cmd = ffmpegCommand(
                List.of("-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"));

        // Cap ffmpeg's parallelism BEFORE the input so it applies to decoding, filtering and every
        // encoder. A container sees the host's core count rather than its own CPU share, so left to
        // itself ffmpeg spawns a thread per host core for a fraction of a core's worth of quota.
        // The encoders then starve the JVM: health checks time out, the platform restarts the
        // container mid-transcode, and the video is stranded at whatever percent it had reached.
        int threads = props.getTools().getThreads();
        if (threads > 0) {
            cmd.addAll(List.of("-threads", String.valueOf(threads),
                               "-filter_threads", String.valueOf(threads),
                               "-filter_complex_threads", String.valueOf(threads)));
        }
        return cmd;
    }

    /**
     * Everything needed to produce one rung, as its own ffmpeg run.
     *
     * <p>The filter graph mirrors the multi-rung command's — {@code [0:v]} rather than
     * {@code 0:v:0}, so stream selection picks the same track in both paths — minus the
     * {@code split}. Options are unqualified because there is exactly one output stream of each
     * kind here, where the one-pass command has to say {@code -c:v:2} to address a specific rung.
     */
    /**
     * Write the three-line file ffmpeg reads the encryption settings from.
     *
     * <pre>
     *   line 1  the URI written verbatim into #EXT-X-KEY in the playlist
     *   line 2  the local path ffmpeg reads the raw 16 bytes from
     *   line 3  (omitted) an explicit IV; without it ffmpeg derives one per segment
     * </pre>
     *
     * <p>Line 1 is the relative string {@code key} on purpose. It resolves against the playlist's
     * own URL, so a player asks for {@code /api/videos/{id}/r/{rung}/key} — and VideoController
     * rewrites that line to carry the playback ticket, exactly as it already does for segments. An
     * absolute URL would freeze today's host and today's ticket into files that outlive both.
     */
    private Path writeKeyInfo(Path keyDir, byte[] contentKey) throws IOException {
        Path keyFile = keyDir.resolve("content.key");
        Files.write(keyFile, contentKey);

        Path info = keyDir.resolve("key_info");
        Files.writeString(info, "key" + System.lineSeparator()
                                + keyFile.toAbsolutePath() + System.lineSeparator(),
                          StandardCharsets.UTF_8);
        return info;
    }

    /**
     * Remove the plaintext key and the file pointing at it.
     *
     * <p>Overwritten before deletion rather than simply unlinked. On a container filesystem that is
     * mostly ceremony, but the cost is nothing and the alternative is a 16-byte file that undoes the
     * encryption of an entire recording sitting in a temp directory nobody thinks to look at.
     */
    private void shredKeyMaterial(Path keyDir) {
        if (keyDir == null) return;
        try (var entries = Files.list(keyDir)) {
            for (Path file : entries.toList()) {
                try {
                    byte[] zeros = new byte[(int) Math.max(1, Files.size(file))];
                    Files.write(file, zeros);
                } catch (IOException ignored) {
                    // Best effort; the delete below is what matters.
                }
                Files.deleteIfExists(file);
            }
            Files.deleteIfExists(keyDir);
        } catch (IOException e) {
            log.warn("Could not remove the temporary key material at {}: {}", keyDir, e.getMessage());
        }
    }

    private List<String> buildSingleRungCommand(Path hlsDir, Path source, MediaInfo info,
                                                Rung rung, Path keyInfo) {
        int segmentSeconds = Math.max(2, props.getHls().getSegmentSeconds());
        int gop = Math.max(1, (int) Math.round((info.frameRate() > 0 ? info.frameRate() : 25) * segmentSeconds));
        Path rungDir = hlsDir.resolve(rung.name());

        List<String> cmd = ffmpegPrefix();
        cmd.addAll(List.of("-i", source.toString()));
        cmd.addAll(List.of(
                "-filter_complex",
                "[0:v]scale=-2:" + rung.height() + ":flags=bicubic,setsar=1[v]",
                "-map", "[v]",
                "-c:v", "libx264",
                "-preset", props.getHls().getPreset(),
                "-profile:v", rung.height() >= 720 ? "high" : "main",
                "-b:v", rung.videoKbps() + "k",
                "-maxrate", (rung.videoKbps() * 107 / 100) + "k",
                "-bufsize", (rung.videoKbps() * 3 / 2) + "k",
                // x264's resident memory is dominated by the frames it holds: the lookahead queue
                // and the reference list, each a full decoded frame. The defaults are tuned for a
                // machine with memory to spare; on a container that shares its limit with the JVM
                // they are the difference between finishing and being killed. Cutting the lookahead
                // costs a little rate-control accuracy and one reference frame costs a little
                // compression — both cheap next to not producing the video at all.
                "-x264-params", "rc-lookahead=10:ref=1:sync-lookahead=0:threads=1"));

        if (info.hasAudio()) {
            cmd.addAll(List.of("-map", "a:0", "-c:a", "aac",
                               "-b:a", rung.audioKbps() + "k", "-ac", "2"));
        }

        cmd.addAll(List.of(
                "-g", String.valueOf(gop),
                "-keyint_min", String.valueOf(gop),
                "-sc_threshold", "0",
                "-force_key_frames:v", "expr:gte(t,n_forced*" + segmentSeconds + ")",
                // A quarter of the one-pass value: with a single output there is far less to queue,
                // and the queue is a straight memory cost on a host that has none to spare.
                "-max_muxing_queue_size", "256",
                "-f", "hls",
                "-hls_time", String.valueOf(segmentSeconds),
                "-hls_playlist_type", "vod",
                "-hls_flags", "independent_segments+temp_file",
                "-hls_segment_type", "mpegts",
                "-hls_list_size", "0",
                "-hls_segment_filename", rungDir.resolve("seg_%05d.ts").toString()));
        // Encrypt, when a key was supplied. ffmpeg reads the URI and the key path from this file
        // and writes #EXT-X-KEY into the playlist itself.
        if (keyInfo != null) {
            cmd.addAll(List.of("-hls_key_info_file", keyInfo.toString()));
        }
        cmd.add(rungDir.resolve(MEDIA_PLAYLIST).toString());
        return cmd;
    }

    private List<String> buildFfmpegCommand(Path hlsDir, Path source, MediaInfo info,
                                           List<Rung> ladder, Path keyInfo) {
        int segmentSeconds = Math.max(2, props.getHls().getSegmentSeconds());
        // Keyframe every segment: a segment must start on a keyframe to be independently
        // decodable, and matching the GOP to the segment length is what lets the player switch
        // rungs (and seek) at any segment boundary.
        int gop = Math.max(1, (int) Math.round((info.frameRate() > 0 ? info.frameRate() : 25) * segmentSeconds));

        List<String> cmd = ffmpegPrefix();
        cmd.addAll(List.of("-i", source.toString()));

        // Split the decoded video once and scale each branch — one decode pass for the whole ladder.
        StringBuilder filter = new StringBuilder("[0:v]split=").append(ladder.size());
        for (int i = 0; i < ladder.size(); i++) filter.append("[s").append(i).append(']');
        for (int i = 0; i < ladder.size(); i++) {
            filter.append(";[s").append(i).append(']')
                  .append("scale=-2:").append(ladder.get(i).height())
                  .append(":flags=bicubic,setsar=1[v").append(i).append(']');
        }
        cmd.addAll(List.of("-filter_complex", filter.toString()));

        for (int i = 0; i < ladder.size(); i++) {
            Rung rung = ladder.get(i);
            int maxrate = rung.videoKbps() * 107 / 100;
            int bufsize = rung.videoKbps() * 3 / 2;
            cmd.addAll(List.of(
                    "-map", "[v" + i + "]",
                    "-c:v:" + i, "libx264",
                    "-preset", props.getHls().getPreset(),
                    "-profile:v:" + i, rung.height() >= 720 ? "high" : "main",
                    "-b:v:" + i, rung.videoKbps() + "k",
                    "-maxrate:v:" + i, maxrate + "k",
                    "-bufsize:v:" + i, bufsize + "k"));
        }

        if (info.hasAudio()) {
            // The single source track is encoded once per rung so each variant is self-contained.
            // Every option is stream-qualified (":a:i") — a bare "-ac 2" repeated in this loop is
            // global, so ffmpeg warns and applies only the last occurrence to all of them.
            for (int i = 0; i < ladder.size(); i++) {
                cmd.addAll(List.of(
                        "-map", "a:0",
                        "-c:a:" + i, "aac",
                        "-b:a:" + i, ladder.get(i).audioKbps() + "k",
                        "-ac:a:" + i, "2"));
            }
        }

        cmd.addAll(List.of(
                "-g", String.valueOf(gop),
                "-keyint_min", String.valueOf(gop),
                "-sc_threshold", "0",
                "-force_key_frames:v", "expr:gte(t,n_forced*" + segmentSeconds + ")",
                // Many parallel outputs can overflow the default mux queue on long recordings.
                "-max_muxing_queue_size", "1024",
                "-f", "hls",
                "-hls_time", String.valueOf(segmentSeconds),
                "-hls_playlist_type", "vod",
                // temp_file writes each segment as seg_00042.ts.tmp and renames it only when the
                // segment is closed. That rename is what makes it safe for the drain to move
                // finished segments into the database while this is still running: any .ts it can
                // see is complete, so it can never store a half-written one.
                "-hls_flags", "independent_segments+temp_file",
                "-hls_segment_type", "mpegts",
                "-hls_list_size", "0",
                "-hls_segment_filename", hlsDir.resolve("%v").resolve("seg_%05d.ts").toString(),
                "-master_pl_name", MASTER_PLAYLIST,
                "-var_stream_map", varStreamMap(ladder, info.hasAudio())));
        // One key for the whole ladder, which is what lets a player switch quality without
        // fetching a second one. ffmpeg writes #EXT-X-KEY into each rung's playlist itself.
        if (keyInfo != null) {
            cmd.addAll(List.of("-hls_key_info_file", keyInfo.toString()));
        }
        cmd.add(hlsDir.resolve("%v").resolve(MEDIA_PLAYLIST).toString());
        return cmd;
    }

    /**
     * e.g. {@code "v:0,a:0,name:1080p v:1,a:1,name:720p"} — one group per rung. The rung name
     * becomes the {@code %v} directory, so it is what every segment path and playlist URL is
     * built from.
     *
     * <p>Every key/value inside a group is separated by a colon, {@code name} included. Writing
     * {@code name=720p} makes ffmpeg reject the whole map ("Invalid keyval") and abort the run
     * after the first frame.
     */
    private String varStreamMap(List<Rung> ladder, boolean hasAudio) {
        StringBuilder map = new StringBuilder();
        for (int i = 0; i < ladder.size(); i++) {
            if (i > 0) map.append(' ');
            map.append("v:").append(i);
            if (hasAudio) map.append(",a:").append(i);
            map.append(",name:").append(ladder.get(i).name());
        }
        return map.toString();
    }

    // ---- poster + seek-preview sprite ---------------------------------------

    /** Grab a representative frame ~10% into the video as the catalogue thumbnail. */
    public String renderPoster(Path videoDir, Path source, MediaInfo info) {
        double at = info.durationSeconds() > 0 ? Math.min(info.durationSeconds() * 0.1, 30) : 1;
        Path poster = videoDir.resolve(POSTER_FILE);
        try {
            ProcessResult result = run(ffmpegCommand(List.of(
                    "-hide_banner", "-nostdin", "-y",
                    // -ss before -i seeks by keyframe index instead of decoding from zero.
                    "-ss", String.format(Locale.ROOT, "%.3f", at),
                    "-i", source.toString(),
                    "-frames:v", "1",
                    "-vf", "scale=640:-2",
                    "-q:v", "3",
                    poster.toString())), 120);
            return result.exitCode() == 0 && Files.exists(poster) ? POSTER_FILE : null;
        } catch (Exception ex) {
            log.warn("Poster generation failed: {}", ex.getMessage());
            return null;
        }
    }

    /**
     * Build the hover-scrub filmstrip: one tiny frame every N seconds, tiled into a single JPEG.
     * The player slices this sheet with CSS, so a seek preview costs one image request for the
     * whole video instead of one request per hover.
     */
    public SpriteInfo renderSprite(Path videoDir, Path source, MediaInfo info) {
        int configuredInterval = props.getHls().getThumbnailIntervalSeconds();
        if (configuredInterval <= 0 || info.durationSeconds() <= 0) return null;

        // Keep the sheet bounded: stretch the interval rather than emit thousands of tiles.
        int interval = Math.max(configuredInterval,
                (int) Math.ceil(info.durationSeconds() / MAX_SPRITE_TILES));
        int tiles = Math.max(1, (int) Math.ceil(info.durationSeconds() / interval));
        int columns = Math.max(1, props.getHls().getThumbnailColumns());
        int rows = (int) Math.ceil(tiles / (double) columns);
        int tileWidth = even(Math.max(80, props.getHls().getThumbnailWidth()));
        int tileHeight = info.width() > 0 && info.height() > 0
                ? even((int) Math.round(tileWidth * (double) info.height() / info.width()))
                : even(tileWidth * 9 / 16);

        Path sprite = videoDir.resolve(SPRITE_FILE);
        try {
            // Decodes the whole recording to sample one frame every `interval` seconds, so it is
            // the second-most expensive thing here and gets the same low priority as the encode.
            ProcessResult result = run(ffmpegCommand(List.of(
                    "-hide_banner", "-nostdin", "-y",
                    "-i", source.toString(),
                    "-vf", "fps=1/" + interval
                            + ",scale=" + tileWidth + ":" + tileHeight
                            + ",tile=" + columns + "x" + rows,
                    "-frames:v", "1",
                    "-q:v", "4",
                    sprite.toString())), props.getTools().getTimeoutMinutes() * 60L);
            if (result.exitCode() != 0 || !Files.exists(sprite)) {
                log.warn("Sprite generation failed: {}", result.tail());
                return null;
            }
            return new SpriteInfo(SPRITE_FILE, interval, columns, tileWidth, tileHeight);
        } catch (Exception ex) {
            log.warn("Sprite generation failed: {}", ex.getMessage());
            return null;
        }
    }

    // ---- playlist parsing ----------------------------------------------------

    /**
     * Read a media playlist into the segment index. Each {@code #EXTINF:<seconds>,} line is
     * followed by the segment's filename; accumulating the durations gives every segment's start
     * time, which is what turns "seek to 21:30" into "fetch segment 215".
     *
     * @param rungRel prefix identifying this rung's directory, e.g. {@code hls/720p/}
     * @param drained sizes for segments already moved into database storage; consulted only when
     *                the file is no longer on disk
     */
    private List<SegmentInfo> readMediaPlaylist(Path playlist, String rungRel, DrainedSizes drained)
            throws IOException {
        List<SegmentInfo> segments = new ArrayList<>();
        Path dir = playlist.getParent();
        double cursor = 0;
        Double pendingDuration = null;
        int seq = 0;

        for (String raw : Files.readAllLines(playlist, StandardCharsets.UTF_8)) {
            String line = raw.trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("#EXTINF:")) {
                String value = line.substring("#EXTINF:".length()).replace(",", "").trim();
                try {
                    pendingDuration = Double.parseDouble(value);
                } catch (NumberFormatException ex) {
                    pendingDuration = null;
                }
            } else if (!line.startsWith("#")) {
                double duration = pendingDuration != null ? pendingDuration : 0;
                segments.add(new SegmentInfo(seq++, line, duration, cursor,
                                             segmentSize(dir, rungRel, line, drained)));
                cursor += duration;
                pendingDuration = null;
            }
        }
        return segments;
    }

    /**
     * Size of one segment, wherever it now lives. A drained segment has been deleted from disk, so
     * the drain's own record of what it stored is the only source left — falling through to 0 would
     * make the inspector report a whole ladder of empty segments.
     */
    private long segmentSize(Path dir, String rungRel, String filename, DrainedSizes drained)
            throws IOException {
        Path file = dir.resolve(filename);
        if (Files.exists(file)) return Files.size(file);
        return Math.max(0, drained.sizeOf(rungRel + filename));
    }

    /** Rendition name -> { width, height } as declared by ffmpeg in the master playlist. */
    private Map<String, int[]> readMasterVariants(Path master) throws IOException {
        Map<String, int[]> variants = new HashMap<>();
        List<String> lines = Files.readAllLines(master, StandardCharsets.UTF_8);
        int[] pending = null;
        for (String raw : lines) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-STREAM-INF:")) {
                pending = parseResolution(line);
            } else if (!line.isEmpty() && !line.startsWith("#")) {
                // URI looks like "720p/index.m3u8" — the first path element is the rung name.
                String name = line.contains("/") ? line.substring(0, line.indexOf('/')) : line;
                if (pending != null) variants.put(name, pending);
                pending = null;
            }
        }
        return variants;
    }

    private int[] parseResolution(String streamInf) {
        int idx = streamInf.indexOf("RESOLUTION=");
        if (idx < 0) return null;
        String value = streamInf.substring(idx + "RESOLUTION=".length());
        int comma = value.indexOf(',');
        if (comma >= 0) value = value.substring(0, comma);
        String[] parts = value.trim().split("x");
        if (parts.length != 2) return null;
        try {
            return new int[]{Integer.parseInt(parts[0]), Integer.parseInt(parts[1])};
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    // ---- process plumbing ----------------------------------------------------

    private record ProcessResult(int exitCode, String output, String errorTail) {

        /**
         * Lines that name a cause rather than describe progress. ffmpeg reports the real problem
         * early and then prints per-encoder statistics on the way out, so a plain tail of the
         * output shows bitrate tables and hides the one line that matters.
         */
        private static final Pattern DIAGNOSTIC = Pattern.compile(
                "(?i)\\b(error|invalid|failed|unable|unsupported|no such|not found|denied|"
                + "cannot|conversion failed|incorrect)\\b");

        /** The most useful few lines for an error message shown in the UI. */
        String tail() {
            String text = errorTail == null || errorTail.isBlank() ? output : errorTail;
            if (text == null || text.isBlank()) return "no output";

            List<String> diagnostics = new ArrayList<>();
            for (String line : text.split("\\r?\\n")) {
                String trimmed = line.trim();
                // Skip the encoder summary tables; they match "error" only by coincidence.
                if (trimmed.isEmpty() || trimmed.startsWith("[libx264") || trimmed.startsWith("[aac")) {
                    continue;
                }
                if (DIAGNOSTIC.matcher(trimmed).find()) diagnostics.add(trimmed);
            }

            String chosen = diagnostics.isEmpty() ? text.trim() : String.join(" | ", diagnostics);
            return chosen.length() > 600 ? chosen.substring(0, 600) : chosen;
        }
    }

    /** Run a short-lived command and collect its output. */
    private ProcessResult run(List<String> command, long timeoutSeconds)
            throws IOException, InterruptedException {
        Process process = new ProcessBuilder(command).redirectErrorStream(false).start();
        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();
        Thread errPump = drain(process, stderr);

        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                stdout.append(line).append('\n');
            }
        }
        boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            errPump.join(2000);
            throw new IOException("Command timed out after " + timeoutSeconds + "s: " + command.get(0));
        }
        errPump.join(2000);
        return new ProcessResult(process.exitValue(), stdout.toString(), stderr.toString());
    }

    /**
     * Run ffmpeg and translate its {@code -progress} stream into a percentage. ffmpeg prints
     * {@code out_time_us=<microseconds>} for the frame it has just written, so dividing by the
     * probed duration gives real progress rather than a spinner.
     */
    private ProcessResult runWithProgress(List<String> command, double durationSeconds,
                                          IntConsumer progress)
            throws IOException, InterruptedException {
        Process process = new ProcessBuilder(command).redirectErrorStream(false).start();
        StringBuilder stderr = new StringBuilder();
        Thread errPump = drain(process, stderr);
        long deadline = System.currentTimeMillis() + props.getTools().getTimeoutMinutes() * 60_000L;
        int lastReported = -1;

        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (System.currentTimeMillis() > deadline) {
                    process.destroyForcibly();
                    errPump.join(2000);
                    throw new IOException("Transcode exceeded "
                            + props.getTools().getTimeoutMinutes() + " minutes and was cancelled.");
                }
                Double seconds = parseProgressSeconds(line);
                if (seconds != null && durationSeconds > 0) {
                    int percent = (int) Math.min(99, Math.max(0, seconds / durationSeconds * 100));
                    if (percent != lastReported) {
                        lastReported = percent;
                        // The callback is also the abort channel — the segment drain raises here
                        // when it runs out of storage budget. Without destroying the process first,
                        // an escaping exception would close our end of the pipes and leave ffmpeg
                        // running unattended for the rest of the encode, burning the CPU of a host
                        // that has just proven it has none to spare.
                        try {
                            progress.accept(percent);
                        } catch (RuntimeException ex) {
                            process.destroyForcibly();
                            errPump.join(2000);
                            throw ex;
                        }
                    }
                }
            }
        }
        boolean finished = process.waitFor(Math.max(1, (deadline - System.currentTimeMillis()) / 1000),
                                          TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            errPump.join(2000);
            throw new IOException("Transcode timed out.");
        }
        errPump.join(2000);
        return new ProcessResult(process.exitValue(), "", stderr.toString());
    }

    private Double parseProgressSeconds(String line) {
        if (line.startsWith("out_time_us=") || line.startsWith("out_time_ms=")) {
            // Both keys are microseconds in practice (out_time_ms is a long-standing ffmpeg
            // misnomer), so scale identically; "N/A" appears before the first frame.
            String value = line.substring(line.indexOf('=') + 1).trim();
            try {
                return Long.parseLong(value) / 1_000_000.0;
            } catch (NumberFormatException ex) {
                return null;
            }
        }
        return null;
    }

    /**
     * ffmpeg writes its log to stderr continuously; if nobody reads it the OS pipe buffer fills
     * and ffmpeg blocks forever. Drain it on its own thread and keep the tail for diagnostics.
     */
    private Thread drain(Process process, StringBuilder sink) {
        Thread thread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    synchronized (sink) {
                        sink.append(line).append('\n');
                        if (sink.length() > 8000) sink.delete(0, sink.length() - 4000);
                    }
                }
            } catch (IOException ignored) {
                // Process died; nothing more to read.
            }
        }, "ffmpeg-stderr");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }
}
