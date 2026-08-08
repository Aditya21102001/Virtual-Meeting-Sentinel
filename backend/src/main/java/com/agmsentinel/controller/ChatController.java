package com.agmsentinel.controller;

import com.agmsentinel.dto.ChatDtos.*;
import com.agmsentinel.security.Feature;
import com.agmsentinel.security.RequiresFeature;
import com.agmsentinel.service.AiClient;
import com.agmsentinel.service.MeetingScope;
import com.agmsentinel.service.ChatService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.security.Principal;
import java.util.List;
import java.util.Map;

/**
 * Shareholder Lounge API. Every route needs an authenticated principal; the sender/owner is
 * always taken from that principal (never the request body). Role-gated in SecurityConfig to
 * ADMIN/MODERATOR/SHAREHOLDER.
 *
 * <h2>Why the feature gates are per route rather than on the class</h2>
 * Three different features live here. The 1-on-1 messaging is LOUNGE_CHAT, the assistant is
 * AI_DRAFTING, and {@code semantic-search} is SEMANTIC_SEARCH — which backs the help widget and has
 * nothing to do with the Lounge.
 *
 * <p>Class and method annotations are ANDed (see {@code FeatureInterceptor}), so putting LOUNGE_CHAT
 * on the class would switch the help widget off for any deployment that turned the Lounge off. That
 * is not a tidier version of this; it is a different and wrong behaviour.
 */
@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private final ChatService chat;
    private final AiClient ai;
    /** Confines search to the live meeting's documents when scoping is on. */
    private final MeetingScope scope;

    public ChatController(ChatService chat, AiClient ai, MeetingScope scope) {
        this.chat = chat;
        this.ai = ai;
        this.scope = scope;
    }

    /** Names the other side of a conversation. In the body, so the route keeps a readable name. */
    public record PeerRef(String peer) { }

    /** Conversation list (registered members + last message + unread + online). */
    @RequiresFeature(Feature.LOUNGE_CHAT)
    @PostMapping("/list-contacts")
    public List<ContactDto> listContacts(Principal me) {
        return chat.contacts(me.getName());
    }

    /** Full thread with a peer; marks their messages to me as read. */
    @RequiresFeature(Feature.LOUNGE_CHAT)
    @PostMapping("/load-thread")
    public List<ChatMessageDto> loadThread(@RequestBody PeerRef req, Principal me) {
        return chat.thread(me.getName(), req.peer());
    }

    /** Send a 1-on-1 message. */
    @RequiresFeature(Feature.LOUNGE_CHAT)
    @PostMapping("/send-message")
    public ChatMessageDto sendMessage(@Valid @RequestBody SendMessageRequest req, Principal me) {
        return chat.send(me.getName(), req.to(), req.body());
    }

    /** A semantic search request from the help widget. */
    public record SearchRequest(String query, Integer k) { }

    /**
     * Semantic search across the annual report and every indexed recording.
     *
     * <p>Retrieval only — no LLM. That is what makes it different in kind from
     * {@code ask-assistant}: no API key, nothing per query, and an answer fast enough to run while
     * somebody is still typing. It is also what still works when the model provider is down.
     *
     * <p>Results carry the same {@code video_id}/{@code at_seconds} a citation does, so a hit in a
     * recording opens the player at the moment it was said.
     *
     * <h3>Why two feature gates</h3>
     * SEMANTIC_SEARCH is the capability. HELP_WIDGET is the only thing that currently uses it, and
     * an administrator switching the widget off reasonably expects the capability to go with it —
     * hiding the bubble while leaving the endpoint answering anyone who calls it directly is a
     * switch that only half works.
     *
     * <p>If a second surface ever needs semantic search — the help page, the board — give it its own
     * route gated on SEMANTIC_SEARCH alone rather than loosening this one. This route belongs to the
     * widget; that is what the second annotation records.
     */
    @RequiresFeature(Feature.SEMANTIC_SEARCH)
    @RequiresFeature(Feature.HELP_WIDGET)
    @PostMapping("/semantic-search")
    public List<Map<String, Object>> semanticSearch(@RequestBody SearchRequest req) {
        int k = req.k() == null ? 8 : Math.max(1, Math.min(req.k(), 25));
        // Scoped to the live meeting's documents plus the shared ones, so the help widget
        // cannot surface a document belonging to a different meeting.
        return ai.search(req.query(), k, scope.knowledgeMeetingId().orElse(null));
    }

    /** Ask the GenAI assistant (RAG-grounded on the annual report). */
    @RequiresFeature(Feature.AI_DRAFTING)
    @PostMapping("/ask-assistant")
    public ResponseEntity<AiChatResult> askAssistant(@Valid @RequestBody AiChatRequest req, Principal me) {
        return ResponseEntity.ok(chat.askAi(me.getName(), req.body()));
    }
}
