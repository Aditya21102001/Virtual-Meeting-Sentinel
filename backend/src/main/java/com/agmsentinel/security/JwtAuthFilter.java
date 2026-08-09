package com.agmsentinel.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.JwtException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * Turns a {@code Bearer} token into an authenticated Spring Security context, once per request.
 *
 * <p>Presenting no token, or a bad one, is not an error here — the request simply continues
 * unauthenticated and any protected route answers 401. That is what lets the public endpoints
 * (health, attendee sign-in, the OAuth callback) still work when a browser sends a stale header,
 * which happens more often than one might expect.
 *
 * <p>Only <b>full access tokens</b> authenticate. MFA challenges and video playback tickets are
 * deliberately excluded — see the check below.
 */
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    // Named `log`, not `logger`: GenericFilterBean already inherits a commons-logging field called
    // `logger`, and shadowing it would be a trap for the next person to edit this class.
    private static final Logger log = LoggerFactory.getLogger(JwtAuthFilter.class);

    private final JwtService jwt;

    public JwtAuthFilter(JwtService jwt) {
        this.jwt = jwt;
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest request,
                                    @NonNull HttpServletResponse response,
                                    @NonNull FilterChain chain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            try {
                Claims claims = jwt.parse(header.substring(7));
                String role = claims.get("role", String.class);
                // Only FULL access tokens authenticate. MFA-challenge tokens (typ=mfa, no role)
                // must never grant access — they only authorize the second-factor step. Likewise
                // media playback tickets (typ=playback, no role): they let one video's segments be
                // read and must never be usable as a session.
                boolean playbackTicket = JwtService.PLAYBACK_TYPE.equals(claims.get("typ", String.class));
                if (!jwt.isMfaChallenge(claims) && !playbackTicket && role != null) {
                    // Every role in the token, not just the primary — a MODERATOR who is also a
                    // MEETING_MANAGER must be granted both, or the second duty is invisible to
                    // Spring Security. rolesOf falls back to the single `role` claim for tokens
                    // issued before additional roles existed.
                    List<SimpleGrantedAuthority> authorities = JwtService.rolesOf(claims).stream()
                            .map(r -> new SimpleGrantedAuthority("ROLE_" + r))
                            .toList();
                    // The verified claims ride along as credentials. /api/auth/refresh-session needs
                    // them to carry the original session start (`ost`) into the renewed token — the
                    // subject and role alone would let a sliding session renew itself forever,
                    // because nothing would remember when it began.
                    var auth = new UsernamePasswordAuthenticationToken(
                            claims.getSubject(), claims, authorities);
                    SecurityContextHolder.getContext().setAuthentication(auth);
                }
            } catch (ExpiredJwtException expired) {
                // Routine, and deliberately DEBUG rather than WARN. Sessions lapse constantly —
                // every idle tab produces one of these — so logging it at WARN would bury the
                // entries below, which are the ones worth reading.
                log.debug("Expired token for {} on {}", expired.getClaims() == null
                        ? "an unknown subject" : expired.getClaims().getSubject(), request.getRequestURI());
            } catch (JwtException | IllegalArgumentException malformed) {
                // Not routine. A token that fails to parse or whose signature does not verify is
                // either a bug in how the client stores it, a truncated header, or somebody
                // presenting a forged one. Worth a WARN — and worth NOT logging the token itself,
                // which would put a credential in the log file.
                log.warn("Rejected an unparseable or unverified token on {}: {}",
                         request.getRequestURI(), malformed.getClass().getSimpleName());
            }
            // In both cases the request continues unauthenticated, and any protected route answers
            // 401. Refusing outright here would break the public endpoints, which are reached with
            // a stale header more often than one might expect.
        }
        chain.doFilter(request, response);
    }
}
