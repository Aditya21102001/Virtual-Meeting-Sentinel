package com.agmsentinel.repository;

import com.agmsentinel.model.ClusterDraft;
import com.agmsentinel.model.ClusterDraft.DraftStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

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

    // ---- per-meeting scoping ---------------------------------------------------

    /** One meeting's topics, most important first. The scoped board. */
    List<ClusterDraft> findByMeetingIdOrderByPriorityScoreDesc(UUID meetingId);

    /** One meeting's topics still needing a human answer — the scoped to-do list. */
    List<ClusterDraft> findByMeetingIdAndStatusOrderByPriorityScoreDesc(UUID meetingId,
                                                                        DraftStatus status);

    long countByMeetingId(UUID meetingId);

    /**
     * Topics that belong to no meeting.
     *
     * <p>Everything created before meeting tracking existed, plus anything raised while no meeting
     * was active. Counted so the backfill screen can say how much is unattributed rather than
     * leaving an administrator to guess.
     */
    @Query("select count(c) from ClusterDraft c where c.meetingId is null")
    long countUnattributed();

    /**
     * Adopt every unattributed topic into one meeting — the backfill.
     *
     * <p>Scoped to {@code meetingId is null} so it can only ever claim orphans. Re-running it is
     * harmless, and it can never move a topic from one meeting to another: the destructive version
     * of this is a mistake nobody could undo without a backup.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update ClusterDraft c set c.meetingId = :meetingId where c.meetingId is null")
    int adoptUnattributed(@Param("meetingId") UUID meetingId);
}
