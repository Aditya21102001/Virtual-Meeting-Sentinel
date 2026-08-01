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

    /** Turn an entity into the full client payload, minting a ticket for its media URLs. */
    public VideoCard card(Video video, String subject) {
        VideoView view = VideoView.of(video);
        boolean playable = video.getStatus() == VideoStatus.READY;
        if (!playable) {
            return new VideoCard(view, null, 0, null, null, null, false);
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
                adaptive);
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

    public String posterUrl(UUID videoId, String ticket) {
        return BASE + "/" + videoId + "/poster.jpg" + query(ticket);
    }

    public String spriteUrl(UUID videoId, String ticket) {
        return BASE + "/" + videoId + "/sprite.jpg" + query(ticket);
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
