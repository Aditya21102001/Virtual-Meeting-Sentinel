package com.agmsentinel.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

@Service
public class JwtService {

    /** {@code typ} claim of a media playback ticket (see PlaybackTicketService). */
    public static final String PLAYBACK_TYPE = "playback";

    private final List<SecretKey> keys = new ArrayList<>();
    private final long ttlSeconds;

    public JwtService(
            @Value("${jwt.secret:change-me-to-a-long-random-string-in-prod-please}") String secret,
            @Value("${jwt.legacy-secret:}") String legacySecret,
            @Value("${jwt.legacy-secrets:}") String legacySecrets,
            @Value("${jwt.ttl-seconds:28800}") long ttlSeconds) {
        registerKey(secret);
        registerKey(legacySecret);
        for (String candidate : splitSecrets(legacySecrets)) {
            registerKey(candidate);
        }
        if (this.keys.isEmpty()) {
            throw new IllegalArgumentException("At least one JWT signing secret must be configured.");
        }
        this.ttlSeconds = ttlSeconds;
    }

    /** Full access token — granted only after password (+ MFA, if enrolled) succeeds. */
    public String issue(String subject, String role) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(subject)
                .claim("role", role)
                .claim("typ", "access")
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(ttlSeconds)))
                .signWith(currentKey())
                .compact();
    }

    /**
     * Short-lived intermediate token issued after a correct password when the user has MFA.
     * It grants NO access — it only authorizes completing the second factor.
     */
    public String issueMfaChallenge(String subject) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(subject)
                .claim("typ", "mfa")
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(300)))   // 5 minutes to finish MFA
                .signWith(currentKey())
                .compact();
    }

    /**
     * Media playback ticket: authorises GETs of ONE video's manifest and segments, nothing else.
     * A {@code <video>} element and Safari's native HLS engine cannot send an Authorization
     * header, so this rides in the URL instead — which is why it is scoped to a single video id
     * and given a short life. {@code typ=playback} keeps {@link JwtAuthFilter} from ever treating
     * it as a login.
     */
    public String issuePlaybackTicket(String subject, String videoId, long ticketTtlSeconds) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(subject)
                .claim("typ", PLAYBACK_TYPE)
                .claim("vid", videoId)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(ticketTtlSeconds)))
                .signWith(currentKey())
                .compact();
    }

    public Claims parse(String token) {
        JwtException last = null;
        for (SecretKey candidate : keys) {
            try {
                return Jwts.parser().verifyWith(candidate).build().parseSignedClaims(token).getPayload();
            } catch (JwtException ex) {
                last = ex;
            }
        }
        throw last != null ? last : new JwtException("No JWT signing keys available.");
    }

    public boolean isMfaChallenge(Claims claims) {
        return "mfa".equals(claims.get("typ", String.class));
    }

    private SecretKey currentKey() {
        return keys.get(0);
    }

    private void registerKey(String secret) {
        if (secret != null && !secret.isBlank()) {
            keys.add(Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8)));
        }
    }

    private List<String> splitSecrets(String configured) {
        List<String> result = new ArrayList<>();
        if (configured == null || configured.isBlank()) {
            return result;
        }
        for (String part : configured.split(",")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) {
                result.add(trimmed);
            }
        }
        return result;
    }
}
