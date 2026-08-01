package com.agmsentinel.service;

import com.agmsentinel.dto.VideoDtos.VideoCard;
import com.agmsentinel.dto.VideoDtos.VideoView;
import com.agmsentinel.model.Video;
import com.agmsentinel.model.VideoStatus;
import com.agmsentinel.security.PlaybackTicketService;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.net.URLEncoder;
import java.util.UUID;

/**
 * Builds the ticketed media URLs the browser uses.
 *
 * <p>All paths are root-relative ({@code /api/videos/…}) rather than absolute: the SPA already
 * knows its API origin, and hard-coding a host here would break the moment the backend moved or
 * sat behind a different proxy.
 */
@Service
public class VideoUrlFactory {

    public static final String BASE = "/api/videos";

    private final PlaybackTicketService tickets;

    public VideoUrlFactory(PlaybackTicketService tickets) {
        this.tickets = tickets;
    }

    /**
     * Turn an entity into the full client payload, minting a ticket for its media URLs.
     *
     * <p>Engagement counts are left null here and filled in by
     * {@link VideoEngagementService#enrich} — this class builds URLs and must not turn rendering one
     * card into a database round-trip, which for a library page would mean dozens of them.
     */
    public VideoCard card(Video video, String subject) {
        VideoView view = VideoView.of(video);
        boolean playable = video.getStatus() == VideoStatus.READY;
        if (!playable) {
            return new VideoCard(view, null, 0, null, null, null, null, false, null);
        }

        String ticket = tickets.issue(subject == null ? "anonymous" : subject, video.getId());
        boolean adaptive = video.getDeliveryMode() == Video.DeliveryMode.HLS
                && video.getMasterPlaylistRel() != null
                && !video.getRenditions().isEmpty();

        String stream = adaptive
                ? masterUrl(video.getId(), ticket)
                : rawUrl(video.getId(), ticket);

        return new VideoCard(view, ticket, tickets.ttlSeconds(), stream,
                video.getPosterRel() != null ? posterUrl(video.getId(), ticket) : null,
                video.getSpriteRel() != null ? spriteUrl(video.getId(), ticket) : null,
                video.getTranscriptRel() != null ? transcriptUrl(video.getId(), ticket) : null,
                adaptive, null);
    }

    public String masterUrl(UUID videoId, String ticket) {
        return BASE + "/" + videoId + "/master.m3u8" + query(ticket);
    }

    public String mediaPlaylistUrl(UUID videoId, String rendition, String ticket) {
        return BASE + "/" + videoId + "/r/" + rendition + "/index.m3u8" + query(ticket);
    }

    public String segmentUrl(UUID videoId, String rendition, String filename, String ticket) {
        return BASE + "/" + videoId + "/r/" + rendition + "/" + filename + query(ticket);
    }

    public String rawUrl(UUID videoId, String ticket) {
        return BASE + "/" + videoId + "/raw" + query(ticket);
    }

    /**
     * A save-to-disk URL. GET, like every other media route and for the same reason — a download is
     * a browser navigation, and a navigation is a GET; it also means the transfer can be resumed
     * and does not have to survive in the tab's memory.
     *
     * @param rendition rung to rebuild from segments, or null to download the stored original
     */
    public String downloadUrl(UUID videoId, String rendition, String ticket) {
        String base = BASE + "/" + videoId + "/download" + query(ticket);
        if (rendition == null || rendition.isBlank()) return base;
        String separator = base.contains("?") ? "&" : "?";
        return base + separator + "rendition="
               + URLEncoder.encode(rendition, StandardCharsets.UTF_8);
    }

    public String posterUrl(UUID videoId, String ticket) {
        return BASE + "/" + videoId + "/poster.jpg" + query(ticket);
    }

    public String spriteUrl(UUID videoId, String ticket) {
        return BASE + "/" + videoId + "/sprite.jpg" + query(ticket);
    }

    /**
     * WebVTT captions. GET like the rest of the media, and for the same reason: this one goes into a
     * {@code <track>} element, which the browser fetches itself.
     */
    public String transcriptUrl(UUID videoId, String ticket) {
        return BASE + "/" + videoId + "/transcript.vtt" + query(ticket);
    }

    /**
     * Rendition names and segment filenames are server-generated ({@code 720p}, {@code seg_00042.ts})
     * so they go into the path verbatim; only the ticket is a query value that needs encoding.
     */
    private String query(String ticket) {
        return ticket == null || ticket.isBlank()
                ? ""
                : "?t=" + URLEncoder.encode(ticket, StandardCharsets.UTF_8);
    }
}
