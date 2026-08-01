package com.agmsentinel.model;

import jakarta.persistence.*;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * One rung of the adaptive ladder — e.g. "720p" at 2800 kbps — with its own media playlist and
 * its own list of segments. The player starts on whichever rung fits the measured bandwidth and
 * switches between rungs at segment boundaries, which is what keeps playback from stalling on a
 * slow connection instead of buffering.
 */
@Entity
@Table(name = "video_renditions", indexes =
        @Index(name = "video_renditions_video_idx", columnList = "video_id"))
public class VideoRendition {

    @Id
    @GeneratedValue
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "video_id", nullable = false)
    private Video video;

    /** Ladder label, also the folder name on the NAS: "1080p", "720p", … */
    @Column(nullable = false, length = 32)
    private String name;

    private int width;
    private int height;

    @Column(name = "video_bitrate_kbps")
    private int videoBitrateKbps;

    @Column(name = "audio_bitrate_kbps")
    private int audioBitrateKbps;

    /** Media playlist path relative to the video's storage dir, e.g. {@code hls/720p/index.m3u8}. */
    @Column(name = "playlist_rel", nullable = false)
    private String playlistRel;

    @Column(name = "segment_count", nullable = false)
    private int segmentCount;

    @Column(name = "total_bytes", nullable = false)
    private long totalBytes;

    @OneToMany(mappedBy = "rendition", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("seq ASC")
    private List<VideoSegment> segments = new ArrayList<>();

    protected VideoRendition() { }

    public VideoRendition(String name, int width, int height, int videoBitrateKbps,
                          int audioBitrateKbps, String playlistRel) {
        this.name = name;
        this.width = width;
        this.height = height;
        this.videoBitrateKbps = videoBitrateKbps;
        this.audioBitrateKbps = audioBitrateKbps;
        this.playlistRel = playlistRel;
    }

    public void addSegment(VideoSegment segment) {
        segment.setRendition(this);
        this.segments.add(segment);
        this.segmentCount = this.segments.size();
        this.totalBytes += segment.getByteSize();
    }

    public UUID getId() { return id; }
    public Video getVideo() { return video; }
    public void setVideo(Video video) { this.video = video; }
    public String getName() { return name; }
    public int getWidth() { return width; }
    public int getHeight() { return height; }
    public int getVideoBitrateKbps() { return videoBitrateKbps; }
    public int getAudioBitrateKbps() { return audioBitrateKbps; }
    public String getPlaylistRel() { return playlistRel; }
    public int getSegmentCount() { return segmentCount; }
    public void setSegmentCount(int segmentCount) { this.segmentCount = segmentCount; }
    public long getTotalBytes() { return totalBytes; }
    public List<VideoSegment> getSegments() { return segments; }
}
