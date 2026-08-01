package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * One member's like on one recording.
 *
 * <p>A row per like rather than a counter column on {@code videos}: a counter cannot answer "have
 * <em>I</em> liked this", which is the half the button actually needs, and two people liking at once
 * would race on an increment. Counting rows is cheap with the index below, and the unique constraint
 * makes double-liking impossible at the database rather than relying on the UI to prevent it.
 *
 * <p>{@code videoId} is a plain column, not a relation — loading a like must not drag a whole
 * {@code Video} graph with its renditions and segments along with it.
 */
@Entity
@Table(name = "video_likes",
       uniqueConstraints = @UniqueConstraint(name = "video_likes_unique_member",
                                             columnNames = {"video_id", "username"}),
       indexes = @Index(name = "video_likes_video_idx", columnList = "video_id"))
public class VideoLike {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "video_id", nullable = false)
    private UUID videoId;

    /** The member's username, matching the authenticated principal. */
    @Column(name = "username", nullable = false)
    private String username;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    protected VideoLike() { }

    public VideoLike(UUID videoId, String username) {
        this.videoId = videoId;
        this.username = username;
    }

    public UUID getId() { return id; }
    public UUID getVideoId() { return videoId; }
    public String getUsername() { return username; }
    public Instant getCreatedAt() { return createdAt; }
}
