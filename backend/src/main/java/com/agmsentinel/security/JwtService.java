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
import java.util.Collection;
import java.util.Date;
import java.util.List;

@Service
public class JwtService {

    /** {@code typ} claim of a media playback ticket (see PlaybackTicketService). */
    public static final String PLAYBACK_TYPE = "playback";

    private final List<SecretKey> keys = new ArrayList<>();

    /**
     * How long a token stays valid — and therefore how long a session survives with no activity,
     * since the client renews the token while the user is active.
     */
    private final long ttlSeconds;

    /** Ceiling on total session length regardless of activity. 0 disables the cap. */
    private final long maxSessionSeconds;

    public JwtService(
            @Value("${jwt.secret:change-me-to-a-long-random-string-in-prod-please}") String secret,
            @Value("${jwt.legacy-secret:}") String legacySecret,
            @Value("${jwt.legacy-secrets:}") String legacySecrets,
            @Value("${jwt.ttl-seconds:28800}") long ttlSeconds,
            @Value("${jwt.max-session-seconds:86400}") long maxSessionSeconds) {
        registerKey(secret);
        registerKey(legacySecret);
        for (String candidate : splitSecrets(legacySecrets)) {
            registerKey(candidate);
        }
        if (this.keys.isEmpty()) {
            throw new IllegalArgumentException("At least one JWT signing secret must be configured.");
        }
        this.ttlSeconds = ttlSeconds;
        this.maxSessionSeconds = maxSessionSeconds;
    }

    /** The inactivity window in seconds, so the client can size its renewal cadence from it. */
    public long ttlSeconds() {
        return ttlSeconds;
    }

    /** {@code ost} claim: when the session originally began, preserved across refreshes. */
    public static final String SESSION_START = "ost";

    /**
     * {@code vbc} claim: this session was established by verifying a one-time code.
     *
     * <p>The only thing it permits is setting a password without the old one, and only briefly
     * after issue. Somebody recovering an account has no old password to supply and has just spent
     * the code proving they control the registered address — this records that fact so the password
     * step can trust it without asking them to prove it twice.
     */
    public static final String VERIFIED_BY_CODE = "vbc";

    /** Whether a token carries {@link #VERIFIED_BY_CODE}. */
    public static boolean verifiedByCode(Claims claims) {
        return Boolean.TRUE.equals(claims.get(VERIFIED_BY_CODE, Boolean.class));
    }

    /** When the token was issued, for bounding how long that verification stays good for. */
    public static Instant issuedAt(Claims claims) {
        Date issued = claims.getIssuedAt();
        return issued == null ? Instant.EPOCH : issued.toInstant();
    }

    /** Full access token — granted only after password (+ MFA, if enrolled) succeeds. */
    public String issue(String subject, String role) {
        Instant now = Instant.now();
        return build(subject, role, now, now.getEpochSecond());
    }

    /**
     * Re-issue an access token with a fresh expiry — the mechanism behind the inactivity timeout.
     *
     * <p>The token's lifetime <em>is</em> the idle window: the client renews it while the user is
     * doing things, so a session ends when nobody has renewed it for {@code jwt.ttl-seconds}. That
     * keeps the timeout enforced by the server on a stateless token, with no session table to
     * maintain and nothing to clean up — an abandoned session simply stops being renewed.
     *
     * <p>{@code ost} rides along unchanged so a sliding session cannot renew itself forever. Without
     * it, a browser left open on a shared machine would stay signed in indefinitely, which is the
     * standard objection to sliding expiry and the reason for the absolute cap below.
     *
     * @throws JwtException if this is not an access token, or the session is older than the cap
     */
    public String refresh(Claims claims) {
        if (!"access".equals(claims.get("typ", String.class))) {
            throw new JwtException("Only an access token can be refreshed.");
        }
        Instant now = Instant.now();
        long sessionStart = sessionStartOf(claims);
        if (maxSessionSeconds > 0 && now.getEpochSecond() - sessionStart > maxSessionSeconds) {
            throw new JwtException("This session has reached its maximum length and must be renewed "
                                  + "by signing in again.");
        }
        // Carry the FULL role set forward. Renewal happens on activity, so building from the single
        // primary role here would quietly strip every additional duty within minutes of signing in —
        // a MEETING_MANAGER would lose the menu they just used.
        return build(claims.getSubject(), claims.get("role", String.class), rolesOf(claims),
                     now, sessionStart);
    }

