package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * One member's vote on one resolution.
 *
 * <p><b>One row per member per resolution</b>, enforced by a unique constraint rather than by a check
 * in the service. Double-counting a vote is the failure that matters most here, and two requests
 * arriving together — a double-tap, a retried request — is exactly the case application logic gets
 * wrong. Changing a vote while the floor is open updates this row; it never inserts a second.
 *
 * <p><b>The weight is copied in, not looked up at tally time.</b> It is the member's entitlement at
 * the moment they voted. If a holding is corrected afterwards, the votes already cast must not
 * silently re-weight themselves — a recorded result would change after the fact with nothing to show
 * for it. Correcting a result is a deliberate act: reopen and re-take the vote.
 */
@Entity
@Table(name = "votes",
       uniqueConstraints = @UniqueConstraint(name = "votes_one_per_member",
                                             columnNames = {"resolution_id", "username"}),
       indexes = {
           @Index(name = "votes_resolution_idx", columnList = "resolution_id"),
           @Index(name = "votes_meeting_user_idx", columnList = "meeting_id, username")
       })
public class Vote {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "resolution_id", nullable = false)
    private UUID resolutionId;

    /**
     * Denormalised from the resolution, so quorum — "who took part in this meeting at all" — is one
     * query over votes rather than a join back through every resolution on the agenda.
     */
    @Column(name = "meeting_id", nullable = false)
    private UUID meetingId;

    @Column(nullable = false)
    private String username;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    private VoteChoice choice;

    /** The member's entitlement when the vote was cast. See the class note. */
    @Column(nullable = false)
    private int weight = 1;

    @Column(name = "cast_at", nullable = false)
    private Instant castAt = Instant.now();

    protected Vote() { }

    public Vote(UUID resolutionId, UUID meetingId, String username, VoteChoice choice, int weight) {
        this.resolutionId = resolutionId;
        this.meetingId = meetingId;
        this.username = username;
        this.choice = choice;
        this.weight = weight;
    }

    /** Change an existing vote. Only legitimate while the resolution is open. */
    public void recast(VoteChoice choice, int weight) {
        this.choice = choice;
        this.weight = weight;
        this.castAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getResolutionId() { return resolutionId; }
    public UUID getMeetingId() { return meetingId; }
    public String getUsername() { return username; }
    public VoteChoice getChoice() { return choice; }
    public int getWeight() { return weight; }
    public Instant getCastAt() { return castAt; }
}
