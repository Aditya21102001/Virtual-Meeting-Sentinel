package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * A standing instruction that one cluster is really part of another.
 *
 * <h2>Why a table, rather than just moving the questions</h2>
 * Clustering happens in the Python AI service, which keeps a centroid per cluster and assigns every
 * <em>incoming</em> question to the nearest one. The backend only records the answer.
 *
 * <p>So moving questions alone would not hold. A moderator merges "when is the dividend paid?" into
 * "dividend timing", the two clusters become one on the board — and then the next attendee asks
 * about the dividend, the AI service assigns them to the original centroid it still has, and the
 * cluster the moderator just merged away reappears with one question in it. The merge would quietly
 * undo itself, which is worse than not offering it.
 *
 * <p>This row is the durable part. Every cluster id coming back from the AI service is resolved
 * through it before anything is recorded, so the redirect keeps applying to questions that have not
 * been asked yet.
 *
 * <h2>Chains</h2>
 * Merging B into A and later A into C leaves B pointing at A and A pointing at C. Resolution follows
 * the chain to its end rather than rewriting old rows, so the history of what was merged into what
 * stays readable. See {@code ClusterCurationService.resolve}.
 */
@Entity
@Table(name = "cluster_merges",
       indexes = @Index(name = "cluster_merges_target_idx", columnList = "target_cluster_id"))
public class ClusterMerge {

    /**
     * The cluster that was merged away. Primary key, because it can only have been merged into one
     * place — that constraint is the thing that stops the redirects forking.
     */
    @Id
    @Column(name = "source_cluster_id")
    private UUID sourceClusterId;

    /** The cluster it now belongs to. May itself have been merged onwards — see the class note. */
    @Column(name = "target_cluster_id", nullable = false)
    private UUID targetClusterId;

    /** The question the merged-away cluster used to represent, kept so the merge can be explained. */
    @Column(name = "source_question", columnDefinition = "text")
    private String sourceQuestion;

    @Column(name = "merged_by")
    private String mergedBy;

    @Column(name = "merged_at", nullable = false)
    private Instant mergedAt = Instant.now();

    protected ClusterMerge() { }

    public ClusterMerge(UUID sourceClusterId, UUID targetClusterId, String sourceQuestion,
                        String mergedBy) {
        this.sourceClusterId = sourceClusterId;
        this.targetClusterId = targetClusterId;
        this.sourceQuestion = sourceQuestion;
        this.mergedBy = mergedBy;
    }

    public UUID getSourceClusterId() { return sourceClusterId; }
    public UUID getTargetClusterId() { return targetClusterId; }
    public void setTargetClusterId(UUID targetClusterId) { this.targetClusterId = targetClusterId; }
    public String getSourceQuestion() { return sourceQuestion; }
    public String getMergedBy() { return mergedBy; }
    public Instant getMergedAt() { return mergedAt; }
}
