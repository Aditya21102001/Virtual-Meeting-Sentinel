package com.agmsentinel.dto;

import com.agmsentinel.model.Video;
import com.agmsentinel.model.VideoRendition;
import com.agmsentinel.model.VideoSegment;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Wire shapes for the video library. Kept separate from the entities so the browser never sees
 * absolute NAS paths — only relative media paths, which the stream controller re-resolves under
 * the video's own folder.
 */
public final class VideoDtos {

    private VideoDtos() { }

    /** One rung of the ladder as the player's quality menu sees it. */
    public record RenditionView(
            String name,
            int width,
            int height,
            int videoBitrateKbps,
            int audioBitrateKbps,
            int segmentCount,
            long totalBytes,
            String playlistPath) {

        public static RenditionView of(VideoRendition rendition) {
            return new RenditionView(rendition.getName(), rendition.getWidth(), rendition.getHeight(),
                    rendition.getVideoBitrateKbps(), rendition.getAudioBitrateKbps(),
                    rendition.getSegmentCount(), rendition.getTotalBytes(), rendition.getPlaylistRel());
        }
    }

    /** Seek-preview filmstrip geometry, so the player can slice the sprite with CSS. */
    public record SpriteView(int intervalSeconds, int columns, int tileWidth, int tileHeight) { }

    /** A catalogue entry plus everything needed to start playback. */
    public record VideoView(
            UUID id,
            String title,
            String description,
            String originalFilename,
            String status,
            String deliveryMode,
            /** FILESYSTEM or DATABASE — where this video's bytes actually live. */
            String storageMode,
            int progressPercent,
            String errorMessage,
            Double durationSeconds,
            Integer width,
            Integer height,
            Double frameRate,
            boolean hasAudio,
            long sizeBytes,
            Integer segmentSeconds,
            int totalSegments,
            boolean hasPoster,
            SpriteView sprite,
            List<RenditionView> renditions,
            String uploadedBy,
            Instant createdAt,
            Instant updatedAt) {

        public static VideoView of(Video video) {
            SpriteView sprite = video.getSpriteRel() == null ? null : new SpriteView(
                    orZero(video.getSpriteIntervalSeconds()),
                    orZero(video.getSpriteColumns()),
                    orZero(video.getSpriteTileWidth()),
                    orZero(video.getSpriteTileHeight()));

            return new VideoView(
                    video.getId(), video.getTitle(), video.getDescription(),
                    video.getOriginalFilename(), video.getStatus().name(),
                    video.getDeliveryMode().name(), video.getStorageMode().name(),
                    video.getProgressPercent(),
                    video.getErrorMessage(), video.getDurationSeconds(),
                    video.getWidth(), video.getHeight(), video.getFrameRate(), video.isHasAudio(),
                    video.getSizeBytes(), video.getSegmentSeconds(), video.totalSegments(),
                    video.getPosterRel() != null, sprite,
                    video.getRenditions().stream().map(RenditionView::of).toList(),
                    video.getUploadedBy(), video.getCreatedAt(), video.getUpdatedAt());
        }

        private static int orZero(Integer value) {
            return value == null ? 0 : value;
        }
    }

    /**
     * A catalogue entry together with everything needed to render and play it.
     *
     * <p>The URLs already carry a signed playback ticket, which is why the browser can drop them
     * straight into {@code <img src>} / {@code <video src>} / hls.js without any way to attach an
     * Authorization header. {@code streamUrl} is the HLS master playlist when the video was
     * segmented, and the raw Range-served file when it wasn't — {@code adaptive} says which.
     */
    public record VideoCard(
            VideoView video,
            String ticket,
            long ticketExpiresInSeconds,
            String streamUrl,
            String posterUrl,
            String spriteUrl,
            boolean adaptive) { }

    /** A segment index page — the "which slice covers this second" view of a rendition. */
    public record SegmentView(int seq, String filename, double durationSeconds,
                              double startSeconds, long byteSize, String url) {

        public static SegmentView of(VideoSegment segment, String url) {
            return new SegmentView(segment.getSeq(), segment.getFilename(),
                    segment.getDurationSeconds(), segment.getStartSeconds(),
                    segment.getByteSize(), url);
        }
    }

    /** Storage + tooling health for the admin screen. */
    public record VideoStorageStatus(
            /** FILESYSTEM or DATABASE — where new uploads will be stored. */
            String storageMode,
            String storagePath,
            String configuredNasPath,
            boolean nasAvailable,
            String storageProblem,
            long usableSpaceBytes,
            /** Bytes currently held in {@code video_assets} across all videos. */
            long databaseStoredBytes,
            /** Total budget for database storage; uploads are refused beyond it. */
            long databaseMaxTotalBytes,
            boolean segmentationAvailable,
            String ffmpegVersion,
            int segmentSeconds,
            List<Integer> ladder,
            /** The limit actually in force — smaller in database mode than on the filesystem. */
            long maxUploadBytes,
            int videoCount,
            int readyCount) { }
}
