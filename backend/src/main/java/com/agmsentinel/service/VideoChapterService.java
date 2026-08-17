package com.agmsentinel.service;

import com.agmsentinel.dto.VideoDtos.ChapterInput;
import com.agmsentinel.dto.VideoDtos.ChapterView;
import com.agmsentinel.dto.VideoDtos.VideoCard;
import com.agmsentinel.model.VideoChapter;
import com.agmsentinel.repository.VideoChapterRepository;
import com.agmsentinel.security.Feature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * The agenda of a recording: reading it, and replacing it.
 *
 * <p>Chapters are what makes a two-hour AGM navigable — jumping to "Item 4 — Auditor's Report" is
 * the difference between a recording that gets watched and one that gets scrubbed through and
 * abandoned. They are authored, not derived, so this class is mostly about accepting a moderator's
 * edits without letting an inconsistent agenda reach the player.
 */
@Service
public class VideoChapterService {

    private static final Logger log = LoggerFactory.getLogger(VideoChapterService.class);

    /**
     * Ceiling on chapters per recording. Not a storage concern — the player renders every marker on
     * the progress bar, and past a few dozen they are narrower than a finger and the bar becomes
     * unusable. Refusing is kinder than rendering something nobody can hit.
     */
    public static final int MAX_CHAPTERS = 100;

    private final VideoChapterRepository chapters;
    private final FeatureService features;

    public VideoChapterService(VideoChapterRepository chapters, FeatureService features) {
        this.chapters = chapters;
        this.features = features;
    }

    @Transactional(readOnly = true)
    public List<ChapterView> forVideo(UUID videoId) {
        return chapters.findByVideoIdOrderByStartSecondsAsc(videoId).stream()
                .map(ChapterView::of)
                .toList();
    }

    /**
     * Attach agendas to a page of cards in ONE query.
     *
     * <p>The reason this exists rather than calling {@link #forVideo} per card: the library renders
     * every recording at once, and a query per card is the classic N+1 — twenty recordings became
     * twenty round-trips to a database that, on a free tier, is the slowest thing in the request.
     * Mirrors VideoEngagementService.enrich for the same reason.
     */
    @Transactional(readOnly = true)
    public List<VideoCard> enrich(List<VideoCard> cards) {
        // Checked BEFORE the query, not after. The point of the flag is that a deployment with it
        // off costs the library page nothing at all — gating only the response would still have
        // added a round-trip per page load to a pool of five connections.
        if (cards.isEmpty() || !features.isEnabled(Feature.VIDEO_CHAPTERS)) return cards;

        List<UUID> ids = cards.stream().map(c -> c.video().id()).toList();

        // groupingBy preserves the query's ordering within each group, so the ORDER BY in the
        // repository method is what puts each agenda in playing order — nothing re-sorts here.
        Map<UUID, List<ChapterView>> byVideo =
                chapters.findByVideoIdInOrderByStartSecondsAsc(ids).stream()
                        .collect(Collectors.groupingBy(VideoChapter::getVideoId,
                                Collectors.mapping(ChapterView::of, Collectors.toList())));

        return cards.stream()
                .map(card -> card.withChapters(byVideo.getOrDefault(card.video().id(), List.of())))
                .toList();
    }

    /**
     * Replace the whole agenda for a recording.
     *
     * <p>Wholesale rather than a diff. A moderator editing an agenda renames, reorders and deletes
     * rows in one sitting; matching those against existing ids would be real work whose only reward
     * is preserving identifiers nothing refers to.
     *
     * @return the saved agenda, in playing order
     */
    @Transactional
    public List<ChapterView> replace(UUID videoId, List<ChapterInput> submitted) {
        List<ChapterInput> input = submitted == null ? List.of() : submitted;

        if (input.size() > MAX_CHAPTERS) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "A recording can have at most " + MAX_CHAPTERS + " chapters; "
                    + input.size() + " were submitted.");
        }

        // Sort BEFORE numbering. Ordinals are derived from time, so a client may submit in any order
        // — which it will, having just inserted a chapter in the middle of the list.
        List<ChapterInput> ordered = input.stream()
                .sorted(Comparator.comparingDouble(ChapterInput::startSeconds))
                .toList();

        List<VideoChapter> rows = new ArrayList<>();
        double previousStart = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < ordered.size(); i++) {
            ChapterInput chapter = ordered.get(i);
            double start = validateStart(chapter, previousStart);
            rows.add(new VideoChapter(videoId, start, validateTitle(chapter), i));
            previousStart = start;
        }

        // Delete-then-insert inside one transaction: a half-applied agenda would show the player
        // markers that do not match its own chapter list.
        chapters.deleteByVideoId(videoId);
        chapters.saveAll(rows);

        log.info("Saved {} chapter(s) for video {}.", rows.size(), videoId);
        return rows.stream().map(ChapterView::of).toList();
    }

    private double validateStart(ChapterInput chapter, double previousStart) {
        double start = chapter.startSeconds();
        if (Double.isNaN(start) || Double.isInfinite(start) || start < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Chapter \"" + chapter.title() + "\" has an invalid start time.");
        }
        // Two chapters at the same second have no order a viewer could perceive, and would render as
        // one unreachable marker on top of another.
        if (start <= previousStart) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Two chapters start at the same time (" + formatTime(start)
                    + "). Each chapter needs its own start.");
        }
        return start;
    }

    private String validateTitle(ChapterInput chapter) {
        String title = chapter.title() == null ? "" : chapter.title().strip();
        if (title.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "The chapter at " + formatTime(chapter.startSeconds()) + " has no title.");
        }
        if (title.length() > VideoChapter.MAX_TITLE_LENGTH) {
            // Truncating silently would hide the loss until someone noticed a clipped agenda item.
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "The chapter at " + formatTime(chapter.startSeconds()) + " has a title longer "
                    + "than " + VideoChapter.MAX_TITLE_LENGTH + " characters.");
        }
        return title;
    }

    /** h:mm:ss / m:ss, so an error message names the moment the way the player displays it. */
    static String formatTime(double seconds) {
        long total = (long) Math.max(0, seconds);
        long h = total / 3600, m = (total % 3600) / 60, s = total % 60;
        return h > 0 ? String.format("%d:%02d:%02d", h, m, s) : String.format("%d:%02d", m, s);
    }

    @Transactional
    public void deleteFor(UUID videoId) {
        chapters.deleteByVideoId(videoId);
    }
}
