package com.agmsentinel.model;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/**
 * A raw question as submitted by an attendee. The semantic embedding + cluster centroid
 * live in the Python AI service (which owns the vector math); here we persist the durable
 * record and the cluster id it was assigned to.
 */
@Entity
@Table(name = "questions")
public class Question {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(nullable = false, columnDefinition = "text")
    private String text;

    @Column(name = "attendee_id", nullable = false)
    private String attendeeId;

    @Column(nullable = false)
    private float weight;

    @Column(name = "cluster_id")
    private UUID clusterId;

    /**
     * Which meeting this question was asked at.
     *
     * <p><b>Nullable, and nothing filters on it yet.</b> Phase one only records it, so every
     * existing query behaves exactly as before and questions asked before meetings existed remain
     * valid rather than becoming orphans. Turning on scoping — the board showing only the active
     * meeting — is a separate, deliberate change once meetings are in use.
     */
    @Column(name = "meeting_id")
    private UUID meetingId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    protected Question() { }

    public Question(String text, String attendeeId, float weight) {
        this.text = text;
        this.attendeeId = attendeeId;
        this.weight = weight;
    }

    public UUID getId() { return id; }
    public String getText() { return text; }
    public String getAttendeeId() { return attendeeId; }
    public float getWeight() { return weight; }
    public UUID getClusterId() { return clusterId; }
    public void setClusterId(UUID clusterId) { this.clusterId = clusterId; }
    public UUID getMeetingId() { return meetingId; }
    public void setMeetingId(UUID meetingId) { this.meetingId = meetingId; }
    public Instant getCreatedAt() { return createdAt; }
}
