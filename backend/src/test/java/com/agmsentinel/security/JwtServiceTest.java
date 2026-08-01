package com.agmsentinel.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class JwtServiceTest {

    private static final String SECRET = "primary-secret-value-that-is-long-enough";
    private static final String LEGACY = "legacy-secret-value-that-is-long-enough";

    /** 1 h idle window, 24 h absolute cap — the shape of the real config, scaled down. */
    private JwtService service() {
        return new JwtService(SECRET, LEGACY, "", 3600, 86_400);
    }

    @Test
    void parsesTokensSignedWithLegacySecretWhenConfigured() {
        String token = Jwts.builder()
                .subject("alice")
                .claim("role", "MODERATOR")
                .claim("typ", "access")
                .signWith(Keys.hmacShaKeyFor(LEGACY.getBytes(StandardCharsets.UTF_8)))
                .compact();

        Claims claims = service().parse(token);

        assertNotNull(claims);
        assertEquals("alice", claims.getSubject());
        assertEquals("MODERATOR", claims.get("role", String.class));
    }

    @Test
    void refreshKeepsIdentityAndDoesNotShortenTheWindow() {
        JwtService service = service();
        Claims original = service.parse(service.issue("alice", "MODERATOR"));

        Claims renewed = service.parse(service.refresh(original));

        assertEquals("alice", renewed.getSubject());
        assertEquals("MODERATOR", renewed.get("role", String.class));
        // The renewal is what turns an expiring token into an idle timeout, so it must never hand
        // back something that dies sooner than what it replaced.
        assertFalse(renewed.getExpiration().before(original.getExpiration()),
                    "a renewed token must not expire earlier than the one it replaced");
    }

    @Test
    void refreshPreservesTheOriginalSessionStart() {
        JwtService service = service();
        Claims first = service.parse(service.issue("alice", "MODERATOR"));
        Claims third = service.parse(service.refresh(service.parse(service.refresh(first))));

        // Without this the absolute cap could never be reached: every renewal would look brand new,
        // and a sliding session would renew itself forever.
        assertEquals(first.get(JwtService.SESSION_START, Long.class),
                     third.get(JwtService.SESSION_START, Long.class));
    }

    @Test
    void refreshIsRefusedOnceTheAbsoluteCapIsPassed() {
        // 10 s cap, so a session that began a minute ago is already past it.
        JwtService service = new JwtService(SECRET, "", "", 3600, 10);
        Claims stale = service.parse(Jwts.builder()
                .subject("alice")
                .claim("role", "MODERATOR")
                .claim("typ", "access")
                .claim(JwtService.SESSION_START, Instant.now().minusSeconds(60).getEpochSecond())
                .expiration(Date.from(Instant.now().plusSeconds(3600)))
                .signWith(Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8)))
                .compact());

        assertThrows(JwtException.class, () -> service.refresh(stale));
    }

    @Test
    void aPlaybackTicketCannotBeTradedForASession() {
        JwtService service = service();
        Claims ticket = service.parse(service.issuePlaybackTicket("alice", "video-1", 600));

        // A ticket rides in a URL, so it leaks far more easily than a bearer token. Being able to
        // exchange one for a full session would turn that leak into a login.
        assertThrows(JwtException.class, () -> service.refresh(ticket));
    }
}
