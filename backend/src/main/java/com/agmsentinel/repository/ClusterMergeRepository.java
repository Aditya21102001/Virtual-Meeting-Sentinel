package com.agmsentinel.repository;

import com.agmsentinel.model.ClusterMerge;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface ClusterMergeRepository extends JpaRepository<ClusterMerge, UUID> {

    /** What was merged into this cluster — for showing a moderator why it is as large as it is. */
    List<ClusterMerge> findByTargetClusterId(UUID targetClusterId);

    boolean existsByTargetClusterId(UUID targetClusterId);
}
