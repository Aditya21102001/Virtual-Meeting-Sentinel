package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * A motion put to a meeting for a vote.
 *
 * <p>Belongs to a {@link Meeting}, and carries the {@link ResolutionType} that decides what majority
 * it needs. The type is stored per resolution rather than assumed globally because ordinary and
 * special resolutions routinely sit on the same agenda, and the threshold is what determines whether
 * something carried.
 *
 * <p><b>Opening and closing are recorded, not inferred.</b> {@code openedAt}/{@code closedAt} are the
 * evidence of when the floor was open — a tally is only meaningful alongside the window it was taken
 * in, and "we opened it around eleven" is not a record. {@link ResolutionStatus#OPEN} is the only
 * state that accepts a vote, so those timestamps also bound every vote the resolution holds.
 *
 * <p>{@code seq} orders the agenda. It is set by the moderator rather than derived from creation
 * time, since motions are commonly drafted out of order and then arranged.
 */
@Entity
@Table(name = "resolutions",
       indexes = {
           @Index(name = "resolutions_meeting_idx", columnList = "meeting_id"),
           @Index(name = "resolutions_status_idx", columnList = "status")
       })
public class Resolution {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "meeting_id", nullable = false)
    private UUID meetingId;

    /** Position on the agenda. Assigned by the moderator; ties break by creation time. */
    @Column(nullable = false)
    private int seq;

    @Column(nullable = false)
    private String title;

    /** The wording put to the meeting. Kept verbatim — this is the thing being voted on. */
    @Column(columnDefinition = "text")
    private String text;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private ResolutionType type = ResolutionType.ORDINARY;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private ResolutionStatus status = ResolutionStatus.DRAFT;

    /**
     * Whether members may see the running tally while the floor is open.
     *
     * <p>Off by default. A visible count during voting influences the votes still to come, which is
     * why a show of hands is taken all at once; opening the tally early should be a deliberate choice
     * by the chair rather than something the software does because it is easy.
     */
    @Column(name = "live_results_visible", nullable = false)
    private boolean liveResultsVisible = false;

    @Column(name = "opened_at")
    private Instant openedAt;

    @Column(name = "closed_at")
    private Instant closedAt;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    protected Resolution() { }

    public Resolution(UUID meetingId, int seq, String title, String text, ResolutionType type,
                      String createdBy) {
        this.meetingId = meetingId;
        this.seq = seq;
        this.title = title;
        this.text = text;
        this.type = type == null ? ResolutionType.ORDINARY : type;
        this.createdBy = createdBy;
    }

    @PreUpdate
    void touch() {
        this.updatedAt = Instant.now();
    }

    public boolean isOpen() {
        return status == ResolutionStatus.OPEN;
    }

    public UUID getId() { return id; }
    public UUID getMeetingId() { return meetingId; }
    public int getSeq() { return seq; }
    public void setSeq(int seq) { this.seq = seq; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getText() { return text; }
    public void setText(String text) { this.text = text; }
    public ResolutionType getType() { return type; }
    public void setType(ResolutionType type) { this.type = type; }
    public ResolutionStatus getStatus() { return status; }
    public void setStatus(ResolutionStatus status) { this.status = status; }
    public boolean isLiveResultsVisible() { return liveResultsVisible; }
    public void setLiveResultsVisible(boolean liveResultsVisible) {
        this.liveResultsVisible = liveResultsVisible;
    }
    public Instant getOpenedAt() { return openedAt; }
    public void setOpenedAt(Instant openedAt) { this.openedAt = openedAt; }
    public Instant getClosedAt() { return closedAt; }
    public void setClosedAt(Instant closedAt) { this.closedAt = closedAt; }
    public String getCreatedBy() { return createdBy; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
