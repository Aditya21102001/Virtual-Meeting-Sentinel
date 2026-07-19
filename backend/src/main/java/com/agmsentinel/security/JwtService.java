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
