package com.agmsentinel.security;

import io.jsonwebtoken.Claims;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Authenticates the STOMP CONNECT frame from a JWT so user-targeted delivery
 * (convertAndSendToUser → /user/queue/**) knows who is connected.
 *
 * Deliberately LENIENT: if there is no valid token we let the connection through anonymously
 * (with no Principal). This keeps the pre-existing public board — BoardService connects with no
 * auth headers — working unchanged; only 1-on-1 chat needs an identity.
 */
@Component
public class WebSocketAuthInterceptor implements ChannelInterceptor {

    private final JwtService jwt;

    public WebSocketAuthInterceptor(JwtService jwt) {
        this.jwt = jwt;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor =
                MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);

        if (accessor != null && StompCommand.CONNECT.equals(accessor.getCommand())) {
            String bearer = accessor.getFirstNativeHeader("Authorization");
            if (bearer != null && bearer.startsWith("Bearer ")) {
                try {
                    Claims claims = jwt.parse(bearer.substring(7));
                    String role = claims.get("role", String.class);
                    // Full access tokens only — MFA-challenge tokens carry no role and must not
                    // authenticate a socket.
                    if (!jwt.isMfaChallenge(claims) && role != null) {
                        var auth = new UsernamePasswordAuthenticationToken(
                                claims.getSubject(), null,
                                List.of(new SimpleGrantedAuthority("ROLE_" + role)));
                        accessor.setUser(auth);   // Principal.getName() == username → user-queue routing
                    }
                } catch (Exception ignored) {
                    // Invalid token → stay anonymous; the connection is still allowed.
                }
            }
        }
        return message;
    }
}
