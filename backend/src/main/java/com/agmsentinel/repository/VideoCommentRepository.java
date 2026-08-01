package com.agmsentinel.repository;

import com.agmsentinel.model.VideoComment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface VideoCommentRepository extends JpaRepository<VideoComment, UUID> {

    List<VideoComment> findByVideoIdOrderByCreatedAtAsc(UUID videoId);

    /** Comment counts for a page of the library in one query — see VideoLikeRepository. */
    @Query("""
           select c.videoId, count(c) from VideoComment c
           where c.videoId in :videoIds
           group by c.videoId
           """)
    List<Object[]> countsByVideo(@Param("videoIds") Collection<UUID> videoIds);

    @Modifying
    void deleteByVideoId(UUID videoId);
}
