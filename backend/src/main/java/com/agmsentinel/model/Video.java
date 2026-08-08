package com.agmsentinel.model;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * One uploaded recording. The media bytes live on the NAS under {@link #storageDir}; this row is
 * the catalogue entry plus everything the player needs before it fetches a single byte of video:
 * duration, dimensions, poster, and the manifest that lists the segments.
 *
 * <p>Two delivery modes:
 * <ul>
 *   <li>{@code HLS} — ffmpeg cut the source into an adaptive ladder of ~6 s segments. The player
 *       fetches one segment at a time and switches bitrate on the fly (the YouTube behaviour).</li>
 *   <li>{@code PROGRESSIVE} — ffmpeg was unavailable, so the original file is served over HTTP
 *       Range requests. Seeking still works and the browser still never downloads the whole
 *       file, but there is no bitrate ladder.</li>
 * </ul>
 */
@Entity
@Table(name = "videos", indexes = {
        @Index(name = "videos_status_idx", columnList = "status"),
        @Index(name = "videos_created_idx", columnList = "created_at")
})
public class Video {

    /** How the segments are delivered to the browser. */
    public enum DeliveryMode { HLS, PROGRESSIVE }

    @Id
    @GeneratedValue
    private UUID id;

    @Column(nullable = false)
    private String title;

    @Column(columnDefinition = "text")
    private String description;

    @Column(name = "original_filename", nullable = false)
    private String originalFilename;

    @Column(name = "content_type")
    private String contentType;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    /** Folder name on the NAS root that holds source + hls output for this video. */
    @Column(name = "storage_dir", nullable = false)
    private String storageDir;

    /** Source file path relative to {@link #storageDir}. */
    @Column(name = "source_rel")
    private String sourceRel;

    /** Master playlist path relative to {@link #storageDir} (HLS mode only). */
    @Column(name = "master_playlist_rel")
    private String masterPlaylistRel;

    /** Poster / thumbnail image relative to {@link #storageDir}. */
    @Column(name = "poster_rel")
    private String posterRel;

    /**
     * Which meeting this recording belongs to.
     *
     * <p>Nullable, and nothing filters on it yet — see {@code Question.meetingId}. Recorded now so
     * the column exists before anything depends on it, which is what lets scoping be switched on as
     * its own change rather than as part of a migration.
     */
    @Column(name = "meeting_id")
    private UUID meetingId;

    /** Seek-preview sprite sheet relative to {@link #storageDir}. */
    @Column(name = "sprite_rel")
    private String spriteRel;

    /**
     * WebVTT captions relative to {@link #storageDir}, or null when none were supplied.
     *
     * <p>Uploaded rather than generated. Producing one means speech-to-text, and running that on the
     * same small host that already struggles to transcode would reintroduce exactly the resource
     * exhaustion the segmenting pipeline was reworked to avoid. An SRT upload is converted to WebVTT
     * on the way in, because {@code <track>} accepts only VTT.
     */
    @Column(name = "transcript_rel")
    private String transcriptRel;

    @Column(name = "sprite_interval_seconds")
    private Integer spriteIntervalSeconds;

    @Column(name = "sprite_columns")
    private Integer spriteColumns;

    @Column(name = "sprite_tile_width")
    private Integer spriteTileWidth;

    @Column(name = "sprite_tile_height")
    private Integer spriteTileHeight;

    @Column(name = "duration_seconds")
    private Double durationSeconds;

    private Integer width;
    private Integer height;

    @Column(name = "frame_rate")
    private Double frameRate;

    @Column(name = "has_audio", nullable = false)
    private boolean hasAudio = true;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private VideoStatus status = VideoStatus.UPLOADED;

    @Enumerated(EnumType.STRING)
    @Column(name = "delivery_mode", nullable = false, length = 20)
    private DeliveryMode deliveryMode = DeliveryMode.HLS;

    /**
     * Which backend holds this video's bytes. Recorded per row rather than read from configuration
     * at serve time, so changing the server default cannot strand recordings written the other way.
     *
     * <p>The SQL {@code DEFAULT} is required, not decorative. This column was added to a table that
     * may already contain rows, and {@code ddl-auto=update} therefore emits
     * {@code ALTER TABLE videos ADD COLUMN storage_mode ... NOT NULL} — which PostgreSQL rejects on
     * a non-empty table unless a default supplies a value for the existing rows. Without it, adding
     * this feature would break startup for anyone who had already uploaded a video.
     * {@code FILESYSTEM} is the correct back-fill: every pre-existing recording is on disk.
     */
    @Enumerated(EnumType.STRING)
    @Column(name = "storage_mode", nullable = false, length = 20,
            columnDefinition = "varchar(20) default 'FILESYSTEM'")
    private VideoStorageMode storageMode = VideoStorageMode.FILESYSTEM;

    /** 0-100 while PROCESSING, read from ffmpeg's progress output. */
    @Column(name = "progress_percent", nullable = false)
    private int progressPercent = 0;

    @Column(name = "error_message", columnDefinition = "text")
    private String errorMessage;

    @Column(name = "segment_seconds")
    private Integer segmentSeconds;

    @Column(name = "uploaded_by")
    private String uploadedBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    /**
     * Renditions are loaded with the video (a handful of rows at most) and removed with it, so a
     * delete leaves no orphan segment index behind.
     */
    @OneToMany(mappedBy = "video", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("height DESC")
    private List<VideoRendition> renditions = new ArrayList<>();

    protected Video() { }

    public Video(String title, String description, String originalFilename, String contentType,
                 long sizeBytes, String storageDir, String uploadedBy) {
        this.title = title;
        this.description = description;
        this.originalFilename = originalFilename;
        this.contentType = contentType;
        this.sizeBytes = sizeBytes;
        this.storageDir = storageDir;
        this.uploadedBy = uploadedBy;
    }

    @PreUpdate
    void touch() {
        this.updatedAt = Instant.now();
    }

    /** Total segment count across every rendition — what the catalogue shows as "N segments". */
    public int totalSegments() {
        return renditions.stream().mapToInt(VideoRendition::getSegmentCount).sum();
    }

    public void addRendition(VideoRendition rendition) {
        rendition.setVideo(this);
        this.renditions.add(rendition);
    }

    public UUID getId() { return id; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
    public String getOriginalFilename() { return originalFilename; }
    public String getContentType() { return contentType; }
    public void setContentType(String contentType) { this.contentType = contentType; }
    public long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(long sizeBytes) { this.sizeBytes = sizeBytes; }
    public String getStorageDir() { return storageDir; }
    /** Assigned right after the first save, since the folder is named after the generated id. */
    public void setStorageDir(String storageDir) { this.storageDir = storageDir; }
    public String getSourceRel() { return sourceRel; }
    public void setSourceRel(String sourceRel) { this.sourceRel = sourceRel; }
    public String getMasterPlaylistRel() { return masterPlaylistRel; }
    public void setMasterPlaylistRel(String masterPlaylistRel) { this.masterPlaylistRel = masterPlaylistRel; }
    public String getPosterRel() { return posterRel; }
    public void setPosterRel(String posterRel) { this.posterRel = posterRel; }
    public String getSpriteRel() { return spriteRel; }
    public void setSpriteRel(String spriteRel) { this.spriteRel = spriteRel; }
    public UUID getMeetingId() { return meetingId; }
    public void setMeetingId(UUID meetingId) { this.meetingId = meetingId; }
    public String getTranscriptRel() { return transcriptRel; }
    public void setTranscriptRel(String transcriptRel) { this.transcriptRel = transcriptRel; }
    public Integer getSpriteIntervalSeconds() { return spriteIntervalSeconds; }
    public void setSpriteIntervalSeconds(Integer v) { this.spriteIntervalSeconds = v; }
    public Integer getSpriteColumns() { return spriteColumns; }
    public void setSpriteColumns(Integer spriteColumns) { this.spriteColumns = spriteColumns; }
    public Integer getSpriteTileWidth() { return spriteTileWidth; }
    public void setSpriteTileWidth(Integer spriteTileWidth) { this.spriteTileWidth = spriteTileWidth; }
    public Integer getSpriteTileHeight() { return spriteTileHeight; }
    public void setSpriteTileHeight(Integer spriteTileHeight) { this.spriteTileHeight = spriteTileHeight; }
    public Double getDurationSeconds() { return durationSeconds; }
    public void setDurationSeconds(Double durationSeconds) { this.durationSeconds = durationSeconds; }
    public Integer getWidth() { return width; }
    public void setWidth(Integer width) { this.width = width; }
    public Integer getHeight() { return height; }
    public void setHeight(Integer height) { this.height = height; }
    public Double getFrameRate() { return frameRate; }
    public void setFrameRate(Double frameRate) { this.frameRate = frameRate; }
    public boolean isHasAudio() { return hasAudio; }
    public void setHasAudio(boolean hasAudio) { this.hasAudio = hasAudio; }
    public VideoStatus getStatus() { return status; }
    public void setStatus(VideoStatus status) { this.status = status; }
    public DeliveryMode getDeliveryMode() { return deliveryMode; }
    public void setDeliveryMode(DeliveryMode deliveryMode) { this.deliveryMode = deliveryMode; }
    public VideoStorageMode getStorageMode() { return storageMode; }
    public void setStorageMode(VideoStorageMode storageMode) { this.storageMode = storageMode; }
    public int getProgressPercent() { return progressPercent; }
    public void setProgressPercent(int progressPercent) { this.progressPercent = progressPercent; }
    public String getErrorMessage() { return errorMessage; }
    public void setErrorMessage(String errorMessage) { this.errorMessage = errorMessage; }
    public Integer getSegmentSeconds() { return segmentSeconds; }
    public void setSegmentSeconds(Integer segmentSeconds) { this.segmentSeconds = segmentSeconds; }
    public String getUploadedBy() { return uploadedBy; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public List<VideoRendition> getRenditions() { return renditions; }
}
