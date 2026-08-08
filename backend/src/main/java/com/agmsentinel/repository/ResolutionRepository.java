package com.agmsentinel.repository;

import com.agmsentinel.model.Resolution;
import com.agmsentinel.model.ResolutionStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface ResolutionRepository extends JpaRepository<Resolution, UUID> {

    /** Agenda order. Creation time breaks ties so the list never reorders itself between reads. */
    List<Resolution> findByMeetingIdOrderBySeqAscCreatedAtAsc(UUID meetingId);

    List<Resolution> findByMeetingIdAndStatusOrderBySeqAsc(UUID meetingId, ResolutionStatus status);

    long countByMeetingId(UUID meetingId);

    /** The next free agenda position, so a new motion lands at the end rather than colliding. */
    @Query("select coalesce(max(r.seq), 0) from Resolution r where r.meetingId = :meetingId")
    int maxSeq(@Param("meetingId") UUID meetingId);

    @Modifying(flushAutomatically = true)
    @Query("delete from Resolution r where r.meetingId = :meetingId")
    void deleteByMeetingId(@Param("meetingId") UUID meetingId);
}
