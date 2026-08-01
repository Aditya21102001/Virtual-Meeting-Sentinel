package com.agmsentinel.repository;

import com.agmsentinel.model.VideoSegment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface VideoSegmentRepository extends JpaRepository<VideoSegment, UUID> {

    List<VideoSegment> findByRenditionIdOrderBySeqAsc(UUID renditionId);

    Optional<VideoSegment> findByRenditionIdAndSeq(UUID renditionId, int seq);

    /**
     * Segment-level seek: the slice that actually contains {@code position} seconds — the one a
     * player would start fetching from to resume at that point.
     *
     * <p>The upper bound matters. Testing only {@code startSeconds <= position} would return the
     * final segment for <em>any</em> position past the end of the video, so a nonsense timestamp
     * would look like a valid seek target instead of a miss.
     */
    @Query("""
           select s from VideoSegment s
           where s.rendition.id = :renditionId
             and s.startSeconds <= :position
             and :position < s.startSeconds + s.durationSeconds
           order by s.startSeconds desc
           limit 1
           """)
    Optional<VideoSegment> findSegmentAt(@Param("renditionId") UUID renditionId,
                                        @Param("position") double position);

    void deleteByRenditionId(UUID renditionId);
}
