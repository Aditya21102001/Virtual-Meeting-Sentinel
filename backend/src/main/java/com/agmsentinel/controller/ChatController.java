package com.agmsentinel.controller;

import com.agmsentinel.dto.ChatDtos.*;
import com.agmsentinel.service.ChatService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.security.Principal;
import java.util.List;

/**
 * Shareholder Lounge API. Every route needs an authenticated principal; the sender/owner is
 * always taken from that principal (never the request body). Role-gated in SecurityConfig to
 * ADMIN/MODERATOR/SHAREHOLDER.
 */
@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private final ChatService chat;

    public ChatController(ChatService chat) {
        this.chat = chat;
    }

    /** Names the other side of a conversation. In the body, so the route keeps a readable name. */
    public record PeerRef(String peer) { }

    /** Conversation list (registered members + last message + unread + online). */
    @PostMapping("/list-contacts")
    public List<ContactDto> listContacts(Principal me) {
        return chat.contacts(me.getName());
    }

    /** Full thread with a peer; marks their messages to me as read. */
    @PostMapping("/load-thread")
    public List<ChatMessageDto> loadThread(@RequestBody PeerRef req, Principal me) {
        return chat.thread(me.getName(), req.peer());
    }

    /** Send a 1-on-1 message. */
    @PostMapping("/send-message")
    public ChatMessageDto sendMessage(@Valid @RequestBody SendMessageRequest req, Principal me) {
        return chat.send(me.getName(), req.to(), req.body());
    }

    /** Ask the GenAI assistant (RAG-grounded on the annual report). */
    @PostMapping("/ask-assistant")
    public ResponseEntity<AiChatResult> askAssistant(@Valid @RequestBody AiChatRequest req, Principal me) {
        return ResponseEntity.ok(chat.askAi(me.getName(), req.body()));
    }
}
