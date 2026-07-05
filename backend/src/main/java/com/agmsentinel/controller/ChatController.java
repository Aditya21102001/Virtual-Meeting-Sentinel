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

    /** Conversation list (registered members + last message + unread + online). */
    @GetMapping("/contacts")
    public List<ContactDto> contacts(Principal me) {
        return chat.contacts(me.getName());
    }

    /** Full thread with a peer; marks their messages to me as read. */
    @GetMapping("/messages/{peer}")
    public List<ChatMessageDto> thread(@PathVariable String peer, Principal me) {
        return chat.thread(me.getName(), peer);
    }

    /** Send a 1-on-1 message. */
    @PostMapping("/messages")
    public ChatMessageDto send(@Valid @RequestBody SendMessageRequest req, Principal me) {
        return chat.send(me.getName(), req.to(), req.body());
    }

    /** Ask the GenAI assistant (RAG-grounded on the annual report). */
    @PostMapping("/ai")
    public ResponseEntity<AiChatResult> ai(@Valid @RequestBody AiChatRequest req, Principal me) {
        return ResponseEntity.ok(chat.askAi(me.getName(), req.body()));
    }
}
