package com.agmsentinel.repository;

import com.agmsentinel.model.Question;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface QuestionRepository extends JpaRepository<Question, UUID> {

    long countByClusterId(UUID clusterId);

    /** The questions in one cluster, oldest first — the order a moderator reads them in. */
    List<Question> findByClusterIdOrderByCreatedAtAsc(UUID clusterId);

    long countByMeetingId(UUID meetingId);

    /**
     * How many questions this meeting's report cannot account for.
     *
     * <p>Questions asked before meetings were recorded carry no meeting, and always will. A report
     * that quietly omitted them would understate what was asked; one that included them would
     * attribute another meeting's questions to this one. So they are counted separately and the
     * report says so.
     */
    @Query("select count(q) from Question q where q.meetingId is null")
    long countUnattributed();

    /**
     * Adopt every unattributed question into one meeting — the backfill.
     *
     * <p>Scoped to {@code meetingId is null} so it can only claim orphans, never move a question
     * from one meeting to another. Re-running it is harmless.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update Question q set q.meetingId = :meetingId where q.meetingId is null")
    int adoptUnattributed(@Param("meetingId") UUID meetingId);

    /**
     * The clusters this meeting's questions fell into, with how many of them landed in each.
     *
     * <p>Grouped in the database: a report covers a whole meeting, and loading every question to
     * count them in Java would pull the entire question table across for a busy AGM.
     *
     * <p>Counts are scoped to the meeting, so a cluster carrying questions from several meetings
     * reports only this meeting's share of it rather than its global size.
     */
    @Query("""
           select q.clusterId, count(q), sum(q.weight) from Question q
           where q.meetingId = :meetingId and q.clusterId is not null
           group by q.clusterId
           """)
    List<Object[]> clusterTotalsForMeeting(@Param("meetingId") UUID meetingId);

    /**
     * Reassign a whole cluster in one statement.
     *
     * <p>Bulk rather than load-modify-save: a merged cluster can hold hundreds of questions, and
     * this runs while a moderator is waiting on the board to redraw.
     *
     * <p>Bulk updates bypass the persistence context, so anything already loaded in this transaction
     * would still hold the old cluster id. {@code clearAutomatically} discards that stale state
     * rather than letting a later read return it.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update Question q set q.clusterId = :target where q.clusterId = :source")
    int reassignCluster(@Param("source") UUID source, @Param("target") UUID target);

    /**
     * Move specific questions into a cluster — the split.
     *
     * <p>Scoped to the cluster they are expected to be in, so a stale page cannot move a question
     * that something else has already moved. The returned count is how many actually moved, which is
     * what lets the caller notice the difference.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("""
           update Question q set q.clusterId = :target
           where q.id in :ids and q.clusterId = :expectedSource
           """)
    int moveQuestions(@Param("ids") Collection<UUID> ids,
                      @Param("expectedSource") UUID expectedSource,
                      @Param("target") UUID target);
}
