package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * The durable record of a cluster and the answer prepared for it.
 *
 * <h2>Why this exists</h2>
 * Clustering itself lives in the Python AI service, which keeps its centroids and cluster objects
 * in memory. That is the right place for the vector maths, but it means everything it holds —
 * including drafted answers — disappears when that service restarts, and on a free tier it restarts
 * whenever it has been idle. Questions survived (they were always written to {@code questions});
 * the answers did not, and a moderator's hand-written answer would have been the most expensive
 * thing to lose.
 *
 * <p>So the backend keeps its own row per cluster: enough of the cluster to render the board
 * without the AI service, plus the answer and where it came from. The AI service stays the compute
 * layer; this is the system of record for anything a human would be annoyed to lose.
 *
 * <p>Deliberately a separate table from the {@code clusters} DDL in {@code ai-service/db/init.sql}.
 * That one carries a {@code vector(384)} centroid column belonging to the AI service, and mixing
 * the two owners in one table would mean two services racing to write the same row.
 */
@Entity
@Table(name = "cluster_drafts",
       indexes = @Index(name = "cluster_drafts_status_idx", columnList = "draft_status"))
public class ClusterDraft {

    /** How the answer on this row came to be — and whether anyone still needs to act. */
    public enum DraftStatus {
        /** Queued or in flight; the model has not answered yet. */
        PENDING,
        /** The model produced a grounded answer. */
        DRAFTED,
        /** The model could not be reached or kept failing. A moderator must write this one. */
        NEEDS_MANUAL,
        /** A moderator wrote (or rewrote) the answer by hand. Never overwritten automatically. */
        MANUAL
    }

    /**
     * The AI service's cluster id, used verbatim as the primary key.
     *
     * <p>Not generated here: the board, the questions table's {@code cluster_id} and this row all
     * have to agree on one identity, and the clusterer is the thing that mints it.
     */
    @Id
    @Column(name = "cluster_id")
    private UUID clusterId;

    /**
     * Which meeting this topic belongs to.
     *
     * <p>Stamped from whichever meeting was live when the first question landed in the cluster. It
     * is what lets a new meeting start with a clean board without deleting the last one's — the
     * previous meeting's topics still exist, they simply do not match the filter.
     *
     * <p><b>Nullable, and stays that way.</b> Topics that predate meeting tracking have no meeting
     * and never will; so do topics created while no meeting was active. Making this required would
     * have meant either inventing a meeting for them or throwing them away.
     */
    @Column(name = "meeting_id")
    private UUID meetingId;

    /**
     * A snapshot of the cluster as the AI service last described it. Held so the board still
     * renders — with answers — when that service is asleep or restarting.
     */
    @Column(name = "representative_question", nullable = false, columnDefinition = "text")
    private String representativeQuestion;

    @Column(name = "cluster_size", nullable = false)
    private int size = 1;

    @Column(name = "priority_score", nullable = false)
    private double priorityScore;

    @Column(name = "draft_answer", columnDefinition = "text")
    private String draftAnswer;

    /** Citations as JSON, so the shape can follow the AI service without a migration. */
    @Column(name = "citations_json", columnDefinition = "text")
    private String citationsJson;

    @Enumerated(EnumType.STRING)
    @Column(name = "draft_status", nullable = false, length = 20)
    private DraftStatus status = DraftStatus.PENDING;

    /** Why the last automatic attempt failed — shown to the moderator being asked to step in. */
    @Column(name = "draft_error", columnDefinition = "text")
    private String draftError;

    /** Automatic attempts so far, so a permanently-failing cluster stops being retried. */
    @Column(name = "attempts", nullable = false)
    private int attempts;

    /** Set when a moderator writes the answer, so the board can say who to ask about it. */
    @Column(name = "answered_by")
    private String answeredBy;

    /**
     * When a moderator released this answer to attendees. Null means attendees cannot see it.
     *
     * <p><b>Opt-in, and this is the important part.</b> Most answers here are drafted by a model and
     * have not been read by anyone. Showing those to a room full of shareholders as "the answer"
     * would publish something the company never said — which at an AGM is not a UI problem, it is a
     * statement attributed to the board. So publishing is always a deliberate act, and the attendee
     * board shows only what has been through it.
     */
    @Column(name = "published_at")
    private Instant publishedAt;

