package com.agmsentinel.service;

import com.agmsentinel.dto.VideoDtos.CommentView;
import com.agmsentinel.dto.VideoDtos.VideoCard;
import com.agmsentinel.dto.VideoDtos.VideoEngagement;
import com.agmsentinel.model.VideoComment;
import com.agmsentinel.model.VideoLike;
import com.agmsentinel.repository.VideoCommentRepository;
import com.agmsentinel.repository.VideoLikeRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Likes and comments on recordings.
 *
 * <p>Reads are deliberately batched. A library page carries up to twenty cards and each one needs a
 * like count, a comment count and "did I like this" — resolved naively that is sixty queries to
 * render one page. {@link #enrich} answers all of it in three, which is the difference between a
 * catalogue that loads on a free-tier database and one that feels broken.
 */
@Service
public class VideoEngagementService {

    private final VideoLikeRepository likes;
    private final VideoCommentRepository comments;
    private final VideoWatchService watches;

    public VideoEngagementService(VideoLikeRepository likes, VideoCommentRepository comments,
                                  VideoWatchService watches) {
        this.watches = watches;
        this.likes = likes;
        this.comments = comments;
    }

    // ---- reading -------------------------------------------------------------

    /**
     * Fill in the engagement counts for a page of cards, in three queries regardless of page size.
     *
     * <p>Returns a new list; {@code VideoCard} is a record and nothing here mutates state.
     */
    @Transactional(readOnly = true)
    public List<VideoCard> enrich(List<VideoCard> cards, String viewer) {
        if (cards.isEmpty()) return cards;

        List<UUID> ids = cards.stream().map(c -> c.video().id()).toList();
        Map<UUID, Long> likeCounts = tally(likes.countsByVideo(ids));
        Map<UUID, Long> commentCounts = tally(comments.countsByVideo(ids));
        Set<UUID> mine = viewer == null ? Set.of() : new HashSet<>(likes.likedByMe(viewer, ids));
        // A fourth batched query, not one per card. Resume positions are deliberately NOT loaded
        // here: the library shows a progress bar per card from this same batch, and asking for one
        // member's position per recording would undo the batching the rest of this method exists for.
        Map<UUID, Long> viewerCounts = watches.viewerCounts(ids);

        return cards.stream()
                .map(card -> card.withEngagement(new VideoEngagement(
                        likeCounts.getOrDefault(card.video().id(), 0L),
                        mine.contains(card.video().id()),
                        commentCounts.getOrDefault(card.video().id(), 0L),
                        viewerCounts.getOrDefault(card.video().id(), 0L),
                        0)))
                .toList();
    }

    /** Engagement for a single recording. */
    @Transactional(readOnly = true)
    public VideoEngagement engagementOf(UUID videoId, String viewer) {
        // The single-card path DOES resolve the resume position: this is the call the player makes
        // when opening a recording, and it is exactly where "continue from where you left off" has
        // to come from.
        return new VideoEngagement(
                likes.countByVideoId(videoId),
                viewer != null && likes.findByVideoIdAndUsername(videoId, viewer).isPresent(),
                comments.findByVideoIdOrderByCreatedAtAsc(videoId).size(),
                watches.viewerCounts(List.of(videoId)).getOrDefault(videoId, 0L),
                watches.resumePosition(videoId, viewer));
    }

    @Transactional(readOnly = true)
    public List<CommentView> listComments(UUID videoId, String viewer, boolean viewerModerates) {
        return comments.findByVideoIdOrderByCreatedAtAsc(videoId).stream()
                .map(c -> toView(c, viewer, viewerModerates))
                .toList();
    }

    // ---- writing -------------------------------------------------------------

    /**
     * Like if not already liked, un-like if so, and report the new state.
     *
     * <p>Idempotent per member by construction: the unique constraint on
     * {@code (video_id, username)} means a double-tap cannot produce two rows even if two requests
     * arrive at once — one of them fails the constraint rather than inflating the count.
     */
    @Transactional
    public VideoEngagement toggleLike(UUID videoId, String username) {
        requireUser(username);
        likes.findByVideoIdAndUsername(videoId, username)
                .ifPresentOrElse(likes::delete,
                                 () -> likes.save(new VideoLike(videoId, username)));
        return engagementOf(videoId, username);
    }

    @Transactional
    public CommentView addComment(UUID videoId, String author, String body, Double atSeconds) {
        requireUser(author);
        String text = body == null ? "" : body.trim();
        if (text.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A comment cannot be empty.");
        }
        if (text.length() > VideoComment.MAX_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "A comment is limited to " + VideoComment.MAX_LENGTH + " characters.");
        }
        // A negative timestamp would render as a nonsense seek target; drop it rather than store it.
        Double at = atSeconds != null && atSeconds >= 0 ? atSeconds : null;
        VideoComment saved = comments.save(new VideoComment(videoId, author, text, at));
        return toView(saved, author, false);
    }

    /**
     * Delete a comment. A member may remove their own; a moderator may remove any.
     *
     * <p>The ownership check is here rather than in the controller because it is the rule, not a
     * presentation detail — a second caller must not be able to skip it by not asking.
     */
    @Transactional
    public void deleteComment(UUID commentId, String requester, boolean requesterModerates) {
        requireUser(requester);
        VideoComment comment = comments.findById(commentId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "That comment no longer exists."));
        if (!requesterModerates && !comment.getAuthor().equals(requester)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "You can only delete your own comments.");
        }
        comments.delete(comment);
    }

    /** Called when a recording is deleted, so its likes and comments go with it. */
    @Transactional
    public void deleteAllFor(UUID videoId) {
        likes.deleteByVideoId(videoId);
        comments.deleteByVideoId(videoId);
    }

    // ---- helpers -------------------------------------------------------------

    private void requireUser(String username) {
        if (username == null || username.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,
                    "Sign in to like or comment.");
        }
    }

    /** {@code [videoId, count]} rows from a grouped query into a lookup. */
    private Map<UUID, Long> tally(List<Object[]> rows) {
        Map<UUID, Long> counts = new HashMap<>();
        for (Object[] row : rows) {
            counts.put((UUID) row[0], ((Number) row[1]).longValue());
        }
        return counts;
    }

    private CommentView toView(VideoComment c, String viewer, boolean viewerModerates) {
        boolean mine = viewer != null && viewer.equals(c.getAuthor());
        return new CommentView(c.getId(), c.getAuthor(), c.getBody(), c.getAtSeconds(),
                c.getCreatedAt(), c.getEditedAt(), mine, mine || viewerModerates);
    }
}
