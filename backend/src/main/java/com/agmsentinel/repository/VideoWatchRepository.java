package com.agmsentinel.repository;

import com.agmsentinel.model.VideoWatch;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface VideoWatchRepository extends JpaRepository<VideoWatch, UUID> {

    Optional<VideoWatch> findByVideoIdAndUsername(UUID videoId, String username);

    /**
     * Distinct viewers per recording for a page of the library, in one query.
     *
     * <p>Counting rows rather than reading a counter column — see VideoWatch for why there is no
     * counter. One row per member means {@code count(*)} already IS the distinct-viewer figure.
     */
    @Query("""
           select w.videoId, count(w) from VideoWatch w
           where w.videoId in :videoIds
           group by w.videoId
           """)
    List<Object[]> viewerCountsByVideo(@Param("videoIds") Collection<UUID> videoIds);

    /**
     * This member's unfinished recordings, most recent first — the "Continue watching" row.
     *
     * <p>Excludes the finished ones and anything barely started: offering to resume a recording
     * someone opened for four seconds is noise, and the threshold is applied here rather than in
     * Java so the database returns only rows that will actually be shown.
     */
    @Query("""
           select w from VideoWatch w
           where w.username = :username
             and w.completed = false
             and w.positionSeconds >= :minSeconds
           order by w.lastSeenAt desc
           """)
    List<VideoWatch> continueWatching(@Param("username") String username,
                                      @Param("minSeconds") double minSeconds,
                                      Pageable limit);

    /** Bulk — see VideoAssetRepository.deleteByVideoId for why a derived delete is the wrong tool. */
    @Modifying(flushAutomatically = true)
    @Query("delete from VideoWatch w where w.videoId = :videoId")
    void deleteByVideoId(@Param("videoId") UUID videoId);
}
