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

    /**
     * Bytes occupied by every segment before {@code seq} in this rung — the offset a seek to that
     * segment lands at, if you think of the rendition as one continuous file.
     *
     * <p>Nothing in the delivery path needs this: the player addresses segments by URI, not by
     * offset. It exists so the UI can show what the index actually knows — "segment 215 of 271,
     * 248 MB in" — which is the difference between claiming the recording is indexed and being able
     * to point at the index answering a question.
     */
    @Query("""
           select coalesce(sum(s.byteSize), 0) from VideoSegment s
           where s.rendition.id = :renditionId and s.seq < :seq
           """)
    long bytesBefore(@Param("renditionId") UUID renditionId, @Param("seq") int seq);

    void deleteByRenditionId(UUID renditionId);
}
