package com.agmsentinel.controller;

import com.agmsentinel.dto.ChatDtos.TypingRequest;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;

import java.security.Principal;
import java.util.Map;

/**
 * STOMP message handler for ephemeral chat signals that don't need persistence.
 * Currently the "typing…" indicator: a client publishes to /app/typing with the peer it's
 * typing to, and we relay a one-shot event to that peer's user-queue. The sender is taken from
 * the authenticated WebSocket Principal (set by WebSocketAuthInterceptor), never the payload.
 */
@Controller
public class ChatSocketController {

    private final SimpMessagingTemplate broker;

    public ChatSocketController(SimpMessagingTemplate broker) {
        this.broker = broker;
    }

    @MessageMapping("/typing")
    public void typing(TypingRequest req, Principal from) {
        if (from == null) return;   // anonymous socket → ignore
        broker.convertAndSendToUser(req.to(), "/queue/typing", Map.of("from", from.getName()));
    }
}
