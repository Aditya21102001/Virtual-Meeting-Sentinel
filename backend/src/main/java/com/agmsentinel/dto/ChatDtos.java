package com.agmsentinel.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;

/** Request/response records for the Shareholder Lounge (chat, contacts, GenAI). */
public final class ChatDtos {
    private ChatDtos() { }

    // ---- 1-on-1 direct messages ----------------------------------------------
    public record SendMessageRequest(
            @NotBlank String to,
            @NotBlank @Size(max = 4000) String body
    ) { }

    public record ChatMessageDto(
            String id,
            String sender,
            String recipient,
            String body,
            Instant sentAt,
            Instant readAt,
            String kind        // "USER" | "AI"
    ) { }

    /** One row in the WhatsApp-style conversation list. */
    public record ContactDto(
            String username,
            String role,
            boolean online,
            String lastMessage,
            Instant lastAt,
            long unread
    ) { }

    /** Ephemeral "user is typing" ping, relayed over WebSocket (not persisted). */
    public record TypingRequest(@NotBlank String to) { }

    // ---- GenAI assistant ------------------------------------------------------
    public record AiChatRequest(@NotBlank @Size(max = 2000) String body) { }

    public record CitationDto(String source, String snippet) { }

    public record AiChatResult(String answer, List<CitationDto> citations) { }

    // ---- user directory / role management (members screen) --------------------
    public record UserDto(String id, String username, String email, String role) { }

    public record SetRoleRequest(@NotBlank String role) { }
}