    /** When the session began — falling back to this token's own issue time for older tokens. */
    private long sessionStartOf(Claims claims) {
        Object raw = claims.get(SESSION_START);
        if (raw instanceof Number number) return number.longValue();
        // Tokens issued before `ost` existed: treat this token as the start rather than refusing to
        // refresh, so a deploy does not sign everybody out mid-session.
        return claims.getIssuedAt() == null
                ? Instant.now().getEpochSecond()
                : claims.getIssuedAt().toInstant().getEpochSecond();
    }

    /**
     * Issue a token carrying every role the holder has.
     *
     * <p>{@code role} (singular, the primary) is still written, and is what
     * {@link #issue(String, String)} sets on its own. {@code roles} is the full set. Both are
     * present so the change is safe in either direction: a token minted before this existed has only
     * {@code role} and still authenticates, and a token minted now still satisfies anything reading
     * {@code role}.
     */
    public String issue(String subject, String primaryRole, Collection<String> allRoles) {
        Instant now = Instant.now();
        return build(subject, primaryRole, allRoles, now, now.getEpochSecond(), false);
    }

    /**
     * Issue a token for a session that began by verifying a one-time code.
     *
     * <p>Carries {@link #VERIFIED_BY_CODE}, which lets the holder set a new password without
     * supplying the old one — necessary, because somebody who has just recovered an account by
     * email has no old password to give, and the code was consumed proving who they are.
     *
     * <p>The claim is <b>not</b> a lasting privilege. It is only honoured for a few minutes after
     * issue (see {@code AuthService.changePassword}), so a token left in a browser overnight cannot
     * still rewrite the password tomorrow. It also does not survive {@link #refresh}: a renewed
     * session is no longer "just verified".
     */
    public String issueAfterCodeVerification(String subject, String primaryRole,
                                             Collection<String> allRoles) {
        Instant now = Instant.now();
        return build(subject, primaryRole, allRoles, now, now.getEpochSecond(), true);
    }

    private String build(String subject, String role, Instant now, long sessionStart) {
        return build(subject, role, List.of(role), now, sessionStart, false);
    }

    private String build(String subject, String role, Collection<String> allRoles,
                         Instant now, long sessionStart) {
        return build(subject, role, allRoles, now, sessionStart, false);
    }

    private String build(String subject, String role, Collection<String> allRoles,
                         Instant now, long sessionStart, boolean verifiedByCode) {
        List<String> roles = allRoles == null || allRoles.isEmpty()
                ? List.of(role)
                : allRoles.stream().filter(r -> r != null && !r.isBlank()).distinct().toList();
        return Jwts.builder()
                .subject(subject)
                .claim("role", role)
                .claim("roles", roles)
                .claim("typ", "access")
                .claim(SESSION_START, sessionStart)
                // Present only on a session that began with a one-time code, and deliberately
                // absent from refreshed tokens — see issueAfterCodeVerification.
                .claim(VERIFIED_BY_CODE, verifiedByCode ? Boolean.TRUE : null)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(ttlSeconds)))
                .signWith(currentKey())
                .compact();
    }

    /**
     * Every role in a token: the {@code roles} list when present, otherwise the single {@code role}.
     *
     * <p>The fallback is what lets tokens issued before this change keep working until they expire,
     * rather than signing everyone out on deploy.
     */
    @SuppressWarnings("unchecked")
    public static List<String> rolesOf(Claims claims) {
        Object raw = claims.get("roles");
        if (raw instanceof Collection<?> collection && !collection.isEmpty()) {
            return collection.stream().map(String::valueOf)
                    .filter(r -> !r.isBlank()).distinct().toList();
        }
        String single = claims.get("role", String.class);
        return single == null || single.isBlank() ? List.of() : List.of(single);
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
