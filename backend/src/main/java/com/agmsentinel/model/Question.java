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
    public Instant getCreatedAt() { return createdAt; }
}
