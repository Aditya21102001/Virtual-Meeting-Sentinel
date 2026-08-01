package com.agmsentinel.controller;

import com.agmsentinel.dto.VideoDtos.DownloadPlan;
import com.agmsentinel.dto.VideoDtos.SegmentLocation;
import com.agmsentinel.dto.VideoDtos.SegmentView;
import com.agmsentinel.dto.VideoDtos.VideoCard;
import com.agmsentinel.model.Video;
import com.agmsentinel.model.VideoRendition;
import com.agmsentinel.model.VideoSegment;
import com.agmsentinel.security.PlaybackTicketService;
import com.agmsentinel.service.VideoLibraryService;
import com.agmsentinel.service.VideoMediaStore;
import com.agmsentinel.service.VideoUrlFactory;
import org.springframework.core.io.Resource;
import org.springframework.http.*;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Playback surface: the catalogue, the segment index, and the media bytes themselves.
 *
 * <h2>How on-demand playback works here</h2>
 * The browser never downloads the recording. It fetches {@code master.m3u8}, picks a rung, then
 * pulls one ~6 s {@code .ts} segment at a time, staying a few segments ahead of the playhead. A
 * seek discards the buffer and starts fetching from the segment covering the new position, so
 * jumping to 40:00 in an hour-long recording costs one segment, not 40 minutes of video. When
 * throughput drops the player switches to a lower rung at the next boundary instead of stalling —
 * that is the "never buffers" behaviour, and it is why the file is segmented in the first place.
 *
 * <h2>Why the media routes are still GET</h2>
 * Every data endpoint in this application is a named POST, but media delivery cannot be: the
 * requests are issued by the browser itself, not by application code. {@code <video src>},
 * {@code <img src>} and native HLS only ever issue GET, hls.js fetches each segment URI listed in a
 * playlist with GET, and HTTP Range — the mechanism progressive seeking is built on — is defined
 * for GET. A POST here would simply never be sent. These are also the routes where the URL is
 * already self-describing in the network panel ({@code master.m3u8}, {@code seg_00042.ts}), which
 * is what the POST convention exists to achieve elsewhere.
 *
 * <h2>Authorisation</h2>
 * Media requests come from the browser's media stack, which cannot attach an Authorization header,
 * so each URL carries a short-lived {@link PlaybackTicketService} ticket scoped to one video. Because
 * relative playlist URIs are resolved without the query string, manifests are <b>rewritten on the
 * way out</b> to carry the ticket forward onto every child URI.
 */
@RestController
@RequestMapping(VideoUrlFactory.BASE)
public class VideoController {

    private static final Logger log = LoggerFactory.getLogger(VideoController.class);

    /** Only ever serve files that look like generated segments. */
    private static final Pattern SEGMENT_NAME = Pattern.compile("^seg_\\d{1,9}\\.ts$");
    /** Rung folder names, as produced by the ladder ("720p"). */
    private static final Pattern RENDITION_NAME = Pattern.compile("^[0-9]{2,4}p$");

    private static final MediaType HLS = MediaType.parseMediaType("application/vnd.apple.mpegurl");
    private static final MediaType MP2T = MediaType.parseMediaType("video/mp2t");

    /**
     * Cap on how much one progressive request may return. Bounded chunks are what make a raw MP4
     * behave like segments: the browser issues a series of small Range requests as it plays instead
     * of pulling the whole file in one response.
     */
    private static final long RANGE_CHUNK_BYTES = 4L * 1024 * 1024;

    private final VideoLibraryService library;
    private final VideoMediaStore media;
    private final VideoUrlFactory urls;
    private final PlaybackTicketService tickets;

    public VideoController(VideoLibraryService library, VideoMediaStore media,
                          VideoUrlFactory urls, PlaybackTicketService tickets) {
        this.library = library;
        this.media = media;
        this.urls = urls;
        this.tickets = tickets;
    }

    // ---- catalogue -----------------------------------------------------------
    //
    // Named POST routes with the video id in the body. The network panel labels a request with the
    // last path segment, so "/api/videos/{uuid}" showed up as a raw UUID and told you nothing about
    // which call it was. See VideoAdminController for the full rationale. The media routes below
    // are the exception and stay GET.

