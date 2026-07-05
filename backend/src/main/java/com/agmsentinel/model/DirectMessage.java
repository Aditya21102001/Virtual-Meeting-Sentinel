package com.agmsentinel.model;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/**
 * A 1-on-1 direct message in the Shareholder Lounge. Both parties are referenced by username
 * (the JWT subject). `kind` distinguishes person-to-person messages from GenAI-assistant turns,
 * which are stored against the virtual peer "AI Assistant" so a shareholder's chatbot history
 * survives a refresh just like a real conversation.
 */
@Entity
@Table(name = "direct_messages", indexes = {
        @Index(name = "idx_dm_sender", columnList = "sender"),
        @Index(name = "idx_dm_recipient", columnList = "recipient"),
})
public class DirectMessage {

    public enum Kind { USER, AI }

    @Id
    @GeneratedValue
    private UUID id;

    @Column(nullable = false)
    private String sender;

    @Column(nullable = false)
    private String recipient;

    @Column(nullable = false, length = 4000)
    private String body;

    @Column(name = "sent_at", nullable = false)
    private Instant sentAt = Instant.now();

    @Column(name = "read_at")
    private Instant readAt;   // null until the recipient opens the thread

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Kind kind = Kind.USER;

    protected DirectMessage() { }

    public DirectMessage(String sender, String recipient, String body, Kind kind) {
        this.sender = sender;
        this.recipient = recipient;
        this.body = body;
        this.kind = kind;
    }

    public UUID getId() { return id; }
    public String getSender() { return sender; }
    public String getRecipient() { return recipient; }
    public String getBody() { return body; }
    public Instant getSentAt() { return sentAt; }
    public Instant getReadAt() { return readAt; }
    public void setReadAt(Instant readAt) { this.readAt = readAt; }
    public Kind getKind() { return kind; }
}
