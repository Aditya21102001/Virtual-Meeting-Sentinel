package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * A comment left on a recording.
 *
 * <p>Flat rather than threaded, deliberately: a meeting recording attracts questions and
 * corrections, not conversation trees, and a parent pointer would buy nesting nobody asked for at
 * the cost of every read becoming recursive.
 *
 * <p>The author is stored as the username taken from the authenticated principal, never from the
 * request body — a client must not be able to post as someone else.
 */
@Entity
@Table(name = "video_comments",
       indexes = @Index(name = "video_comments_video_idx", columnList = "video_id, created_at"))
public class VideoComment {

    /** Long enough for a real correction, short enough that the column stays sane. */
    public static final int MAX_LENGTH = 2000;

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "video_id", nullable = false)
    private UUID videoId;

    @Column(name = "author", nullable = false)
    private String author;

    @Column(name = "body", nullable = false, columnDefinition = "text")
    private String body;

    /**
     * Playhead position when the comment was written, or null.
     *
     * <p>Lets a comment point at a moment — "the figure at 12:04 doesn't match the slide" — and the
     * UI turn that into a seek. Null for a comment about the recording as a whole.
     */
    @Column(name = "at_seconds")
    private Double atSeconds;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "edited_at")
    private Instant editedAt;

    protected VideoComment() { }

    public VideoComment(UUID videoId, String author, String body, Double atSeconds) {
        this.videoId = videoId;
        this.author = author;
        this.body = body;
        this.atSeconds = atSeconds;
    }

    public UUID getId() { return id; }
    public UUID getVideoId() { return videoId; }
    public String getAuthor() { return author; }
    public String getBody() { return body; }
    public Double getAtSeconds() { return atSeconds; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getEditedAt() { return editedAt; }

    public void edit(String body) {
        this.body = body;
        this.editedAt = Instant.now();
    }
}
