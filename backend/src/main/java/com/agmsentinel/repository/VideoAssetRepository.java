package com.agmsentinel.repository;

import com.agmsentinel.model.VideoAsset;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface VideoAssetRepository extends JpaRepository<VideoAsset, UUID> {

    Optional<VideoAsset> findByVideoIdAndRelPath(UUID videoId, String relPath);

    /**
     * Size without the payload. Serving a segment needs a Content-Length, and an existence check
     * needs nothing at all — neither should pull megabytes of blob into heap to find out.
     */
    @Query("select a.byteSize from VideoAsset a where a.videoId = :videoId and a.relPath = :relPath")
    Optional<Long> findSize(@Param("videoId") UUID videoId, @Param("relPath") String relPath);

    @Query("select a.relPath from VideoAsset a where a.videoId = :videoId order by a.relPath")
    List<String> findPaths(@Param("videoId") UUID videoId);

    @Query("select coalesce(sum(a.byteSize), 0) from VideoAsset a where a.videoId = :videoId")
    long totalBytes(@Param("videoId") UUID videoId);

    @Query("select coalesce(sum(a.byteSize), 0) from VideoAsset a")
    long totalBytesStored();

    /**
     * Read a byte range straight out of the database, so a range request costs the size of the
     * range rather than the size of the file. Without this a 2 GB progressive source would have to
     * be pulled into heap in full just to answer "send me bytes 900 000 000–904 194 303".
     *
     * <p>SQL {@code substring} on a binary value is 1-based, hence the {@code + 1}. Native rather
     * than JPQL because JPQL has no binary substring; the expression itself is standard and works
     * on both PostgreSQL and H2.
     */
    @Query(value = """
           select substring(data from :start + 1 for :length)
             from video_assets
            where video_id = :videoId and rel_path = :relPath
           """, nativeQuery = true)
    Optional<byte[]> readRange(@Param("videoId") UUID videoId,
                               @Param("relPath") String relPath,
                               @Param("start") long start,
                               @Param("length") long length);

    @Modifying
    void deleteByVideoId(UUID videoId);

    @Modifying
    void deleteByVideoIdAndRelPathStartingWith(UUID videoId, String prefix);
}
