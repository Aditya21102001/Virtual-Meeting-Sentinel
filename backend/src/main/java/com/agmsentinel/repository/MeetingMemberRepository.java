package com.agmsentinel.repository;

import com.agmsentinel.model.MeetingMember;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface MeetingMemberRepository extends JpaRepository<MeetingMember, UUID> {

    List<MeetingMember> findByMeetingIdOrderByUsernameAsc(UUID meetingId);

    List<MeetingMember> findByUsernameOrderByCreatedAtDesc(String username);

    Optional<MeetingMember> findByMeetingIdAndUsername(UUID meetingId, String username);

    boolean existsByMeetingIdAndUsername(UUID meetingId, String username);

    long countByMeetingId(UUID meetingId);

    /**
     * Member counts for a whole page of meetings in one query.
     *
     * <p>The listing shows a count per row; resolving those one at a time would turn rendering the
     * meetings screen into a query per meeting — the same trap the video catalogue avoids.
     */
    @Query("""
           select m.meetingId, count(m) from MeetingMember m
           where m.meetingId in :meetingIds
           group by m.meetingId
           """)
    List<Object[]> countsByMeeting(@Param("meetingIds") Collection<UUID> meetingIds);

    /**
     * Total entitlement mapped to this meeting — the denominator for quorum.
     *
     * <p>Summed in the database rather than by loading the members: a share register can run to
     * thousands of rows, and this is asked for on every refresh of the quorum panel.
     */
    @Query("""
           select coalesce(sum(m.votingWeight), 0) from MeetingMember m
           where m.meetingId = :meetingId
           """)
    long totalVotingWeight(@Param("meetingId") UUID meetingId);

    /**
     * Entitlement of members who have cast at least one vote — the numerator for quorum.
     *
     * <p>One query rather than "list the voters, then look each one's weight up": the quorum panel is
     * polled while a meeting runs, and a room of a few hundred members would otherwise mean a few
     * hundred queries per refresh.
     *
     * <p>Joining through the member list is also what makes the number trustworthy. Summing weights
     * off the votes themselves would count anyone whose entitlement had since been removed.
     */
    @Query("""
           select coalesce(sum(m.votingWeight), 0) from MeetingMember m
           where m.meetingId = :meetingId
             and m.username in (select v.username from Vote v where v.meetingId = :meetingId)
           """)
    long representedVotingWeight(@Param("meetingId") UUID meetingId);

    /** Bulk, so removing a meeting is one statement rather than a row-by-row load. */
    @Modifying(flushAutomatically = true)
    @Query("delete from MeetingMember m where m.meetingId = :meetingId")
    void deleteByMeetingId(@Param("meetingId") UUID meetingId);
}
