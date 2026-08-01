package com.agmsentinel.model;

import jakarta.persistence.*;
import java.util.UUID;

/**
 * One ~6-second slice of one rendition — the unit the browser actually downloads.
 *
 * <p>This table is the segment index: it records, for every slice, its ordinal, exact duration,
 * size, and the cumulative offset at which it starts. That is what makes on-demand playback
 * possible without downloading the file:
 * <ul>
 *   <li>a seek to 21:30 becomes a lookup for the segment whose {@code startSeconds} spans it, so
 *       the server can answer "fetch segment 215" instead of streaming from zero;</li>
 *   <li>the stored durations and sizes let the catalogue report real segment/bitrate stats without
 *       re-reading the NAS;</li>
 *   <li>a truncated transcode is detectable — the row count won't match the playlist.</li>
 * </ul>
 */
@Entity
@Table(name = "video_segments",
       indexes = @Index(name = "video_segments_rendition_seq_idx", columnList = "rendition_id, seq"),
       uniqueConstraints = @UniqueConstraint(name = "video_segments_unique_seq",
                                            columnNames = {"rendition_id", "seq"}))
public class VideoSegment {

    @Id
    @GeneratedValue
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "rendition_id", nullable = false)
    private VideoRendition rendition;

    /** 0-based position in the playlist. */
    @Column(nullable = false)
    private int seq;

    /** Segment filename relative to the rendition folder, e.g. {@code seg_00042.ts}. */
    @Column(name = "filename", nullable = false)
    private String filename;

    /** Exact EXTINF duration from the playlist (segments are not all exactly 6 s). */
    @Column(name = "duration_seconds", nullable = false)
    private double durationSeconds;

    /** Playback position where this segment starts — the seek index. */
    @Column(name = "start_seconds", nullable = false)
    private double startSeconds;

    @Column(name = "byte_size", nullable = false)
    private long byteSize;

    protected VideoSegment() { }

    public VideoSegment(int seq, String filename, double durationSeconds,
                        double startSeconds, long byteSize) {
        this.seq = seq;
        this.filename = filename;
        this.durationSeconds = durationSeconds;
        this.startSeconds = startSeconds;
        this.byteSize = byteSize;
    }

    public UUID getId() { return id; }
    public VideoRendition getRendition() { return rendition; }
    public void setRendition(VideoRendition rendition) { this.rendition = rendition; }
    public int getSeq() { return seq; }
    public String getFilename() { return filename; }
    public double getDurationSeconds() { return durationSeconds; }
    public double getStartSeconds() { return startSeconds; }
    public long getByteSize() { return byteSize; }
}
