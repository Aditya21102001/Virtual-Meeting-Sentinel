package com.agmsentinel.repository;

import com.agmsentinel.model.Vote;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface VoteRepository extends JpaRepository<Vote, UUID> {

    Optional<Vote> findByResolutionIdAndUsername(UUID resolutionId, String username);

    List<Vote> findByResolutionId(UUID resolutionId);

    /**
     * The tally for one resolution: choice, headcount, summed weight.
     *
     * <p>Aggregated in the database rather than by loading the votes. A result is read far more often
     * than it is written — every attendee watching the board polls it — and a resolution at a large
     * AGM can hold every member on the register.
     */
    @Query("""
           select v.choice, count(v), coalesce(sum(v.weight), 0) from Vote v
           where v.resolutionId = :resolutionId
           group by v.choice
           """)
    List<Object[]> tally(@Param("resolutionId") UUID resolutionId);

    /**
     * The same tally for a whole agenda in one query.
     *
     * <p>The results screen shows every resolution at once; without this it would issue a query per
     * motion.
     */
    @Query("""
           select v.resolutionId, v.choice, count(v), coalesce(sum(v.weight), 0) from Vote v
           where v.resolutionId in :resolutionIds
           group by v.resolutionId, v.choice
           """)
    List<Object[]> tallies(@Param("resolutionIds") Collection<UUID> resolutionIds);

    /**
     * Which of these resolutions this member has already voted on, and how.
     *
     * <p>One query for the whole agenda, so the ballot can show the member their own position on
     * every motion without a request per row.
     */
    @Query("""
           select v.resolutionId, v.choice from Vote v
           where v.resolutionId in :resolutionIds and v.username = :username
           """)
    List<Object[]> myChoices(@Param("resolutionIds") Collection<UUID> resolutionIds,
                             @Param("username") String username);

    /**
     * Distinct members who have cast at least one vote in this meeting — the numerator for quorum.
     *
     * <p>Participation, not agreement: an abstention counts here. Someone who abstained was present
     * and taking part, and excluding them would understate attendance.
     */
    @Query("select distinct v.username from Vote v where v.meetingId = :meetingId")
    List<String> distinctVotersInMeeting(@Param("meetingId") UUID meetingId);

    @Modifying(flushAutomatically = true)
    @Query("delete from Vote v where v.resolutionId = :resolutionId")
    void deleteByResolutionId(@Param("resolutionId") UUID resolutionId);

    @Modifying(flushAutomatically = true)
    @Query("delete from Vote v where v.meetingId = :meetingId")
    void deleteByMeetingId(@Param("meetingId") UUID meetingId);
}
