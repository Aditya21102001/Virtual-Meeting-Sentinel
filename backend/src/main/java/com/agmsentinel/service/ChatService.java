package com.agmsentinel.service;

import com.agmsentinel.dto.ChatDtos.*;
import com.agmsentinel.model.AppUser;
import com.agmsentinel.model.DirectMessage;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.repository.DirectMessageRepository;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;

/**
 * Shareholder Lounge messaging: persists 1-on-1 messages, delivers them in real time to the
 * recipient's user-queue, builds the WhatsApp-style contact list, and proxies GenAI chat.
 *
 * The message SENDER is always the authenticated principal passed in by the controller — never
 * a client-supplied field — so nobody can spoof a sender.
 */
@Service
public class ChatService {

    /** Virtual peer the GenAI assistant conversation is stored against. */
    public static final String AI_PEER = "AI Assistant";

    private final DirectMessageRepository messages;
    private final AppUserRepository users;
    private final PresenceService presence;
    private final AiClient ai;
    private final SimpMessagingTemplate broker;

    public ChatService(DirectMessageRepository messages, AppUserRepository users,
                       PresenceService presence, AiClient ai, SimpMessagingTemplate broker) {
        this.messages = messages;
        this.users = users;
        this.presence = presence;
        this.ai = ai;
        this.broker = broker;
    }

    /** Send a 1-on-1 message from `me` to `to`; persist and push live to the recipient. */
    public ChatMessageDto send(String me, String to, String body) {
        DirectMessage saved = messages.save(new DirectMessage(me, to, body, DirectMessage.Kind.USER));
        ChatMessageDto dto = toDto(saved);
        // Push to the recipient's user-queue; the sender's own tab renders from the HTTP response.
        broker.convertAndSendToUser(to, "/queue/messages", dto);
        return dto;
    }

    /** Full thread between `me` and `peer`, marking `peer → me` messages as read. */
    @Transactional
    public List<ChatMessageDto> thread(String me, String peer) {
        List<DirectMessage> convo = messages.conversation(me, peer);
        boolean anyRead = false;
        for (DirectMessage m : convo) {
            if (m.getRecipient().equals(me) && m.getReadAt() == null) {
                m.setReadAt(Instant.now());
                anyRead = true;
            }
        }
        if (anyRead) {
            // Real-time read receipt: tell the peer their messages to `me` were seen (✓✓).
            broker.convertAndSendToUser(peer, "/queue/read", Map.of("reader", me, "at", Instant.now().toString()));
        }
        return convo.stream().map(this::toDto).toList();
    }

    /** WhatsApp-style conversation list: every registered user (except me) + last msg + unread. */
    public List<ContactDto> contacts(String me) {
        List<DirectMessage> mine = messages.involving(me);   // newest first
        Map<String, DirectMessage> lastByPeer = new HashMap<>();
        Map<String, Long> unreadByPeer = new HashMap<>();
        for (DirectMessage m : mine) {
            String peer = m.getSender().equals(me) ? m.getRecipient() : m.getSender();
            lastByPeer.putIfAbsent(peer, m);   // first seen = newest (list is desc)
            if (m.getRecipient().equals(me) && m.getReadAt() == null) {
                unreadByPeer.merge(m.getSender(), 1L, Long::sum);
            }
        }

        List<ContactDto> contacts = new ArrayList<>();
        for (AppUser u : users.findAll()) {
            String name = u.getUsername();
            if (name.equals(me)) continue;
            DirectMessage last = lastByPeer.get(name);
            contacts.add(new ContactDto(
                    name, u.getRole(), presence.isOnline(name),
                    last == null ? null : last.getBody(),
                    last == null ? null : last.getSentAt(),
                    unreadByPeer.getOrDefault(name, 0L)));
        }
        // Most-recent conversations first; never-messaged contacts (null lastAt) sink to the bottom.
        contacts.sort(Comparator.comparing(
                (ContactDto c) -> c.lastAt() == null ? Instant.EPOCH : c.lastAt()).reversed());
        return contacts;
    }

    /** GenAI assistant: persist the exchange and return a RAG-grounded, cited answer. */
    public AiChatResult askAi(String me, String body) {
        messages.save(new DirectMessage(me, AI_PEER, body, DirectMessage.Kind.USER));
        AiChatResult result = ai.chat(body);
        messages.save(new DirectMessage(AI_PEER, me, result.answer(), DirectMessage.Kind.AI));
        return result;
    }

    private ChatMessageDto toDto(DirectMessage m) {
        return new ChatMessageDto(
                m.getId().toString(), m.getSender(), m.getRecipient(), m.getBody(),
                m.getSentAt(), m.getReadAt(), m.getKind().name());
    }
}