    /** Identifies one video, optionally narrowed to a single rung of the ladder. */
    public record VideoRef(UUID id, String rendition) { }

    /** A seek lookup: which slice of {@code rendition} covers {@code seconds}. */
    public record SegmentAtRequest(UUID id, double seconds, String rendition) { }

    /**
     * The member library: playable videos, each with a fresh ticket so posters and playback work
     * immediately, plus any recording still being segmented so an upload in progress is visible
     * rather than absent. A non-{@code READY} card carries no ticket or stream URL.
     */
    @PostMapping("/list-library")
    public List<VideoCard> listLibrary() {
        String subject = currentSubject();
        return library.listVisible().stream().map(v -> urls.card(v, subject)).toList();
    }

    @PostMapping("/video-details")
    public VideoCard videoDetails(@RequestBody VideoRef req) {
        return urls.card(library.getPlayable(req.id()), currentSubject());
    }

    /**
     * The segment index straight from the database — ordinal, duration, start time and size of
     * every slice. The player doesn't need this (the playlist carries the same information), but it
     * makes the segmentation inspectable and drives the "N segments" detail in the UI.
     */
    @PostMapping("/list-segments")
    public List<SegmentView> listSegments(@RequestBody VideoRef req) {
        UUID id = req.id();
        Video video = library.getPlayable(id);
        VideoRendition chosen = library.pickRendition(video, req.rendition());
        String ticket = tickets.issue(currentSubject(), id);
        return library.segmentsOf(id, chosen.getName()).stream()
                .map(s -> SegmentView.of(s,
                        urls.segmentUrl(id, chosen.getName(), s.getFilename(), ticket)))
                .toList();
    }

