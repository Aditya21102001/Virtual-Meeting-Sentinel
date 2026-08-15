package com.agmsentinel.service;

import com.agmsentinel.config.VideoProperties;
import com.agmsentinel.service.VideoTranscodeService.MediaInfo;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Which rungs a source actually produces.
 *
 * <h2>Why this is worth pinning</h2>
 * "Only 360p and 480p appeared" was reported as a bug, and looked like one — the ladder is
 * configured for four heights. It is not: the ladder is capped to the source, so a 576p master
 * yields exactly those two. That behaviour is invisible from the outside and easy to "fix" by
 * accident, so it is asserted here, together with the flag that turns it off for anyone who wants
 * the fuller ladder anyway.
 */
class VideoLadderTest {

    /** Reads the private buildLadder, which is where the decision actually lives. */
    @SuppressWarnings("unchecked")
    private List<String> rungsFor(int sourceHeight, boolean upscale) {
        VideoProperties props = new VideoProperties();
        props.getHls().setUpscale(upscale);

        VideoTranscodeService service = new VideoTranscodeService(props);
        MediaInfo info = new MediaInfo(120.0, sourceHeight * 16 / 9, sourceHeight,
                                       25.0, true, "h264", "aac");

        Object ladder = ReflectionTestUtils.invokeMethod(service, "buildLadder", info);
        // getField, not invokeMethod: Rung is a record, and invokeMethod resolves "name" against
        // the wrong overload set for a record accessor.
        return ((List<Object>) ladder).stream()
                .map(rung -> String.valueOf(ReflectionTestUtils.getField(rung, "name")))
                .toList();
    }

    @Test
    @DisplayName("a 576p source produces 480p and 360p — the reported case, working as designed")
    void source576() {
        assertThat(rungsFor(576, false))
                .as("1080 and 720 are taller than the source, so they are skipped")
                .containsExactly("480p", "360p");
    }

    @Test
    @DisplayName("a 1080p source produces the whole ladder")
    void source1080() {
        assertThat(rungsFor(1080, false)).containsExactly("1080p", "720p", "480p", "360p");
    }

    @Test
    @DisplayName("a 720p source produces three rungs")
    void source720() {
        assertThat(rungsFor(720, false)).containsExactly("720p", "480p", "360p");
    }

    @Test
    @DisplayName("with upscaling on, a 576p source produces all four")
    void upscaleGivesTheFullLadder() {
        // What another encoder that does not cap would produce from the same file. Off by default,
        // because those extra rungs carry no more detail than the ones below them.
        assertThat(rungsFor(576, true)).containsExactly("1080p", "720p", "480p", "360p");
    }

    @Test
    @DisplayName("a source shorter than every configured rung still produces one")
    void tinySourceStillPlays() {
        // 144p is below the whole ladder. Returning nothing would mean a recording that cannot be
        // played at all, so the fallback emits a single rung at the source height.
        assertThat(rungsFor(144, false)).hasSize(1);
    }

    @Test
    @DisplayName("an unknown source height is not capped")
    void unknownHeightIsNotCapped() {
        // ffprobe failing to report a height must not silently reduce the ladder to nothing — the
        // cap is guarded on height > 0 for exactly this case.
        assertThat(rungsFor(0, false)).hasSize(4);
    }
}
