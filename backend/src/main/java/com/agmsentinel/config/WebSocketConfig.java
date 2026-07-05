package com.agmsentinel.config;

import com.agmsentinel.security.WebSocketAuthInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.*;

/**
 * STOMP-over-WebSocket. Two uses:
 *   • Moderators subscribe to /topic/board for the live cluster board (public, broadcast).
 *   • Logged-in shareholders subscribe to /user/queue/messages for 1-on-1 chat and
 *     /topic/presence for online status.
 * SockJS fallback keeps it working behind proxies / on hosts without raw WS upgrade.
 */
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private final WebSocketAuthInterceptor authInterceptor;

    public WebSocketConfig(WebSocketAuthInterceptor authInterceptor) {
        this.authInterceptor = authInterceptor;
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic", "/queue");  // in-memory broker (free, no external)
        registry.setApplicationDestinationPrefixes("/app");
        registry.setUserDestinationPrefix("/user");        // convertAndSendToUser → /user/queue/**
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
                .setAllowedOriginPatterns("*")
                .withSockJS();
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        // Authenticate the STOMP CONNECT frame from its JWT (lenient — see the interceptor).
        registration.interceptors(authInterceptor);
    }
}
