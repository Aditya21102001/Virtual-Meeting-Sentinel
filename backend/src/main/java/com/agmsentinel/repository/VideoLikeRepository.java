package com.agmsentinel.repository;

import com.agmsentinel.model.VideoLike;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface VideoLikeRepository extends JpaRepository<VideoLike, UUID> {

    Optional<VideoLike> findByVideoIdAndUsername(UUID videoId, String username);

    long countByVideoId(UUID videoId);

    /**
     * Like counts for a whole page of the library in one query.
     *
     * <p>The alternative is a count per card, which turns rendering a twenty-video library into
     * twenty round-trips — on a free-tier database that is the difference between a page that loads
     * and one that feels broken.
     */
    @Query("""
           select l.videoId, count(l) from VideoLike l
           where l.videoId in :videoIds
           group by l.videoId
           """)
    List<Object[]> countsByVideo(@Param("videoIds") Collection<UUID> videoIds);

    /** Which of these videos this member has already liked — the other half of the button's state. */
    @Query("""
           select l.videoId from VideoLike l
           where l.username = :username and l.videoId in :videoIds
           """)
    List<UUID> likedByMe(@Param("username") String username,
                         @Param("videoIds") Collection<UUID> videoIds);

    /** Bulk, so a popular recording's likes are one statement rather than a row-by-row load. */
    @Modifying(flushAutomatically = true)
    @Query("delete from VideoLike l where l.videoId = :videoId")
    void deleteByVideoId(@Param("videoId") UUID videoId);
}
