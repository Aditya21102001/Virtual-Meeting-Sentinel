package com.agmsentinel.service;

import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.messaging.SessionConnectedEvent;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.context.event.EventListener;

import java.security.Principal;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tracks which shareholders are currently connected over WebSocket (WhatsApp-style online dots).
 * In-memory is fine for the single-instance free tier (mirrors WebAuthnService's approach).
 * Broadcasts every change to /topic/presence so open Lounge clients update live.
 */
@Service
public class PresenceService {

    private final SimpMessagingTemplate broker;
    // username -> active session count (a user may have multiple tabs open).
    private final Map<String, Integer> sessions = new ConcurrentHashMap<>();

    public PresenceService(SimpMessagingTemplate broker) {
        this.broker = broker;
    }

    public Set<String> online() {
        return sessions.keySet();
    }

    public boolean isOnline(String username) {
        return sessions.containsKey(username);
    }

    @EventListener
    public void onConnect(SessionConnectedEvent event) {
        String user = usernameOf(event.getUser());
        if (user == null) return;                     // anonymous board viewer — not tracked
        sessions.merge(user, 1, Integer::sum);
        broadcast(user, true);
    }

    @EventListener
    public void onDisconnect(SessionDisconnectEvent event) {
        Principal p = StompHeaderAccessor.wrap(event.getMessage()).getUser();
        String user = usernameOf(p);
        if (user == null) return;
        Integer remaining = sessions.computeIfPresent(user, (k, n) -> n <= 1 ? null : n - 1);
        if (remaining == null) {
            broadcast(user, false);                    // last tab closed → offline
        }
    }

    private void broadcast(String user, boolean online) {
        broker.convertAndSend("/topic/presence", Map.of("user", user, "online", online));
    }

    private static String usernameOf(Principal p) {
        return p == null ? null : p.getName();
    }
}
