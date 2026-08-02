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

    /**
     * Drop every asset of a video in one statement.
     *
     * <p>Spelled out as JPQL rather than left to Spring Data's method-name derivation, and that is
     * the whole point of it. A derived {@code deleteBy…} is not a {@code delete} statement: Spring
     * Data selects the matching entities and removes them one at a time, so every {@link
     * VideoAsset#getData() payload} lands in heap — as the entity, again as Hibernate's
     * dirty-checking snapshot, and again in the driver's buffered result set. Deleting one
     * fifty-megabyte recording was therefore enough to exhaust a small container's heap and kill
     * the process mid-request, which the proxy in front of it reports as a bare 502.
     *
     * <p>A bulk delete never materialises a row, so the cost is independent of how much video is
     * stored. {@code flushAutomatically} so that segments written earlier in the same transaction
     * are on their way to the database before it runs, rather than being inserted after it.
     */
    @Modifying(flushAutomatically = true)
    @Query("delete from VideoAsset a where a.videoId = :videoId")
    void deleteByVideoId(@Param("videoId") UUID videoId);

    /**
     * The same, restricted to one subtree — the transcode output, keeping the original upload.
     * Bulk for the reason above: this one runs on every re-process, and on the startup sweep that
     * cleans up after an interrupted transcode, where an OOM would turn one oversized recording
     * into a boot loop.
     *
     * <p>{@code prefix} is matched literally by every caller ({@code hls/}); it is not escaped, so
     * do not start passing it anything containing {@code %} or {@code _}.
     */
    @Modifying(flushAutomatically = true)
    @Query("delete from VideoAsset a where a.videoId = :videoId and a.relPath like concat(:prefix, '%')")
    void deleteByVideoIdAndRelPathStartingWith(@Param("videoId") UUID videoId,
                                               @Param("prefix") String prefix);
}
