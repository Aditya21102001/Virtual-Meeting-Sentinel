package com.agmsentinel.repository;

import com.agmsentinel.model.VideoChapter;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface VideoChapterRepository extends JpaRepository<VideoChapter, UUID> {

    /** In playing order. Sorted in the query so no caller has to remember to. */
    List<VideoChapter> findByVideoIdOrderByStartSecondsAsc(UUID videoId);

    /**
     * Every chapter for a page of recordings, in one query.
     *
     * <p>The alternative — asking per card while rendering the library — is the classic N+1: twenty
     * recordings became twenty round-trips to the slowest thing in the request. Reading the whole
     * table and filtering in memory would be worse still, since it grows with the archive rather
     * than with the page.
     */
    List<VideoChapter> findByVideoIdInOrderByStartSecondsAsc(Collection<UUID> videoIds);

    /**
     * Bulk — see VideoAssetRepository.deleteByVideoId for why a derived delete is the wrong tool.
     *
     * <p>Used on every save as well as on delete: a chapter list is replaced wholesale rather than
     * diffed, because a moderator editing an agenda renames, reorders and removes rows at once and
     * matching those up by id would be work with nothing to show for it.
     */
    @Modifying(flushAutomatically = true)
    @Query("delete from VideoChapter c where c.videoId = :videoId")
    void deleteByVideoId(@Param("videoId") UUID videoId);
}
