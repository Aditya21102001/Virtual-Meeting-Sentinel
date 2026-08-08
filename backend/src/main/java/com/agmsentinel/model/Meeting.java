package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * One meeting — an AGM, town-hall or webinar — and the thing everything else belongs to.
 *
 * <p>Until this existed the application had no notion of <em>which</em> meeting a question or a
 * recording was part of: everything was global, and a second meeting would have piled its questions
 * on top of the first one's board. A meeting is what makes the archive separable.
 *
 * <p><b>One active at a time.</b> Attendees submit to whichever meeting is live, so "the active
 * meeting" has to be unambiguous. That is enforced by a partial unique index
 * ({@code WHERE status = 'ACTIVE'}) rather than by application logic alone — two managers pressing
 * Activate at the same moment must not both succeed, and only the database can promise that.
 */
@Entity
@Table(name = "meetings",
       indexes = {
           @Index(name = "meetings_status_idx", columnList = "status"),
           @Index(name = "meetings_scheduled_idx", columnList = "scheduled_at")
       })
public class Meeting {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(nullable = false)
    private String title;

    @Column(columnDefinition = "text")
    private String description;

    /** When it is due to start. Informational — activation is a deliberate act, not a timer. */
    @Column(name = "scheduled_at")
    private Instant scheduledAt;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private MeetingStatus status = MeetingStatus.DRAFT;

    /**
     * The share of total voting weight that must be represented for business to be valid, as a
     * percentage.
     *
     * <p>Configurable because it is set by a company's articles, not by convention — 25% is a common
     * default but far from universal. Zero disables the check for meetings that take no formal
     * business.
     */
    @Column(name = "quorum_threshold_percent", nullable = false)
    private double quorumThresholdPercent = 25.0;

    /** Username of the meeting manager who created it. */
    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "activated_at")
    private Instant activatedAt;

    @Column(name = "closed_at")
    private Instant closedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    protected Meeting() { }

    public Meeting(String title, String description, Instant scheduledAt, String createdBy) {
        this.title = title;
        this.description = description;
        this.scheduledAt = scheduledAt;
        this.createdBy = createdBy;
    }

    @PreUpdate
    void touch() {
        this.updatedAt = Instant.now();
    }

    public boolean isActive() {
        return status == MeetingStatus.ACTIVE;
    }

    public UUID getId() { return id; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
    public Instant getScheduledAt() { return scheduledAt; }
    public void setScheduledAt(Instant scheduledAt) { this.scheduledAt = scheduledAt; }
    public MeetingStatus getStatus() { return status; }
    public void setStatus(MeetingStatus status) { this.status = status; }
    public double getQuorumThresholdPercent() { return quorumThresholdPercent; }
    public void setQuorumThresholdPercent(double percent) {
        this.quorumThresholdPercent = Math.min(100.0, Math.max(0.0, percent));
    }
    public String getCreatedBy() { return createdBy; }
    public Instant getActivatedAt() { return activatedAt; }
    public void setActivatedAt(Instant activatedAt) { this.activatedAt = activatedAt; }
    public Instant getClosedAt() { return closedAt; }
    public void setClosedAt(Instant closedAt) { this.closedAt = closedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
