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
                // Enrollment needs a full access token (more specific → declared first).
                .requestMatchers("/api/auth/enroll/**").hasAnyRole("MODERATOR", "ADMIN")
                // Public auth endpoints + Google OAuth2 handshake.
                .requestMatchers("/api/auth/**", "/oauth2/**", "/login/**",
                                 "/ws/**", "/actuator/health", "/health").permitAll()
                .requestMatchers("/api/source/**").permitAll()   // PDF opened in a new tab (no auth header)
                .requestMatchers("/api/questions/**").hasAnyRole("ATTENDEE", "SHAREHOLDER", "MODERATOR", "ADMIN")
                .requestMatchers("/api/clusters/**").hasAnyRole("MODERATOR", "ADMIN")
                .requestMatchers("/api/admin/**").hasAnyRole("MODERATOR", "ADMIN")
                // Shareholder Lounge: open to ANY authenticated member (attendees included) so
                // everyone can see the directory of registered users and use the chat / AI assistant.
                .requestMatchers("/api/chat/**").authenticated()
                // Member directory: any authenticated user may READ the roster; only
                // moderators/admins may CHANGE roles (PATCH /api/users/{id}/role).
                .requestMatchers(HttpMethod.GET, "/api/users").authenticated()
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

    /** Allow the Vercel-hosted Angular app (any origin in dev) to call the API. */
    @Bean
    public CorsConfigurationSource corsSource() {
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOriginPatterns(List.of("*"));   // tighten to your Vercel domain in prod
        cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        cfg.setAllowedHeaders(List.of("*"));
        cfg.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cfg);
        return source;
    }
}
