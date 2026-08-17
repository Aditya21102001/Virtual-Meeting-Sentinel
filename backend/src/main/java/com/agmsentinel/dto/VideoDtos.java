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
            /** Whether WebVTT captions have been uploaded for this recording. */
            boolean hasTranscript,
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
                    video.getPosterRel() != null, video.getTranscriptRel() != null, sprite,
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
            /** WebVTT captions, when a transcript has been uploaded. Null otherwise. */
            String transcriptUrl,
            boolean adaptive,
            /** Likes and comments. Null until resolved — see VideoEngagementService.enrich. */
            VideoEngagement engagement,
            /**
             * Agenda items, in playing order. Empty when nobody has marked any up.
             *
             * <p>On the card rather than on {@link VideoView} because chapters are not a property of
             * the media file — they are authored per recording and edited independently of it, so a
             * rename must not have to invalidate anything about the video row itself.
             */
            List<ChapterView> chapters) {

        /** Same card with its engagement counts filled in. */
        public VideoCard withEngagement(VideoEngagement resolved) {
            return new VideoCard(video, ticket, ticketExpiresInSeconds, streamUrl, posterUrl,
                    spriteUrl, transcriptUrl, adaptive, resolved, chapters);
        }

        /** Same card with its agenda attached. */
        public VideoCard withChapters(List<ChapterView> resolved) {
            return new VideoCard(video, ticket, ticketExpiresInSeconds, streamUrl, posterUrl,
                    spriteUrl, transcriptUrl, adaptive, engagement, resolved);
        }
    }

    /**
     * One chapter as the player needs it.
     *
     * <p>No end time: a chapter runs until the next one starts, and the last to the end of the
     * recording. Sending both would be sending the same boundary twice, and the copies could
     * disagree — see VideoChapter.
     */
    public record ChapterView(UUID id, double startSeconds, String title, int ordinal) {

        public static ChapterView of(com.agmsentinel.model.VideoChapter chapter) {
            return new ChapterView(chapter.getId(), chapter.getStartSeconds(),
                                   chapter.getTitle(), chapter.getOrdinal());
        }
    }

    /**
     * One chapter as a moderator submits it. Ordinals are assigned server-side from the sorted start
     * times, so a client never has to number anything and cannot number it wrongly.
     */
    public record ChapterInput(double startSeconds, String title) { }

    /** A whole agenda, replacing whatever was there. See VideoChapterRepository.deleteByVideoId. */
    public record SaveChaptersRequest(UUID id, List<ChapterInput> chapters) { }

    /**
     * Engagement on a recording, resolved per viewer.
     *
     * <p>{@code likedByMe} is why likes are rows rather than a counter: the button has to render
     * differently for the person who already pressed it, and a total cannot say who is in it.
     */
    public record VideoEngagement(long likes, boolean likedByMe, long comments,
                                 /**
                                  * Distinct members who have watched this. One per person, not per
                                  * press of play — see VideoWatch for why that is the honest figure
                                  * for a board recording.
                                  */
                                 long viewers,
                                 /** Where this member stopped, 0 if they have not watched it. */
                                 double resumeAtSeconds) { }

    /** One comment as the browser sees it. {@code mine} drives whether Delete is offered. */
    public record CommentView(
            UUID id,
            String author,
            String body,
            Double atSeconds,
            Instant createdAt,
            Instant editedAt,
            boolean mine,
            /** True when the viewer may delete it: their own, or anything if they moderate. */
            boolean canDelete) { }

    /** A segment index page — the "which slice covers this second" view of a rendition. */
    public record SegmentView(int seq, String filename, double durationSeconds,
                              double startSeconds, long byteSize, String url) {

        public static SegmentView of(VideoSegment segment, String url) {
            return new SegmentView(segment.getSeq(), segment.getFilename(),
                    segment.getDurationSeconds(), segment.getStartSeconds(),
                    segment.getByteSize(), url);
        }
    }

    /**
     * Where a given moment lives in the ladder: the segment covering it, plus enough surrounding
     * numbers to read it as a position rather than an isolated row.
     *
     * <p>This is the answer to "resume at 21:30" as the <em>database</em> gives it — the player
     * works the same thing out from the playlist it already holds, and does not wait for this. It
     * is what makes the segment index demonstrably load-bearing instead of decorative: one indexed
     * lookup turns a timestamp into a slice, a position in the sequence, and a byte offset.
     */
    public record SegmentLocation(
            SegmentView segment,
            String rendition,
            /** Segments in this rung, so the answer reads "215 of 271". */
            int segmentCount,
            /** Bytes before this segment in this rung — how far in the seek lands. */
            long byteOffset,
            /** Total bytes in this rung, for the "of N" on the offset. */
            long renditionBytes) { }

    /**
     * One way to download a recording, with a URL ready to use.
     *
     * <p>Storing the original is not what makes a download possible — every rung of the ladder is a
     * complete copy of the recording at that quality, and joining its segments reproduces it. So the
     * absence of an original narrows the choice of formats, not the ability to download.
     */
    public record DownloadOption(
            /** ORIGINAL (the uploaded file) or RENDITION (a rung, rebuilt from its segments). */
            String kind,
            /** Rung name for a RENDITION ({@code 480p}); null for the original. */
            String rendition,
            String label,
            /** Frame height, so a client can order or badge the options. 0 when unknown. */
            int height,
            long sizeBytes,
            String filename,
            String contentType,
            String url) { }

    /**
     * Everything this recording can be downloaded as, highest quality first.
     *
     * <p>Resolved server-side in one call because the client cannot know any of it: whether the
     * original survived, how large each rung is, or what each one would be named.
     */
    public record DownloadOptions(
            List<DownloadOption> options,
            /** Explains the container when rungs are on offer. Null when there is nothing to say. */
            String note) { }

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
