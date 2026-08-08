package com.agmsentinel.security;

import io.jsonwebtoken.Claims;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

@Component
public class JwtAuthFilter extends OncePerRequestFilter {

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
            } catch (Exception ignored) {
                // Invalid token → stays unauthenticated; protected routes will 401.
            }
        }
        chain.doFilter(request, response);
    }
}
