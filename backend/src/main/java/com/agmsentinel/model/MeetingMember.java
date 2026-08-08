package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * A user mapped to a meeting — who is entitled to take part in it.
 *
 * <p>Holds the username as text rather than a foreign key to {@code app_users}, matching how likes
 * and comments already work. Attendees can be mapped before they have ever signed in, and an
 * invitation list that could only contain existing rows would be useless for exactly the case it
 * exists for.
 *
 * <p>{@code roleInMeeting} is deliberately <em>not</em> an application role. It says what someone is
 * <em>at this meeting</em> — a panellist here may be an ordinary attendee at the next one — and it
 * never grants access on its own. Authorisation stays with {@code Roles}.
 */
@Entity
@Table(name = "meeting_members",
       uniqueConstraints = @UniqueConstraint(name = "meeting_members_unique",
                                             columnNames = {"meeting_id", "username"}),
       indexes = @Index(name = "meeting_members_meeting_idx", columnList = "meeting_id"))
public class MeetingMember {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "meeting_id", nullable = false)
    private UUID meetingId;

    @Column(nullable = false)
    private String username;

    /** ATTENDEE, PANELLIST, CHAIR … descriptive, not an authorisation grant. */
    @Column(name = "role_in_meeting", nullable = false, length = 32)
    private String roleInMeeting = "ATTENDEE";

    /**
     * How much this member's vote counts for — shares held, or 1 for one-member-one-vote.
     *
     * <p>Lives here, on the mapping, rather than on the user: an entitlement is per meeting, and the
     * same person may hold a different number of shares at the next one. Keeping it here also means
     * the number is set by a user manager and never by the voter — a weight the client could supply
     * would be a weight the client could inflate.
     */
    @Column(name = "voting_weight", nullable = false)
    private int votingWeight = 1;

    /** Username of the user manager who added them, for an audit trail. */
    @Column(name = "added_by")
    private String addedBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    protected MeetingMember() { }

    public MeetingMember(UUID meetingId, String username, String roleInMeeting, String addedBy) {
        this.meetingId = meetingId;
        this.username = username;
        this.roleInMeeting = roleInMeeting == null || roleInMeeting.isBlank()
                ? "ATTENDEE" : roleInMeeting;
        this.addedBy = addedBy;
    }

    public UUID getId() { return id; }
    public UUID getMeetingId() { return meetingId; }
    public String getUsername() { return username; }
    public String getRoleInMeeting() { return roleInMeeting; }
    public void setRoleInMeeting(String roleInMeeting) { this.roleInMeeting = roleInMeeting; }
    public int getVotingWeight() { return votingWeight; }
    public void setVotingWeight(int votingWeight) { this.votingWeight = Math.max(0, votingWeight); }
    public String getAddedBy() { return addedBy; }
    public Instant getCreatedAt() { return createdAt; }
}
