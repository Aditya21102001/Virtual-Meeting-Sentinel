package com.agmsentinel.repository;

import com.agmsentinel.model.ClusterDraft;
import com.agmsentinel.model.ClusterDraft.DraftStatus;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface ClusterDraftRepository extends JpaRepository<ClusterDraft, UUID> {

    /**
     * Fetch the rows for the clusters currently on the board, in one query.
     *
     * <p>The board is assembled per refresh and can carry twenty clusters; looking each one up
     * individually would turn one board render into twenty round-trips.
     */
    List<ClusterDraft> findByClusterIdIn(Collection<UUID> clusterIds);

    List<ClusterDraft> findByStatusOrderByPriorityScoreDesc(DraftStatus status);

    long countByStatus(DraftStatus status);
}
