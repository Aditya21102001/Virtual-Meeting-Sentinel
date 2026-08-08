package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * "I want this answered too" — without typing the question again.
 *
 * <h2>Why this is worth having</h2>
 * Attendees who see their question already on the board have only one way to add their weight to it:
 * type it out again and hope the clusterer groups the two together. That is effort for them, an
 * extra embedding for the AI service, and a grouping decision that might go wrong. An upvote is one
 * tap and lands in exactly the right place.
 *
 * <p>It is deliberately <em>not</em> the same signal as asking. Questions carry a shareholder weight
 * and drive the drafting pipeline; an upvote is a bare show of hands. Keeping them in separate
 * tables means the board can show "asked by 4, supported by 30" rather than blurring the two into
 * one number that means neither.
 *
 * <h2>One per person per topic</h2>
 * Enforced by a unique constraint rather than a check in the service. This is the one number
 * attendees can move directly, so it is the one somebody will try to move twice — and two taps
 * arriving together is exactly the case a read-then-write gets wrong.
 *
 * <p>{@code voterId} is the attendee id, which for an anonymous pass is self-asserted. That is
 * acceptable here and nowhere near acceptable for voting: this ranks a discussion topic, it does not
 * decide anything. The distinction is drawn explicitly in {@code VotingController}.
 */
@Entity
@Table(name = "cluster_upvotes",
       uniqueConstraints = @UniqueConstraint(name = "cluster_upvotes_one_per_person",
                                             columnNames = {"cluster_id", "voter_id"}),
       indexes = @Index(name = "cluster_upvotes_cluster_idx", columnList = "cluster_id"))
public class ClusterUpvote {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "cluster_id", nullable = false)
    private UUID clusterId;

    /** Who supported it — a username, or an anonymous attendee id. */
    @Column(name = "voter_id", nullable = false)
    private String voterId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    protected ClusterUpvote() { }

    public ClusterUpvote(UUID clusterId, String voterId) {
        this.clusterId = clusterId;
        this.voterId = voterId;
    }

    public UUID getId() { return id; }
    public UUID getClusterId() { return clusterId; }
    public String getVoterId() { return voterId; }
    public Instant getCreatedAt() { return createdAt; }
}