    /**
     * Position in the run of show, or null if it has not been scheduled.
     *
     * <p>Lives here rather than in a separate agenda table because a cluster <em>is</em> the topic —
     * a second table would only hold a pointer back to this row and an integer, and would then have
     * to be kept in step through every merge and split.
     */
    @Column(name = "run_order")
    private Integer runOrder;

    /** When the chair began taking this topic. Null until they do. */
    @Column(name = "discussion_started_at")
    private Instant discussionStartedAt;

    /** When the chair finished with it. Together with the start, this is how long it took. */
    @Column(name = "discussion_ended_at")
    private Instant discussionEndedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    protected ClusterDraft() { }

    public ClusterDraft(UUID clusterId, String representativeQuestion, int size, double priorityScore) {
        this.clusterId = clusterId;
        this.representativeQuestion = representativeQuestion;
        this.size = size;
        this.priorityScore = priorityScore;
    }

    @PreUpdate
    void touch() {
        this.updatedAt = Instant.now();
    }

    /** True when the model still owes us an answer — nothing has succeeded and nobody has written one. */
    public boolean awaitingAnswer() {
        return status == DraftStatus.PENDING || status == DraftStatus.NEEDS_MANUAL;
    }

    /** A moderator's answer wins permanently: automatic drafting must never overwrite it. */
    public boolean isHumanWritten() {
        return status == DraftStatus.MANUAL;
    }

    public UUID getClusterId() { return clusterId; }
    public UUID getMeetingId() { return meetingId; }
    public void setMeetingId(UUID meetingId) { this.meetingId = meetingId; }
    public String getRepresentativeQuestion() { return representativeQuestion; }
    public void setRepresentativeQuestion(String q) { this.representativeQuestion = q; }
    public int getSize() { return size; }
    public void setSize(int size) { this.size = size; }
    public double getPriorityScore() { return priorityScore; }
    public void setPriorityScore(double priorityScore) { this.priorityScore = priorityScore; }
    public String getDraftAnswer() { return draftAnswer; }
    public void setDraftAnswer(String draftAnswer) { this.draftAnswer = draftAnswer; }
    public String getCitationsJson() { return citationsJson; }
    public void setCitationsJson(String citationsJson) { this.citationsJson = citationsJson; }
    public DraftStatus getStatus() { return status; }
    public void setStatus(DraftStatus status) { this.status = status; }
    public String getDraftError() { return draftError; }
    public void setDraftError(String draftError) { this.draftError = draftError; }
    public int getAttempts() { return attempts; }
    public void setAttempts(int attempts) { this.attempts = attempts; }
    public String getAnsweredBy() { return answeredBy; }
    public void setAnsweredBy(String answeredBy) { this.answeredBy = answeredBy; }

    /** True when attendees may see this answer. See {@link #publishedAt}. */
    public boolean isPublished() { return publishedAt != null; }
    public Instant getPublishedAt() { return publishedAt; }
    public void setPublishedAt(Instant publishedAt) { this.publishedAt = publishedAt; }

    public Integer getRunOrder() { return runOrder; }
    public void setRunOrder(Integer runOrder) { this.runOrder = runOrder; }
    public Instant getDiscussionStartedAt() { return discussionStartedAt; }
    public void setDiscussionStartedAt(Instant at) { this.discussionStartedAt = at; }
    public Instant getDiscussionEndedAt() { return discussionEndedAt; }
    public void setDiscussionEndedAt(Instant at) { this.discussionEndedAt = at; }

    /** Being taken right now — started and not yet finished. */
    public boolean isUnderDiscussion() {
        return discussionStartedAt != null && discussionEndedAt == null;
    }

    /** How long the topic took, in seconds, or null while it is still running or not yet started. */
    public Long discussionSeconds() {
        if (discussionStartedAt == null || discussionEndedAt == null) return null;
        return discussionEndedAt.getEpochSecond() - discussionStartedAt.getEpochSecond();
    }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
