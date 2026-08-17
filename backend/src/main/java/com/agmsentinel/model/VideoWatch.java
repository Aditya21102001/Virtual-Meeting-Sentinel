package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * One member's watching of one recording, and how far it got.
 *
 * <p>Named Watch rather than View because {@code VideoDtos.VideoView} is already the DTO for a
 * recording's metadata; two types called VideoView in the same request path would be a permanent
 * import trap for no benefit.
 *
 * <h2>Why a row per viewer rather than a counter on {@code videos}</h2>
 * A counter column answers "how many views" and nothing else. This one row answers three questions
 * the library needs and a counter cannot: the total, whether <em>this</em> member has watched it, and
 * where they stopped — which is what a "Continue watching" row is made of. An increment would also
 * race between two viewers pressing play at the same moment.
 *
 * <p>One row per member per recording, not per press of play. A view count that climbs every time
 * someone re-opens a recording measures curiosity about the page, not the audience — and for a board
 * meeting the honest question is how many shareholders watched it, once each. {@code viewCount}
 * records the repeats for anyone who wants them without inflating the headline.
 *
 * <p>Anonymous viewers are excluded by construction: {@code username} is not nullable, so a public
 * link cannot manufacture views. That undercounts rather than overcounts, which is the safer error
 * for a number that may end up in a compliance report.
 */
@Entity
@Table(name = "video_views",
       uniqueConstraints = @UniqueConstraint(name = "video_views_unique_member",
                                            columnNames = {"video_id", "username"}),
       indexes = {
           @Index(name = "video_views_video_idx", columnList = "video_id"),
           // Drives "Continue watching", which asks for one member's rows newest-first.
           @Index(name = "video_views_member_idx", columnList = "username, last_seen_at")
       })
public class VideoWatch {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "video_id", nullable = false)
    private UUID videoId;

    @Column(name = "username", nullable = false)
    private String username;

    /** How many separate sittings. See the class note on why this is not the headline number. */
    @Column(name = "view_count", nullable = false)
    private int viewCount = 1;

    /**
     * Where this member stopped, in seconds.
     *
     * <p>Kept here rather than in browser storage so it follows a shareholder between the laptop
     * they joined the meeting on and the phone they finish the recording on. Storage-based resume
     * already exists client-side; this is what makes it portable.
     */
    @Column(name = "position_seconds", nullable = false)
    private double positionSeconds;

    /**
     * Whether they reached the end.
     *
     * <p>Stored rather than derived from {@code positionSeconds >= duration}: almost nobody watches
     * the final credits, so "finished" is a judgement about a threshold, and recomputing it later
     * against a different threshold would silently rewrite history.
     */
    @Column(nullable = false)
    private boolean completed;

    @Column(name = "first_seen_at", nullable = false)
    private Instant firstSeenAt = Instant.now();

    @Column(name = "last_seen_at", nullable = false)
    private Instant lastSeenAt = Instant.now();

    protected VideoWatch() { }

    public VideoWatch(UUID videoId, String username) {
        this.videoId = videoId;
        this.username = username;
    }

    /** Record continued watching: moves the position and the clock, and counts a fresh sitting. */
    public void touch(double positionSeconds, boolean completed, boolean newSitting) {
        this.positionSeconds = Math.max(0, positionSeconds);
        // Latching rather than assigning: having finished a recording once is not undone by later
        // re-opening it and stopping halfway.
        this.completed = this.completed || completed;
        this.lastSeenAt = Instant.now();
        if (newSitting) this.viewCount++;
    }

    public UUID getId() { return id; }
    public UUID getVideoId() { return videoId; }
    public String getUsername() { return username; }
    public int getViewCount() { return viewCount; }
    public double getPositionSeconds() { return positionSeconds; }
    public boolean isCompleted() { return completed; }
    public Instant getFirstSeenAt() { return firstSeenAt; }
    public Instant getLastSeenAt() { return lastSeenAt; }
}
