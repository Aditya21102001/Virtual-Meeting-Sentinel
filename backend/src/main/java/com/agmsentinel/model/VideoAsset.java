package com.agmsentinel.model;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.util.UUID;

/**
 * One stored media file, held in the database instead of on the filesystem.
 *
 * <p>Keyed by {@code (videoId, relPath)} — deliberately the same {@code (video, relative path)}
 * addressing the filesystem layout uses ({@code hls/720p/seg_00042.ts}, {@code poster.jpg}). Both
 * storage backends therefore answer the same question, and nothing upstream needs to know which one
 * is in play.
 *
 * <p>Held in its own table rather than as a column on {@code video_segments}, so the segment index
 * stays small and fast to scan: a seek lookup or a playlist listing must never drag megabytes of
 * segment payload along with it.
 *
 * <p>{@code videoId} is a plain column rather than a JPA relation. Loading a blob row must not pull
 * an entire {@code Video} graph with it, and deletion is explicit
 * ({@code VideoMediaStore.deleteAll}) rather than relying on cascade ordering.
 */
@Entity
@Table(name = "video_assets",
       uniqueConstraints = @UniqueConstraint(name = "video_assets_unique_path",
                                             columnNames = {"video_id", "rel_path"}),
       indexes = @Index(name = "video_assets_video_idx", columnList = "video_id"))
public class VideoAsset {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "video_id", nullable = false)
    private UUID videoId;

    /** Path relative to the video's own folder, always with forward slashes. */
    @Column(name = "rel_path", nullable = false)
    private String relPath;

    @Column(name = "content_type")
    private String contentType;

    @Column(name = "byte_size", nullable = false)
    private long byteSize;

    /**
     * The bytes.
     *
     * <p>The column type is stated explicitly, which is subtler than it looks. Hibernate renders
     * {@code @Lob byte[]} — and any {@code VARBINARY} longer than the dialect's maximum — as SQL
     * {@code blob}. PostgreSQL has no {@code blob} type, and H2 in PostgreSQL-compatibility mode
     * (the usual local-development setup) rejects it outright: the table then fails to be created
     * during schema export while the application still starts, so the first upload is the thing
     * that discovers it. {@code bytea} is PostgreSQL's binary type and an accepted {@code VARBINARY}
     * alias in H2, so naming it directly works on both of the databases this project supports.
     *
     * <p>Deliberately not lazy: lazy basic attributes need bytecode enhancement to work at all, so
     * declaring it would give false reassurance. Callers that want metadata without the payload use
     * the projection queries on {@code VideoAssetRepository} instead.
     */
    @JdbcTypeCode(SqlTypes.VARBINARY)
    @Column(name = "data", nullable = false, columnDefinition = "bytea")
    private byte[] data;

    protected VideoAsset() { }

    public VideoAsset(UUID videoId, String relPath, String contentType, byte[] data) {
        this.videoId = videoId;
        this.relPath = relPath;
        this.contentType = contentType;
        this.data = data;
        this.byteSize = data == null ? 0 : data.length;
    }

    public UUID getId() { return id; }
    public UUID getVideoId() { return videoId; }
    public String getRelPath() { return relPath; }
    public String getContentType() { return contentType; }
    public long getByteSize() { return byteSize; }
    public byte[] getData() { return data; }

    /** Replace the payload — used when re-processing overwrites an asset at the same path. */
    public void setData(byte[] data) {
        this.data = data;
        this.byteSize = data == null ? 0 : data.length;
    }
}
