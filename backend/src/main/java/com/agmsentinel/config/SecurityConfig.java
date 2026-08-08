package com.agmsentinel.config;

import com.agmsentinel.security.JwtAuthFilter;
import com.agmsentinel.security.OAuth2SuccessHandler;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.*;

import java.util.List;

@Configuration
public class SecurityConfig {

    private final JwtAuthFilter jwtAuthFilter;

    public SecurityConfig(JwtAuthFilter jwtAuthFilter) {
        this.jwtAuthFilter = jwtAuthFilter;
    }

    @Bean
    public SecurityFilterChain filterChain(
            HttpSecurity http,
            ObjectProvider<ClientRegistrationRepository> clientRegistrations,
            ObjectProvider<OAuth2SuccessHandler> oauthSuccess) throws Exception {
        http
            .csrf(AbstractHttpConfigurer::disable)
            .cors(cors -> cors.configurationSource(corsSource()))
            // Distinguish "not authenticated" from "forbidden": a missing/expired/invalid JWT
            // must return 401 (so the SPA knows the session is dead and can prompt re-login),
            // NOT 403. Spring's default returns 403 for both, which made an expired token look
            // like a permission problem on the upload endpoint.
            .exceptionHandling(ex -> ex.authenticationEntryPoint((request, response, authEx) -> {
                response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                response.setContentType("application/json");
                response.getWriter().write("{\"error\":\"Authentication required or session expired.\"}");
            }))
            // IF_REQUIRED (not STATELESS): the OAuth2 redirect flow needs a short-lived session
            // to hold its state. JWT-authenticated API calls remain stateless.
            .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
            .authorizeHttpRequests(auth -> auth
                // Let internal ERROR forwards render (so a thrown 401 stays 401, not 403).
                .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
                // CORS preflight requests do not carry the bearer token used by the actual call.
                .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                // Enrollment needs a full access token (more specific → declared first).
                .requestMatchers("/api/auth/enroll/**").hasAnyRole("MODERATOR", "ADMIN")
                // Renewing a session requires a live one. Declared ahead of the public
                // /api/auth/** rule so a missing or lapsed token is answered with 401 here —
                // an expired session that could still renew itself would not be a timeout.
                .requestMatchers("/api/auth/refresh-session").authenticated()
                // Public auth endpoints + Google OAuth2 handshake.
                // /health and /health/ai are public so an external uptime monitor can reach them
                // without a token — and /health/ai doubles as the wake-up call that keeps a
                // free-tier AI service from sleeping. See HealthController.
                .requestMatchers("/api/auth/**", "/oauth2/**", "/login/**",
                                 "/ws/**", "/actuator/health",
                                 "/health", "/health/**", "/api/health").permitAll()
                .requestMatchers("/api/source/**").permitAll()   // PDF opened in a new tab (no auth header)
                // Media URLs are fetched by the browser's own media stack (<video src>, native HLS,
                // <img> posters), which cannot attach an Authorization header. They are permitted
                // here and authorised inside VideoController by a short-lived, video-scoped
                // playback ticket — see PlaybackTicketService. GET only: nothing is mutated, and
                // these are the only video routes that are not POST for exactly that reason.
                .requestMatchers(HttpMethod.GET,
                                 "/api/videos/*/master.m3u8",
                                 "/api/videos/*/r/**",
                                 "/api/videos/*/raw",
                                 "/api/videos/*/poster.jpg",
                                 "/api/videos/*/sprite.jpg",
                                 // Captions: fetched by a <track> element, same constraint again.
                                 "/api/videos/*/transcript.vtt",
                                 // Save-to-disk. A download is a browser navigation, so it carries
                                 // no Authorization header either and authorises the same way.
                                 "/api/videos/*/download").permitAll()
                // The catalogue + segment index need a real session (any signed-in member).
                .requestMatchers("/api/videos/**").authenticated()
                // Meetings. Two duties, two roles — and the order below is load-bearing, because
                // the catch-all at the end would otherwise swallow the more permissive rules.
                //
                // Any signed-in user may ask which meeting is live: the board, the question form
                // and the library all need to know, and it is not privileged information.
                // Feature flags. Every signed-in user may ask what THEY can use, so the SPA can
                // avoid rendering a menu entry for something switched off. Changing what a
                // deployment can do is administration, so the rest is ADMIN's alone.
                .requestMatchers("/api/features/my-features").authenticated()
                .requestMatchers("/api/features/**").hasRole("ADMIN")
                .requestMatchers("/api/meetings/active-meeting").authenticated()
                // Both managers may read the schedule and see who is mapped to a meeting.
                .requestMatchers("/api/meetings/list-meetings", "/api/meetings/list-members")
                        .hasAnyRole("MEETING_MANAGER", "USER_MANAGER", "ADMIN")
                // Mapping users to meetings is the USER_MANAGER's job.
                .requestMatchers("/api/meetings/add-member", "/api/meetings/remove-member")
                        .hasAnyRole("USER_MANAGER", "ADMIN")
                // Everything else — create, update, activate, close, delete — is the
                // MEETING_MANAGER's.
                .requestMatchers("/api/meetings/**").hasAnyRole("MEETING_MANAGER", "ADMIN")
                // Voting. NOT `authenticated()` — and this is the most important rule in this file.
                //
                // ATTENDEE tokens are anonymous and self-asserted: /api/auth/attendee is public and
                // issues a token whose subject is whatever username the caller typed. That is
                // harmless for asking a question, where the name is just a label. It is fatal for a
                // ballot: anyone could request a token as "alice" and cast alice's vote. So voting
                // is restricted to roles that require a real, verified account, and ATTENDEE is
                // excluded here rather than filtered later.
                //
                // Being allowed to *ask* is still not the same as being entitled to vote —
                // entitlement comes from the meeting's member list and is checked in VotingService,
                // which is the only place that knows what a member's holding is.
                .requestMatchers("/api/voting/list-resolutions", "/api/voting/resolution-details",
                                 "/api/voting/cast-vote", "/api/voting/my-vote",
                                 "/api/voting/meeting-quorum")
                        .hasAnyRole("SHAREHOLDER", "MODERATOR", "ADMIN")
                // Putting a motion, opening the floor and closing it are the chair's acts.
                .requestMatchers("/api/voting/**").hasAnyRole("MODERATOR", "ADMIN")
                // Reports gather a whole meeting into one document, including the questions nobody
                // answered. That is a moderator's working record before it is anything else.
                .requestMatchers("/api/reports/**").hasAnyRole("MODERATOR", "ADMIN")
                // The room. Attendees may see the ranked topics and add their support — both are
                // open to an anonymous pass, because an upvote ranks a discussion topic and decides
                // nothing. (Contrast /api/voting, which refuses that same token.) Ordering the
                // agenda and publishing an answer to the room are the chair's, so they come after.
                .requestMatchers("/api/room/attendee-board", "/api/room/support-topic")
                        .hasAnyRole("ATTENDEE", "SHAREHOLDER", "MODERATOR", "ADMIN")
                .requestMatchers("/api/room/**").hasAnyRole("MODERATOR", "ADMIN")
                .requestMatchers("/api/questions/**").hasAnyRole("ATTENDEE", "SHAREHOLDER", "MODERATOR", "ADMIN")
                .requestMatchers("/api/clusters/**").hasAnyRole("MODERATOR", "ADMIN")
                .requestMatchers("/api/admin/**").hasAnyRole("MODERATOR", "ADMIN")
                // Shareholder Lounge: open to ANY authenticated member (attendees included) so
                // everyone can see the directory of registered users and use the chat / AI assistant.
                .requestMatchers("/api/chat/**").authenticated()
                // Member directory: any authenticated user may READ the roster; only
                // moderators/admins may CHANGE roles. Both are POST now, so the two are told apart
                // by path rather than by method — list-members first, since the /** rule below
                // would otherwise swallow it.
                .requestMatchers("/api/users/list-members").authenticated()
                // Granting MEETING_MANAGER or USER_MANAGER is granting authority, so it is ADMIN's
                // alone — a moderator promoting themselves to meeting manager would make the
                // separation of duties decorative.
                .requestMatchers("/api/users/set-member-extra-roles").hasRole("ADMIN")
                .requestMatchers("/api/users/**").hasAnyRole("MODERATOR", "ADMIN")
                .anyRequest().authenticated())
            .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class);

        // Enable "Sign in with Google" ONLY when a client registration is configured
        // (i.e. GOOGLE_CLIENT_ID/SECRET are set). Otherwise the app still starts normally.
        if (clientRegistrations.getIfAvailable() != null) {
            OAuth2SuccessHandler handler = oauthSuccess.getObject();
            http.oauth2Login(oauth -> oauth.successHandler(handler));
        }
        return http.build();
    }

    /** BCrypt for password + PIN hashing. */
    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    /** Allow the deployed SPA and local Angular development servers to call the API. */
    @Bean
    public CorsConfigurationSource corsSource() {
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOrigins(List.of(
                "https://virtual-meeting-sentinel.vercel.app",
                "http://localhost:4200",
                "http://127.0.0.1:4200"));
        // The API is POST-only; GET remains for media and PDF sources, which the browser fetches
        // itself. PUT/PATCH/DELETE are no longer used by anything, so they are not advertised —
        // a preflight for one now fails loudly instead of reaching a route that would 405.
        cfg.setAllowedMethods(List.of("GET", "POST", "OPTIONS"));
        cfg.setAllowedHeaders(List.of("*"));
        cfg.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cfg);
        return source;
    }
}
