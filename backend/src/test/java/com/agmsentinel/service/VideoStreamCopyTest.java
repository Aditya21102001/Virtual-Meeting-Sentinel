package com.agmsentinel.service;

import com.agmsentinel.config.VideoProperties;
import com.agmsentinel.service.VideoTranscodeService.MediaInfo;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The rung at the source's own height must be copied, not re-encoded.
 *
 * <h2>Why this is worth pinning</h2>
 * A recording came back looking worse than the same file played locally, while <em>growing</em> on
 * disk: a 19.8 MB upload produced a 21.1 MB 480p rendition. Both facts have one cause — H.264 was
 * being decoded and re-compressed at a bitrate the ladder guessed rather than the one the file was
 * made with. Copying removes the loss entirely, and the saving is invisible from the outside, so
 * the shape of the command is asserted here.
 */
class VideoStreamCopyTest {

    private final VideoTranscodeService service = new VideoTranscodeService(new VideoProperties());

    /** MediaInfo(duration, width, height, frameRate, hasAudio, videoCodec, audioCodec) */
    private MediaInfo source(int height, String videoCodec, String audioCodec) {
        return new MediaInfo(120.0, height * 16 / 9, height, 25.0, audioCodec != null,
                             videoCodec, audioCodec);
    }

    /**
     * The rung of a given height for this source. Taken from buildLadder rather than constructed,
     * so the bitrates and naming are whatever production would really use.
     */
    private Object rung(MediaInfo info, int height) {
        @SuppressWarnings("unchecked")
        List<Object> ladder = (List<Object>) ReflectionTestUtils.invokeMethod(
                service, "buildLadder", info);
        return ladder.stream()
                .filter(r -> String.valueOf(ReflectionTestUtils.getField(r, "name")).equals(height + "p"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no " + height + "p rung for this source"));
    }

    private List<String> commandFor(MediaInfo info, int rungHeight, Path keyInfo) {
        @SuppressWarnings("unchecked")
        List<String> cmd = (List<String>) ReflectionTestUtils.invokeMethod(
                service, "buildSingleRungCommand",
                Path.of("/tmp/hls"), Path.of("/tmp/in.mp4"), info, rung(info, rungHeight), keyInfo);
        return cmd;
    }

    private List<String> commandFor(MediaInfo info, int rungHeight) {
        return commandFor(info, rungHeight, null);
    }

    @Test
    @DisplayName("H.264 source at the rung's height is copied, never re-encoded")
    void nativeRungIsCopied() {
        List<String> cmd = commandFor(source(480, "h264", "aac"), 480);

        assertThat(cmd).containsSequence("-c:v", "copy");
        assertThat(cmd).as("re-encoding the source is the whole bug").doesNotContain("libx264");
        assertThat(cmd).as("no scaling when the height already matches").doesNotContain("-filter_complex");
    }

    @Test
    @DisplayName("AAC audio is copied alongside the video")
    void aacAudioIsCopied() {
        assertThat(commandFor(source(480, "h264", "aac"), 480)).containsSequence("-c:a", "copy");
    }

    @Test
    @DisplayName("non-AAC audio is converted while the video still copies")
    void nonAacAudioIsConvertedButVideoStillCopies() {
        List<String> cmd = commandFor(source(480, "h264", "opus"), 480);

        assertThat(cmd).containsSequence("-c:v", "copy");
        assertThat(cmd).as("only the audio needs converting").containsSequence("-c:a", "aac");
    }

    @Test
    @DisplayName("a smaller rung is still encoded — copying cannot resize")
    void smallerRungIsEncoded() {
        List<String> cmd = commandFor(source(480, "h264", "aac"), 360);

        assertThat(cmd).contains("libx264");
        assertThat(cmd).doesNotContain("copy");
    }

    @Test
    @DisplayName("a non-H.264 source is encoded even at its own height")
    void nonH264SourceIsEncoded() {
        // HLS carries H.264; a VP9 or MPEG-4 source has to be converted whatever its height.
        assertThat(commandFor(source(480, "vp9", "opus"), 480)).contains("libx264");
    }

    @Test
    @DisplayName("a copied rung carries no -force_key_frames")
    void copiedRungDoesNotForceKeyframes() {
        // ffmpeg fails outright if asked to place keyframes in a stream it is not encoding, so
        // this is the difference between a working command and a transcode that dies immediately.
        assertThat(commandFor(source(480, "h264", "aac"), 480))
                .doesNotContain("-force_key_frames:v");
    }

    @Test
    @DisplayName("a copied rung is still encrypted when a key is supplied")
    void copiedRungStillEncrypts() {
        // -hls_key_info_file is read by the muxer, downstream of the codec, so copying must not
        // quietly drop encryption — that would republish the exact failure verifyEncrypted exists
        // to prevent: a recording recorded as encrypted whose segments are in the clear.
        assertThat(commandFor(source(480, "h264", "aac"), 480, Path.of("/tmp/keys/key_info")))
                .contains("-hls_key_info_file");
    }

    @Test
    @DisplayName("a source with no audio produces no audio mapping")
    void silentSourceHasNoAudioArgs() {
        List<String> cmd = commandFor(source(480, "h264", null), 480);

        assertThat(cmd).containsSequence("-c:v", "copy");
        assertThat(cmd).doesNotContain("-c:a");
    }

    // ---- BANDWIDTH must describe the bytes that were actually written ----------------------

    private int measured(List<long[]> sizeAndDuration, int fallbackKbps) {
        List<VideoTranscodeService.SegmentInfo> segments = new java.util.ArrayList<>();
        int seq = 0;
        for (long[] sd : sizeAndDuration) {
            segments.add(new VideoTranscodeService.SegmentInfo(
                    seq++, "seg.ts", (double) sd[1], 0.0, sd[0]));
        }
        return ReflectionTestUtils.invokeMethod(service, "measuredKbps", segments, fallbackKbps);
    }

    @Test
    @DisplayName("BANDWIDTH is the PEAK segment bitrate, not the average")
    void bandwidthUsesPeakNotAverage() {
        // A 6 s segment of 750 000 bytes is 1000 kbps; one of 3 000 000 bytes is 4000 kbps.
        // Averaging would advertise ~2500 and a player would stall on the big one.
        int kbps = measured(List.of(new long[]{750_000, 6}, new long[]{3_000_000, 6}), 1400);

        assertThat(kbps).isEqualTo(4000);
    }

    @Test
    @DisplayName("a copied rung far above its ladder target is advertised honestly")
    void copiedRungAdvertisesItsRealBitrate() {
        // The whole ABR risk of stream copy: the ladder would have guessed 1400 kbps, but nothing
        // was encoded, so the rung carries whatever the upload was.
        assertThat(measured(List.of(new long[]{4_500_000, 6}), 1400)).isEqualTo(6000);
    }

    @Test
    @DisplayName("an unmeasurable playlist falls back rather than advertising zero")
    void unmeasurableFallsBack() {
        // BANDWIDTH=0 is not a valid variant; players may drop it entirely.
        assertThat(measured(List.of(new long[]{0, 6}, new long[]{750_000, 0}), 1400))
                .isEqualTo(1400);
        assertThat(measured(List.of(), 800)).isEqualTo(800);
    }
}