    /**
     * Which segment covers a given second — the database answering a seek.
     *
     * <p>This is what "resume at 21:30" resolves to, and the player does <b>not</b> wait for it:
     * hls.js already holds the playlist and works the same thing out locally, so blocking playback
     * on a round-trip here would add latency to buy nothing. It is called alongside the resume so
     * the UI can show where the seek actually landed — segment 215 of 271, 248 MB in — which is the
     * index doing visible work rather than sitting in a table nothing reads.
     */
    @PostMapping("/find-segment-at")
    public SegmentLocation findSegmentAt(@RequestBody SegmentAtRequest req) {
        UUID id = req.id();
        Video video = library.getPlayable(id);
        VideoRendition chosen = library.pickRendition(video, req.rendition());
        VideoSegment segment = library.segmentAt(id, chosen.getName(), req.seconds())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "No segment covers " + req.seconds() + "s."));
        String ticket = tickets.issue(currentSubject(), id);
        return new SegmentLocation(
                SegmentView.of(segment, urls.segmentUrl(id, chosen.getName(), segment.getFilename(), ticket)),
                chosen.getName(),
                chosen.getSegmentCount(),
                library.bytesBefore(chosen, segment.getSeq()),
                chosen.getTotalBytes());
    }

    // ---- download ------------------------------------------------------------

    /**
     * Resolve what a download will produce, before starting one.
     *
     * <p>POST, because it is an ordinary data call; the transfer it points at is a GET, because a
     * download is a browser navigation. Splitting it this way is also what lets the UI say "12.4 MB
     * MP4" or explain that it is getting a rebuilt ladder — neither of which the client can work
     * out on its own, since whether the original survived depends on the storage mode it was
     * uploaded under.
     */
    @PostMapping("/prepare-download")
    public DownloadPlan prepareDownload(@RequestBody VideoRef req) {
        Video video = library.getPlayable(req.id());
        String ticket = tickets.issue(currentSubject(), video.getId());
        String sourceRel = video.getSourceRel();

        if (sourceRel != null && media.exists(video, sourceRel)) {
            return new DownloadPlan(
                    urls.downloadUrl(video.getId(), null, ticket),
                    downloadName(video, "." + extensionOf(sourceRel)),
                    guessVideoType(video).toString(),
                    media.size(video, sourceRel),
                    "ORIGINAL",
                    null);
        }

        // No original left — database storage drops it once the ladder exists. The segments are
        // still a complete copy of the recording, so hand those over instead of refusing.
        VideoRendition chosen = library.pickRendition(video, req.rendition());
        if (chosen.getSegmentCount() == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "There is nothing to download: this recording has neither a stored original "
                    + "nor any segments.");
        }
        return new DownloadPlan(
                urls.downloadUrl(video.getId(), chosen.getName(), ticket),
                downloadName(video, "-" + chosen.getName() + ".ts"),
                MP2T.toString(),
                chosen.getTotalBytes(),
                "SEGMENTS",
                "The original upload was discarded after segmenting, so this is the "
                + chosen.getName() + " rendition rebuilt by joining its " + chosen.getSegmentCount()
                + " segments. That produces a valid MPEG-TS file — VLC, ffmpeg and most desktop "
                + "players open it directly, though some tools expect .mp4. Set "
                + "video.database.keep-source=true to keep originals for future uploads.");
    }

    /**
     * Stream the recording to disk.
     *
     * <p>Either the stored original, or — with {@code rendition} — one rung rebuilt by writing its
     * segments back to back. Concatenation is enough because these are MPEG-TS: each segment is a
     * self-contained sequence of 188-byte packets, so joining them yields a valid stream with no
     * remux and, more to the point, no ffmpeg process on a host that cannot spare one.
     *
     * <p>Written straight to the response a piece at a time, so serving a download costs a chunk of
     * memory rather than a copy of the recording — the same reason the transcode drains as it goes.
     */
    @GetMapping("/{id}/download")
    public ResponseEntity<StreamingResponseBody> download(
            @PathVariable UUID id,
            @RequestParam(name = "t", required = false) String ticket,
            @RequestParam(required = false) String rendition) {

        Video video = authorise(id, ticket);

        if (rendition == null || rendition.isBlank()) {
            String sourceRel = video.getSourceRel();
            if (sourceRel == null || !media.exists(video, sourceRel)) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "The original file for this recording is no longer stored. Download a "
                        + "rendition instead.");
            }
            return attachment(downloadName(video, "." + extensionOf(sourceRel)),
                    guessVideoType(video), media.size(video, sourceRel),
                    out -> media.copyTo(video, sourceRel, out));
        }

        VideoRendition chosen = requireRendition(video, rendition);
        List<VideoSegment> segments = library.segmentsOf(id, chosen.getName());
        if (segments.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "That rendition has no segments to join.");
        }
        String prefix = siblingOf(chosen.getPlaylistRel(), "");
        return attachment(downloadName(video, "-" + chosen.getName() + ".ts"),
                MP2T, chosen.getTotalBytes(),
                out -> {
                    for (VideoSegment segment : segments) {
                        media.copyTo(video, prefix + segment.getFilename(), out);
                    }
                });
    }

    private ResponseEntity<StreamingResponseBody> attachment(String filename, MediaType type,
                                                             long length,
                                                             StreamingResponseBody body) {
        return ResponseEntity.ok()
                .contentType(type)
                .contentLength(length)
                // filename* (RFC 5987) so a title with non-ASCII characters survives the trip.
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename(filename, StandardCharsets.UTF_8).build().toString())
                .cacheControl(CacheControl.noStore())
                .body(body);
    }

    /**
     * A filename the user's operating system will accept, built from the title rather than from
     * {@code source.mp4} — which is what every recording is called in storage.
     */
    private String downloadName(Video video, String suffix) {
        String base = video.getTitle() == null || video.getTitle().isBlank()
                ? "recording"
                : video.getTitle().trim();
        base = base.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (base.isEmpty()) base = "recording";
        if (base.length() > 80) base = base.substring(0, 80).trim();
        return base + suffix;
    }

    private String extensionOf(String path) {
        int dot = path.lastIndexOf('.');
        return dot < 0 ? "mp4" : path.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    // ---- media ---------------------------------------------------------------

    /**
     * The master playlist, rewritten so each variant URI points at this controller and carries the
     * ticket. Without the rewrite the player would resolve {@code 720p/index.m3u8} relative to the
     * master and lose the {@code ?t=} — the very next request would be a 403.
     */
    @GetMapping(value = "/{id}/master.m3u8", produces = "application/vnd.apple.mpegurl")
    public ResponseEntity<String> master(@PathVariable UUID id,
                                        @RequestParam(name = "t", required = false) String ticket) {
        Video video = authorise(id, ticket);
        if (video.getMasterPlaylistRel() == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This video has no HLS manifest; use the progressive stream instead.");
        }
        String body = rewriteMaster(media.readText(video, video.getMasterPlaylistRel()), video, ticket);
        return manifestResponse(body);
    }

    /** A rung's media playlist: the list of segments, each URI carrying the ticket forward. */
    @GetMapping(value = "/{id}/r/{rendition}/index.m3u8", produces = "application/vnd.apple.mpegurl")
    public ResponseEntity<String> mediaPlaylist(@PathVariable UUID id,
                                               @PathVariable String rendition,
                                               @RequestParam(name = "t", required = false) String ticket) {
        Video video = authorise(id, ticket);
        VideoRendition chosen = requireRendition(video, rendition);
        String body = appendTicketToUris(media.readText(video, chosen.getPlaylistRel()), ticket);
        return manifestResponse(body);
    }

    /**
     * One segment. Segments are immutable once written, so they get a long private cache lifetime —
     * re-watching or scrubbing backwards then costs nothing.
     */
    @GetMapping("/{id}/r/{rendition}/{filename}")
    public ResponseEntity<Resource> segment(@PathVariable UUID id,
                                           @PathVariable String rendition,
                                           @PathVariable String filename,
                                           @RequestParam(name = "t", required = false) String ticket) {
        Video video = authorise(id, ticket);
        VideoRendition chosen = requireRendition(video, rendition);
        if (!SEGMENT_NAME.matcher(filename).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Not a segment filename.");
        }
        // The segment sits beside its playlist, so its stored path is derived from the rendition's
        // rather than taken from the request — the client only ever supplies the bare filename.
        String segmentPath = siblingOf(chosen.getPlaylistRel(), filename);
        if (!media.exists(video, segmentPath)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Segment not found.");
        }
        return ResponseEntity.ok()
                .contentType(MP2T)
                .contentLength(media.size(video, segmentPath))
                .cacheControl(CacheControl.maxAge(Duration.ofDays(365)).cachePrivate().immutable())
                .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                .body(media.resource(video, segmentPath));
    }

    /**
     * Progressive fallback for videos that were never segmented (no ffmpeg at upload time).
     * Honouring {@code Range} in bounded chunks keeps the "don't download the whole file" property:
     * the browser asks for the bytes around the playhead and seeking jumps straight to an offset.
     */
    @GetMapping("/{id}/raw")
    public ResponseEntity<Resource> raw(@PathVariable UUID id,
                                       @RequestParam(name = "t", required = false) String ticket,
                                       @RequestHeader HttpHeaders headers) throws IOException {
        Video video = authorise(id, ticket);
        String sourcePath = video.getSourceRel();
        if (sourcePath == null || !media.exists(video, sourcePath)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "The original file for this video is no longer available.");
        }
        long length = media.size(video, sourcePath);
        MediaType type = guessVideoType(video);
        CacheControl cache = CacheControl.maxAge(Duration.ofDays(7)).cachePrivate();

        List<HttpRange> ranges;
        try {
            ranges = headers.getRange();
        } catch (IllegalArgumentException ex) {
            // A malformed Range header must be answered with 416, not a 500.
            return unsatisfiable(length);
        }

        if (ranges.isEmpty()) {
            return ResponseEntity.ok()
                    .contentType(type)
                    .contentLength(length)
                    .cacheControl(cache)
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .body(media.resource(video, sourcePath));
        }

        HttpRange range = ranges.get(0);
        long start = range.getRangeStart(length);
        if (start >= length) {
            return unsatisfiable(length);
        }
        long end = Math.min(range.getRangeEnd(length), start + RANGE_CHUNK_BYTES - 1);
        long count = end - start + 1;

        // Read only the requested window — a bounded channel read on disk, or a SQL binary
        // substring in database mode. Not Spring's ResourceRegion: that converter refuses to write
        // when the handler declares a wildcard body type, and doing the read here keeps
        // Content-Range and Content-Length provably consistent with the bytes actually sent.
        return ResponseEntity.status(HttpStatus.PARTIAL_CONTENT)
                .contentType(type)
                .contentLength(count)
                .cacheControl(cache)
                .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                .header(HttpHeaders.CONTENT_RANGE, "bytes " + start + "-" + end + "/" + length)
                .body(media.range(video, sourcePath, start, count));
    }

    private ResponseEntity<Resource> unsatisfiable(long length) {
        return ResponseEntity.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                .header(HttpHeaders.CONTENT_RANGE, "bytes */" + length)
                .build();
    }

    @GetMapping("/{id}/poster.jpg")
    public ResponseEntity<Resource> poster(@PathVariable UUID id,
                                          @RequestParam(name = "t", required = false) String ticket) {
        Video video = authorise(id, ticket);
        return image(video, video.getPosterRel(), "poster");
    }

    /** The seek-preview filmstrip — one image the player slices with CSS as the user scrubs. */
    @GetMapping("/{id}/sprite.jpg")
    public ResponseEntity<Resource> sprite(@PathVariable UUID id,
                                          @RequestParam(name = "t", required = false) String ticket) {
        Video video = authorise(id, ticket);
        return image(video, video.getSpriteRel(), "sprite");
    }

    // ---- helpers -------------------------------------------------------------

    private ResponseEntity<Resource> image(Video video, String relativePath, String what) {
        if (relativePath == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No " + what + " for this video.");
        }
        if (!media.exists(video, relativePath)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Missing " + what + " image.");
        }
        return ResponseEntity.ok()
                .contentType(MediaType.IMAGE_JPEG)
                .contentLength(media.size(video, relativePath))
                .cacheControl(CacheControl.maxAge(Duration.ofDays(30)).cachePrivate())
                .body(media.resource(video, relativePath));
    }

    /**
     * Manifests are generated per request and embed a ticket that expires, so they must not be
     * cached — a cached copy would keep handing a dead ticket to the player.
     */
    private ResponseEntity<String> manifestResponse(String body) {
        return ResponseEntity.ok()
                .contentType(HLS)
                .cacheControl(CacheControl.noStore())
                .contentLength(body.getBytes(StandardCharsets.UTF_8).length)
                .body(body);
    }

    /**
     * Accept either a valid playback ticket (the browser's media stack) or an authenticated
     * session (hls.js sending a bearer header, curl, tests). Everything else is a 403.
     */
    private Video authorise(UUID id, String ticket) {
        if (!tickets.isValidFor(ticket, id) && !isAuthenticated()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "A valid playback ticket is required for this media URL.");
        }
        return library.getPlayable(id);
    }

    private VideoRendition requireRendition(Video video, String name) {
        if (!RENDITION_NAME.matcher(name).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Not a rendition name.");
        }
        return library.pickRendition(video, name);
    }

    private boolean isAuthenticated() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth != null && auth.isAuthenticated() && !(auth instanceof AnonymousAuthenticationToken);
    }

    private String currentSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth == null ? "anonymous" : String.valueOf(auth.getName());
    }

    /**
     * Swap the last path element of a stored relative path — {@code hls/720p/index.m3u8} plus
     * {@code seg_00042.ts} gives {@code hls/720p/seg_00042.ts}.
     *
     * <p>Building the path from the rendition's own playlist location, rather than from anything the
     * client sent beyond the bare filename, means a request can only ever name a file inside its own
     * rung's directory.
     */
    private String siblingOf(String relativePath, String filename) {
        String normalised = relativePath.replace('\\', '/');
        int slash = normalised.lastIndexOf('/');
        return slash < 0 ? filename : normalised.substring(0, slash + 1) + filename;
    }

    /**
     * Rewrite ffmpeg's variant URIs ({@code 720p/index.m3u8}) into this controller's routes
     * ({@code r/720p/index.m3u8?t=…}). Comment/tag lines pass through untouched, so the
     * BANDWIDTH/RESOLUTION/CODECS attributes the player needs for rung selection survive intact.
     *
     * <p>Each URI is resolved against the video's own renditions rather than parsed as a path.
     * ffmpeg writes the variant URI using the platform separator, so on Windows the master
     * contains {@code 720p\index.m3u8} — splitting on '/' alone silently produced a rung named
     * "720p\index.m3u8" and every variant 404'd. Matching the stored {@code playlistRel} makes the
     * rewrite independent of which separator ffmpeg happened to use.
     */
    private String rewriteMaster(String playlist, Video video, String ticket) {
        List<String> out = new ArrayList<>();
        for (String raw : playlist.split("\\r?\\n")) {
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("#")) {
                out.add(raw);
                continue;
            }
            VideoRendition rendition = matchRendition(video, line);
            if (rendition == null) {
                // An unrecognised variant is dropped rather than emitted as a broken URI: the
                // player then simply doesn't offer that rung, instead of failing mid-playback.
                log.warn("Master playlist for video {} references unknown variant '{}' — dropping it.",
                         video.getId(), line);
                continue;
            }
            out.add(relative(urls.mediaPlaylistUrl(video.getId(), rendition.getName(), ticket)));
        }
        return String.join("\n", out) + "\n";
    }

    /** Find the rendition a master-playlist URI refers to, ignoring path-separator style. */
    private VideoRendition matchRendition(Video video, String uri) {
        String normalised = uri.replace('\\', '/');
        String firstSegment = normalised.contains("/")
                ? normalised.substring(0, normalised.indexOf('/'))
                : normalised;
        for (VideoRendition rendition : video.getRenditions()) {
            if (rendition.getName().equalsIgnoreCase(firstSegment)) return rendition;
            String stored = rendition.getPlaylistRel() == null
                    ? ""
                    : rendition.getPlaylistRel().replace('\\', '/');
            if (!stored.isEmpty() && stored.endsWith(normalised)) return rendition;
        }
        return null;
    }

    /** Append the ticket to each segment URI; the filename stays relative to the playlist. */
    private String appendTicketToUris(String playlist, String ticket) {
        if (ticket == null || ticket.isBlank()) return playlist;
        List<String> out = new ArrayList<>();
        for (String raw : playlist.split("\\r?\\n")) {
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("#")) {
                out.add(raw);
            } else {
                out.add(line + (line.contains("?") ? "&" : "?") + "t=" + ticket);
            }
        }
        return String.join("\n", out) + "\n";
    }

    /**
     * Strip the {@code /api/videos/{id}/} prefix so the URI stays relative to the master playlist.
     * A relative URI keeps working behind any proxy prefix or origin rewrite; an absolute path
     * would break the moment the API were mounted somewhere else.
     */
    private String relative(String absolutePath) {
        int marker = absolutePath.indexOf("/r/");
        return marker < 0 ? absolutePath : absolutePath.substring(marker + 1);
    }

    private MediaType guessVideoType(Video video) {
        String declared = video.getContentType();
        if (declared != null && declared.startsWith("video/")) {
            try {
                return MediaType.parseMediaType(declared);
            } catch (RuntimeException ignored) {
                // Fall through to extension sniffing.
            }
        }
        String name = video.getSourceRel() == null ? "" : video.getSourceRel().toLowerCase(Locale.ROOT);
        if (name.endsWith(".webm")) return MediaType.parseMediaType("video/webm");
        if (name.endsWith(".mov")) return MediaType.parseMediaType("video/quicktime");
        if (name.endsWith(".mkv")) return MediaType.parseMediaType("video/x-matroska");
        if (name.endsWith(".ts")) return MP2T;
        return MediaType.parseMediaType("video/mp4");
    }
}
