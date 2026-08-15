package com.agmsentinel.controller;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Rewrites an HLS playlist on the way out so every URI in it carries the playback ticket.
 *
 * <h2>Why this is needed at all</h2>
 * A playlist refers to its segments by relative URI, and a relative URI is resolved <b>without</b>
 * the query string of the playlist it came from. So a player that fetched
 * {@code index.m3u8?t=<ticket>} then asks for {@code seg_00001.ts} — with no ticket, and is refused.
 * Rewriting on the way out is what carries authorisation forward.
 *
 * <h2>The line that is easy to miss</h2>
 * Every URI in a playlist sits alone on its own line, with one exception:
 *
 * <pre>
 * #EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x...
 * </pre>
 *
 * It is a tag, so the obvious "skip lines starting with #" rule skips it — and then the decryption
 * key is requested without a ticket, answered 401, and the recording fails to play with nothing on
 * screen explaining why. Encryption appears to have broken playback, when in fact one line was not
 * rewritten.
 *
 * <p>A pure function in its own class rather than a private method, because that specific mistake is
 * worth a test of its own.
 */
final class HlsPlaylistRewriter {

    /** The {@code URI="..."} inside an #EXT-X-KEY tag. */
    private static final Pattern KEY_URI = Pattern.compile("URI=\"([^\"]*)\"");

    private HlsPlaylistRewriter() { }

    /**
     * Append {@code t=<ticket>} to every URI in the playlist — segment lines and the key tag alike.
     *
     * @return the playlist unchanged when there is no ticket to add
     */
    static String appendTicket(String playlist, String ticket) {
        if (playlist == null || ticket == null || ticket.isBlank()) return playlist;

        List<String> out = new ArrayList<>();
        for (String raw : playlist.split("\\r?\\n")) {
            String line = raw.trim();
            if (line.isEmpty()) {
                out.add(raw);
            } else if (line.startsWith("#EXT-X-KEY")) {
                out.add(appendToKeyTag(line, ticket));
            } else if (line.startsWith("#")) {
                out.add(raw);
            } else {
                out.add(line + separator(line) + "t=" + ticket);
            }
        }
        return String.join("\n", out) + "\n";
    }

    private static String appendToKeyTag(String tag, String ticket) {
        Matcher matcher = KEY_URI.matcher(tag);
        if (!matcher.find()) return tag;   // a key tag with no URI is malformed; leave it alone
        String uri = matcher.group(1);
        return tag.substring(0, matcher.start(1))
                + uri + separator(uri) + "t=" + ticket
                + tag.substring(matcher.end(1));
    }

    /** A URI may already carry a query string; appending a second '?' would break it. */
    private static String separator(String uri) {
        return uri.contains("?") ? "&" : "?";
    }
}
