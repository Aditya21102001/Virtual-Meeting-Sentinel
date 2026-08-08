package com.agmsentinel.service;

import com.agmsentinel.model.ClusterDraft;
import com.agmsentinel.model.ClusterUpvote;
import com.agmsentinel.repository.ClusterDraftRepository;
import com.agmsentinel.repository.ClusterUpvoteRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Running the meeting: what attendees see, what they can support, and what the chair takes next.
 *
 * <p>Three capabilities that turned out to be one piece of code, because they are three views of the
 * same list of topics:
 *
 * <ul>
 *   <li><b>The attendee board</b> — the ranked topics, shown back to the room.
 *   <li><b>Upvoting</b> — "I want this answered too", without typing the question again.
 *   <li><b>The run of show</b> — the order the chair intends to take them in, and how long each took.
 * </ul>
 *
 * <h2>The safety property that shapes all of this</h2>
 * Most answers on the board were written by a model and read by nobody. Publishing those to a room
 * of shareholders would attribute to the company something it never said — at an AGM that is not a
 * presentation bug, it is a statement on the record. So {@link #attendeeBoard} shows an answer only
 * once a moderator has deliberately published it, and the default is always to show the topic
 * without an answer rather than an answer without a reviewer.
 */
@Service
public class RunOfShowService {

    private static final Logger log = LoggerFactory.getLogger(RunOfShowService.class);

    private final ClusterDraftRepository drafts;
    private final ClusterUpvoteRepository upvotes;
    private final ClusterCurationService curation;

    public RunOfShowService(ClusterDraftRepository drafts, ClusterUpvoteRepository upvotes,
                            ClusterCurationService curation) {
        this.drafts = drafts;
        this.upvotes = upvotes;
        this.curation = curation;
    }

    /**
     * One topic as the room sees it.
     *
     * <p>{@code answer} is null unless it has been published — see the class note. {@code asked} and
     * {@code supported} stay separate numbers on purpose: one is people who wrote the question, the
     * other is people who tapped a button, and averaging them into a single score would mean
     * neither.
     */
    public record TopicView(UUID clusterId, String question, int asked, long supported,
                            boolean supportedByMe, String answer, boolean answered,
                            /**
                             * Whether the room may see the answer.
                             *
                             * <p>Carried explicitly rather than inferred from {@code answer} being
                             * present. On the moderator's view the answer is always returned, so
                             * "has an answer" and "the room can see it" are different questions —
                             * and a UI that conflated them would show every drafted answer as
                             * already published, which is the exact mistake this flag exists to
                             * prevent.
                             */
                            boolean published,
                            Integer runOrder, boolean underDiscussion,
                            Instant startedAt, Long secondsSpent) { }

    // ---- what the room sees ---------------------------------------------------

    /**
     * The ranked topics, for attendees.
     *
     * <p>Ordered by the chair's run of show where one has been set, and by demand otherwise — so the
     * list is useful before anybody has organised it, and follows the chair once they have.
     */
    @Transactional(readOnly = true)
    public List<TopicView> attendeeBoard(String viewerId, int limit) {
        List<ClusterDraft> all = drafts.findAll();
        if (all.isEmpty()) return List.of();

        List<UUID> ids = all.stream().map(ClusterDraft::getClusterId).toList();
        Map<UUID, Long> support = supportCounts(ids);
        Set<UUID> mine = viewerId == null || viewerId.isBlank()
                ? Set.of()
                : new HashSet<>(upvotes.mineAmong(ids, viewerId));

        return all.stream()
                .sorted(runOrderThenDemand(support))
                .limit(Math.max(1, limit))
                .map(d -> toView(d, support.getOrDefault(d.getClusterId(), 0L),
                                 mine.contains(d.getClusterId()), true))
                .toList();
    }

    /** The same list for a moderator, who sees unpublished answers too. */
    @Transactional(readOnly = true)
    public List<TopicView> runOfShow(String viewerId) {
        List<ClusterDraft> all = drafts.findAll();
        if (all.isEmpty()) return List.of();

        List<UUID> ids = all.stream().map(ClusterDraft::getClusterId).toList();
        Map<UUID, Long> support = supportCounts(ids);
        Set<UUID> mine = viewerId == null ? Set.of() : new HashSet<>(upvotes.mineAmong(ids, viewerId));

        return all.stream()
                .sorted(runOrderThenDemand(support))
                .map(d -> toView(d, support.getOrDefault(d.getClusterId(), 0L),
                                 mine.contains(d.getClusterId()), false))
                .toList();
    }

    /**
     * Scheduled topics first, in the chair's order; everything else after, by demand.
     *
     * <p>Sorting the unscheduled ones by demand rather than leaving them arbitrary is what makes the
     * board useful before anyone has organised it — which is most of the time, and certainly at the
     * start of a meeting.
     */
    private Comparator<ClusterDraft> runOrderThenDemand(Map<UUID, Long> support) {
        return Comparator
                .comparing((ClusterDraft d) -> d.getRunOrder() == null)      // false (scheduled) first
                .thenComparing(d -> d.getRunOrder() == null ? 0 : d.getRunOrder())
                .thenComparing(Comparator.<ClusterDraft>comparingLong(
                        d -> d.getSize() + support.getOrDefault(d.getClusterId(), 0L)).reversed());
    }

    private Map<UUID, Long> supportCounts(List<UUID> clusterIds) {
        Map<UUID, Long> counts = new HashMap<>();
        for (Object[] row : upvotes.countsByCluster(clusterIds)) {
            counts.put((UUID) row[0], ((Number) row[1]).longValue());
        }
        return counts;
    }

    private TopicView toView(ClusterDraft d, long supported, boolean supportedByMe,
                             boolean publishedOnly) {
        // The whole safety property in one expression: an attendee sees an answer only when a
        // moderator released it. A moderator sees whatever is there.
        boolean visible = !publishedOnly || d.isPublished();
        String answer = visible ? d.getDraftAnswer() : null;

        return new TopicView(d.getClusterId(), d.getRepresentativeQuestion(), d.getSize(),
                supported, supportedByMe, answer,
                answer != null && !answer.isBlank(),
                d.isPublished(),
                d.getRunOrder(), d.isUnderDiscussion(),
                d.getDiscussionStartedAt(), d.discussionSeconds());
    }

    // ---- upvoting -------------------------------------------------------------

    /**
     * Support a topic, or withdraw support. Returns the new count.
     *
     * <p>Toggling rather than a one-way button: someone who taps by accident needs a way back, and
     * a support count nobody can decrease is a count that only ever drifts upwards.
     */
    @Transactional
    public long toggleSupport(UUID clusterId, String voterId) {
        if (voterId == null || voterId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Join the meeting first.");
        }
        UUID cluster = curation.resolve(clusterId);
        drafts.findById(cluster).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "That topic is no longer on the board."));

        upvotes.findByClusterIdAndVoterId(cluster, voterId).ifPresentOrElse(
                upvotes::delete,
                () -> {
                    try {
                        upvotes.saveAndFlush(new ClusterUpvote(cluster, voterId));
                    } catch (DataIntegrityViolationException ex) {
                        // Lost the race with the same person's other tab or a double tap. Their
                        // support is already recorded, which is the outcome they wanted.
                        log.debug("Duplicate support for {} from {} ignored.", cluster, voterId);
                    }
                });
        return upvotes.countByClusterId(cluster);
    }

    // ---- the chair's running order --------------------------------------------

    /**
     * Set the order topics will be taken in.
     *
     * <p>The whole ordered list is sent rather than one move at a time, because reordering is a
     * drag-and-drop and the client already knows the final arrangement. Anything not in the list has
     * its position cleared, so removing a topic from the running order is just leaving it out.
     */
    @Transactional
    public void setRunOrder(List<UUID> orderedClusterIds, String actor) {
        List<ClusterDraft> all = drafts.findAll();
        Map<UUID, Integer> positions = new HashMap<>();
        for (int i = 0; i < orderedClusterIds.size(); i++) {
            positions.put(curation.resolve(orderedClusterIds.get(i)), i + 1);
        }

        for (ClusterDraft draft : all) {
            Integer position = positions.get(draft.getClusterId());
            if (position == null && draft.getRunOrder() == null) continue;   // unchanged
            draft.setRunOrder(position);
            drafts.save(draft);
        }
        log.info("{} set a running order over {} topics.", actor, positions.size());
    }

    /**
     * Begin taking a topic.
     *
     * <p>Whatever was under discussion is closed off first: a chair moving on has finished with the
     * previous topic, and requiring them to say so twice would mean the timings only recorded
     * correctly when they remembered.
     */
    @Transactional
    public void startTopic(UUID clusterId, String actor) {
        UUID cluster = curation.resolve(clusterId);
        Instant now = Instant.now();

        for (ClusterDraft other : drafts.findAll()) {
            if (other.isUnderDiscussion() && !other.getClusterId().equals(cluster)) {
                other.setDiscussionEndedAt(now);
                drafts.save(other);
            }
        }

        ClusterDraft draft = drafts.findById(cluster).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "That topic is no longer on the board."));
        draft.setDiscussionStartedAt(now);
        // Cleared, so re-opening a topic that was closed too early times the new discussion rather
        // than reporting a negative or stale duration.
        draft.setDiscussionEndedAt(null);
        drafts.save(draft);
        log.info("{} started discussing cluster {}.", actor, cluster);
    }

    @Transactional
    public void endTopic(UUID clusterId, String actor) {
        UUID cluster = curation.resolve(clusterId);
        ClusterDraft draft = drafts.findById(cluster).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "That topic is no longer on the board."));
        if (draft.getDiscussionStartedAt() == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "That topic has not been started, so there is nothing to finish.");
        }
        draft.setDiscussionEndedAt(Instant.now());
        drafts.save(draft);
        log.info("{} finished cluster {} after {}s.", actor, cluster, draft.discussionSeconds());
    }

    // ---- publishing an answer to the room --------------------------------------

    /**
     * Release an answer to attendees, or take it back down.
     *
     * <p>Publishing an empty answer is refused. The attendee board would show the topic with nothing
     * under it, which reads as "we answered this" to everyone looking at it.
     */
    @Transactional
    public boolean setPublished(UUID clusterId, boolean published, String actor) {
        UUID cluster = curation.resolve(clusterId);
        ClusterDraft draft = drafts.findById(cluster).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "That topic is no longer on the board."));

        if (published && (draft.getDraftAnswer() == null || draft.getDraftAnswer().isBlank())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "There is no answer to publish yet. Write or draft one first.");
        }
        draft.setPublishedAt(published ? Instant.now() : null);
        drafts.save(draft);
        log.info("{} {} the answer for cluster {}.", actor, published ? "published" : "withdrew",
                 cluster);
        return published;
    }
}
