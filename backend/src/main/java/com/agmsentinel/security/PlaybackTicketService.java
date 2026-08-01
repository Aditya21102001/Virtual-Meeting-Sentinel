package com.agmsentinel.security;

import com.agmsentinel.config.VideoProperties;
import io.jsonwebtoken.Claims;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * Authorises media URLs that cannot carry an {@code Authorization} header.
 *
 * <p>The player fetches manifests and segments through the browser's own media stack — a
 * {@code <video src>} for progressive playback, and Safari's native HLS engine for the manifest.
 * Neither lets us attach a bearer token. So an authenticated request first exchanges its JWT for a
 * <b>playback ticket</b> — a short-lived token, signed with the same key and scoped to one video id
 * — and every media URL carries it as {@code ?t=…}.
 *
 * <p>Properties that matter: it expires (a copied URL stops working), it is bound to a single video
 * (a ticket for one recording cannot open another), and it grants read-only media access and
 * nothing else, because {@link JwtAuthFilter} refuses to authenticate a token whose {@code typ} is
 * not {@code access}.
 */
@Service
public class PlaybackTicketService {

    private final JwtService jwt;
    private final VideoProperties props;

    public PlaybackTicketService(JwtService jwt, VideoProperties props) {
        this.jwt = jwt;
        this.props = props;
    }

    public String issue(String subject, UUID videoId) {
        return jwt.issuePlaybackTicket(subject, videoId.toString(),
                props.getPlayback().getTicketTtlSeconds());
    }

    public long ttlSeconds() {
        return props.getPlayback().getTicketTtlSeconds();
    }

    /**
     * True when {@code ticket} is a valid, unexpired playback ticket for {@code videoId}.
     * Any parse or signature failure is simply "not valid" — the caller turns that into a 403.
     */
    public boolean isValidFor(String ticket, UUID videoId) {
        if (ticket == null || ticket.isBlank()) return false;
        try {
            Claims claims = jwt.parse(ticket);
            return JwtService.PLAYBACK_TYPE.equals(claims.get("typ", String.class))
                    && videoId.toString().equals(claims.get("vid", String.class));
        } catch (Exception ex) {
            return false;
        }
    }

    /** Who the ticket was issued to, for access logging. */
    public String subjectOf(String ticket) {
        try {
            return jwt.parse(ticket).getSubject();
        } catch (Exception ex) {
            return null;
        }
    }
}
