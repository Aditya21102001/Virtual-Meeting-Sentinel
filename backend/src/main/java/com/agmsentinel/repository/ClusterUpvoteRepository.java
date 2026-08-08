package com.agmsentinel.repository;

import com.agmsentinel.model.ClusterUpvote;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ClusterUpvoteRepository extends JpaRepository<ClusterUpvote, UUID> {

    Optional<ClusterUpvote> findByClusterIdAndVoterId(UUID clusterId, String voterId);

    long countByClusterId(UUID clusterId);

    /**
     * Support counts for a whole board in one query.
     *
     * <p>The board renders twenty topics at a time and refreshes on a timer, so resolving these
     * one at a time would be twenty queries every few seconds for every connected moderator.
     */
    @Query("""
           select u.clusterId, count(u) from ClusterUpvote u
           where u.clusterId in :clusterIds
           group by u.clusterId
           """)
    List<Object[]> countsByCluster(@Param("clusterIds") Collection<UUID> clusterIds);

    /** Which of these topics this person has already supported, so the button reflects reality. */
    @Query("""
           select u.clusterId from ClusterUpvote u
           where u.clusterId in :clusterIds and u.voterId = :voterId
           """)
    List<UUID> mineAmong(@Param("clusterIds") Collection<UUID> clusterIds,
                         @Param("voterId") String voterId);

    /**
     * Move support when a moderator merges two topics.
     *
     * <p>Without this, merging would throw away the support recorded against the group that was
     * folded in — the merged topic would appear less popular than either of its halves, which is the
     * opposite of what just happened.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update ClusterUpvote u set u.clusterId = :target where u.clusterId = :source")
    int reassign(@Param("source") UUID source, @Param("target") UUID target);

    /**
     * Drop support for the source that the target already has from the same person.
     *
     * <p>Must run before {@link #reassign}. Somebody who supported both topics has a row against
     * each, and moving both onto the target would break the one-per-person constraint and fail the
     * whole merge. Their support is not lost — the row on the target is the one that survives, and
     * one person still counts once, which is the point of the constraint.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("""
           delete from ClusterUpvote u
           where u.clusterId = :source
             and u.voterId in (select v.voterId from ClusterUpvote v where v.clusterId = :target)
           """)
    int dropSupportersAlreadyOnTarget(@Param("source") UUID source, @Param("target") UUID target);

    @Modifying(flushAutomatically = true)
    @Query("delete from ClusterUpvote u where u.clusterId = :clusterId")
    void deleteByClusterId(@Param("clusterId") UUID clusterId);
}
