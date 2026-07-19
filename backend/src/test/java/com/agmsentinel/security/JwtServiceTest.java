package com.agmsentinel.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class JwtServiceTest {

    @Test
    void parsesTokensSignedWithLegacySecretWhenConfigured() {
        JwtService service = new JwtService(
                "primary-secret-value-that-is-long-enough",
                "legacy-secret-value-that-is-long-enough",
                "",
                3600
        );

        String token = Jwts.builder()
                .subject("alice")
                .claim("role", "MODERATOR")
                .claim("typ", "access")
                .signWith(Keys.hmacShaKeyFor("legacy-secret-value-that-is-long-enough".getBytes(StandardCharsets.UTF_8)))
                .compact();

        Claims claims = service.parse(token);

        assertNotNull(claims);
        assertEquals("alice", claims.getSubject());
        assertEquals("MODERATOR", claims.get("role", String.class));
    }
}
