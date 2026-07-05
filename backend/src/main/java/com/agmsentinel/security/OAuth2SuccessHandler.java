package com.agmsentinel.security;

import com.agmsentinel.service.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.web.authentication.AuthenticationSuccessHandler;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * After Google verifies the user, mint our own JWT and bounce the browser back to the
 * frontend with the token in the URL. The SPA reads it and stores the session. This keeps the
 * frontend (Vercel) and backend (Render) on separate domains without shared cookies.
 */
@Component
public class OAuth2SuccessHandler implements AuthenticationSuccessHandler {

    private final AuthService auth;
    private final String frontendUrl;

    public OAuth2SuccessHandler(AuthService auth,
                                @Value("${app.frontend-url:http://localhost:4200}") String frontendUrl) {
        this.auth = auth;
        this.frontendUrl = frontendUrl;
    }

    @Override
    public void onAuthenticationSuccess(HttpServletRequest request, HttpServletResponse response,
                                        Authentication authentication) throws IOException {
        OAuth2User user = (OAuth2User) authentication.getPrincipal();
        String email = (String) user.getAttributes().get("email");
        String name = (String) user.getAttributes().get("name");

        String token = auth.oauthLogin(email, name);
        String target = frontendUrl + "/login?token=" + URLEncoder.encode(token, StandardCharsets.UTF_8);
        response.sendRedirect(target);
    }
}
