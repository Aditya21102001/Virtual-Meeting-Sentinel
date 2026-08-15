package com.agmsentinel.controller;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Carrying the playback ticket onto every URI a player will request.
 *
 * <h2>The case that matters</h2>
 * Segment URIs sit alone on their own lines, so "skip anything starting with #" rewrites them
 * correctly. The decryption key does not: it lives <em>inside</em> a tag,
 * {@code #EXT-X-KEY:METHOD=AES-128,URI="key"}. Skipped by that rule, the player requests the key
 * with no ticket, is refused, and the recording fails to decrypt — while every segment downloads
 * perfectly. Encryption looks broken; one line was simply not rewritten.
 */
class HlsPlaylistRewriterTest {

    private static final String TICKET = "eyJhbGciOiJIUzUxMiJ9.payload.signature";

    @Test
    @DisplayName("segment URIs carry the ticket")
    void segmentsGetTheTicket() {
        String playlist = """
                #EXTM3U
                #EXT-X-TARGETDURATION:6
                #EXTINF:6.000,
                seg_00000.ts
                #EXTINF:6.000,
                seg_00001.ts
                #EXT-X-ENDLIST
                """;

        String out = HlsPlaylistRewriter.appendTicket(playlist, TICKET);

        assertThat(out).contains("seg_00000.ts?t=" + TICKET);
        assertThat(out).contains("seg_00001.ts?t=" + TICKET);
    }

    @Test
    @DisplayName("the encryption key URI carries the ticket too")
    void keyTagGetsTheTicket() {
        String playlist = """
                #EXTM3U
                #EXT-X-KEY:METHOD=AES-128,URI="key"
                #EXTINF:6.000,
                seg_00000.ts
                """;

        String out = HlsPlaylistRewriter.appendTicket(playlist, TICKET);

        assertThat(out)
                .as("without this the key is fetched unauthenticated and playback fails silently")
                .contains("URI=\"key?t=" + TICKET + "\"");
        // The rest of the tag must survive intact, or the player cannot tell how to decrypt.
        assertThat(out).contains("METHOD=AES-128");
    }

    @Test
    @DisplayName("other attributes of the key tag are preserved, in place")
    void keyTagKeepsItsOtherAttributes() {
        String playlist = "#EXT-X-KEY:METHOD=AES-128,URI=\"key\",IV=0x9c7db8778570d05c3f4f9dcd9a1b7c8b\n";

        String out = HlsPlaylistRewriter.appendTicket(playlist, TICKET);

        assertThat(out).contains("URI=\"key?t=" + TICKET + "\"");
        assertThat(out)
                .as("the IV is what makes each segment decryptable; losing it loses the recording")
                .contains("IV=0x9c7db8778570d05c3f4f9dcd9a1b7c8b");
    }

    @Test
    @DisplayName("ordinary tags are left exactly as they were")
    void tagsAreUntouched() {
        String playlist = """
                #EXTM3U
                #EXT-X-VERSION:3
                #EXT-X-TARGETDURATION:6
                #EXTINF:6.000,
                seg_00000.ts
                """;

        String out = HlsPlaylistRewriter.appendTicket(playlist, TICKET);

        assertThat(out).contains("#EXT-X-VERSION:3");
        assertThat(out).doesNotContain("#EXT-X-VERSION:3?t=");
        assertThat(out).doesNotContain("#EXTINF:6.000,?t=");
    }

    @Test
    @DisplayName("a URI that already has a query gets & rather than a second ?")
    void existingQueryStringIsRespected() {
        String playlist = "#EXT-X-KEY:METHOD=AES-128,URI=\"key?v=2\"\nseg_00000.ts?v=2\n";

        String out = HlsPlaylistRewriter.appendTicket(playlist, TICKET);

        assertThat(out).contains("URI=\"key?v=2&t=" + TICKET + "\"");
        assertThat(out).contains("seg_00000.ts?v=2&t=" + TICKET);
        assertThat(out).doesNotContain("??");
    }

    @Test
    @DisplayName("no ticket means no rewriting")
    void withoutATicketThePlaylistIsUnchanged() {
        String playlist = "#EXTM3U\nseg_00000.ts\n";

        assertThat(HlsPlaylistRewriter.appendTicket(playlist, null)).isEqualTo(playlist);
        assertThat(HlsPlaylistRewriter.appendTicket(playlist, "  ")).isEqualTo(playlist);
    }

    @Test
    @DisplayName("a malformed key tag is left alone rather than mangled")
    void keyTagWithoutAUriIsLeftAlone() {
        String playlist = "#EXT-X-KEY:METHOD=NONE\nseg_00000.ts\n";

        String out = HlsPlaylistRewriter.appendTicket(playlist, TICKET);

        assertThat(out).contains("#EXT-X-KEY:METHOD=NONE");
        assertThat(out).contains("seg_00000.ts?t=" + TICKET);
    }
}
