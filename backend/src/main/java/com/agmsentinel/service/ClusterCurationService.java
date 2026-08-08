package com.agmsentinel.service;

import com.agmsentinel.model.ClusterDraft;
import com.agmsentinel.model.ClusterDraft.DraftStatus;
import com.agmsentinel.model.ClusterMerge;
import com.agmsentinel.model.Question;
import com.agmsentinel.repository.ClusterDraftRepository;
import com.agmsentinel.repository.ClusterMergeRepository;
import com.agmsentinel.repository.ClusterUpvoteRepository;
import com.agmsentinel.repository.QuestionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Letting a moderator fix the clustering when it gets it wrong.
 *
 * <h2>The problem this solves</h2>
 * Questions are grouped automatically by meaning, and automatic grouping is sometimes wrong in both
 * directions. It splits one topic across two clusters because people phrased it differently, and it
 * lumps two genuinely different questions together because they share vocabulary. Until now a
 * moderator could see that and do nothing about it — the board was whatever the clusterer said.
 *
 * <h2>Merge is durable; split is a one-off</h2>
 * This asymmetry is the important thing to understand, and it comes from where the maths lives.
 *
 * <p>The AI service owns the centroids and assigns every <em>incoming</em> question to the nearest
 * one. So a merge cannot just move rows: the next attendee to ask the same thing would be assigned
 * to the centroid that still exists, and the cluster the moderator merged away would reappear. A
 * merge therefore also writes a {@link ClusterMerge} redirect, which every later assignment is
 * resolved through. It keeps applying to questions nobody has asked yet.
 *
 * <p>A split cannot work that way. Pulling three questions out of a cluster says nothing the
 * clusterer can act on — there is no new centroid, and no way to express "questions like these
 * three" without doing the vector maths here. So a split separates the questions that have already
 * been asked, and future similar ones will land wherever the clusterer puts them. That is a real
 * limitation and the UI says so rather than implying otherwise.
 */
@Service
public class ClusterCurationService {

    private static final Logger log = LoggerFactory.getLogger(ClusterCurationService.class);

    /**
     * How far {@link #resolve} will follow a chain before giving up.
     *
     * <p>Chains are short in practice — merging into an already-merged cluster is unusual and each
     * hop needs a deliberate moderator action. The limit exists so a cycle, however it arose, costs
     * a bounded loop and a log line rather than hanging the request that hit it.
     */
    private static final int MAX_MERGE_DEPTH = 16;

    private final QuestionRepository questions;
    private final ClusterDraftRepository drafts;
    private final ClusterMergeRepository merges;
    private final ClusterUpvoteRepository upvotes;

    public ClusterCurationService(QuestionRepository questions, ClusterDraftRepository drafts,
                                  ClusterMergeRepository merges, ClusterUpvoteRepository upvotes) {
        this.questions = questions;
        this.drafts = drafts;
        this.merges = merges;
        this.upvotes = upvotes;
    }

    /**
     * Follow any merges to the cluster a given id now belongs to.
     *
     * <p>Called on every cluster id arriving from the AI service. An id that has never been merged
     * comes straight back, so the common path is one lookup that misses.
     *
     * <p>Cycles cannot be created through {@link #merge}, which refuses to close one. This still
     * guards against them: the data could be edited directly, and an infinite loop in the path that
     * every incoming question travels is not a risk worth leaving open for the sake of a few lines.
     */
    @Transactional(readOnly = true)
    public UUID resolve(UUID clusterId) {
        if (clusterId == null) return null;

        UUID current = clusterId;
        Set<UUID> seen = new HashSet<>();
        for (int hop = 0; hop < MAX_MERGE_DEPTH; hop++) {
            if (!seen.add(current)) {
                log.error("Cluster merge cycle detected at {} (starting from {}). Leaving the "
                          + "question in {} — the merge table needs fixing by hand.",
                          current, clusterId, current);
                return current;
            }
            Optional<ClusterMerge> next = merges.findById(current);
            if (next.isEmpty()) return current;
            current = next.get().getTargetClusterId();
        }
        log.error("Cluster merge chain from {} is deeper than {} hops; stopping at {}.",
                  clusterId, MAX_MERGE_DEPTH, current);
        return current;
    }

    /**
     * Merge one cluster into another.
     *
     * <p>Both ids are resolved first, so merging into a cluster that has itself been merged away
     * does the sensible thing rather than creating a chain that has to be walked forever.
     *
     * @return the surviving cluster
     */
    @Transactional
    public UUID merge(UUID sourceId, UUID targetId, String actor) {
        UUID source = resolve(sourceId);
        UUID target = resolve(targetId);

        if (source == null || target == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Two clusters are needed.");
        }
        if (source.equals(target)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Those are already the same cluster.");
        }
        // Merging A into B when B already redirects to A would make the two point at each other and
        // neither resolvable. resolve() above means this can only be a direct pair, but the check is
        // cheap and the failure it prevents is unrecoverable without a hand edit.
        if (resolve(target).equals(source)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "That would merge these two into each other. Merge the other way round.");
        }

        ClusterDraft sourceDraft = drafts.findById(source).orElse(null);
        ClusterDraft targetDraft = drafts.findById(target).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "The cluster being merged into no longer exists. Reload the board."));

        int moved = questions.reassignCluster(source, target);

        // Support follows the questions. Duplicates are dropped first: somebody who supported both
        // topics has a row against each, and moving both would break the one-per-person constraint
        // and fail the merge. Losing the support entirely would be worse than either — the merged
        // topic would look less popular than either half.
        upvotes.dropSupportersAlreadyOnTarget(source, target);
        upvotes.reassign(source, target);

        // The redirect is what makes the merge stick for questions not yet asked — see the class
        // note. Written even when the source held no questions, because the centroid still exists in
        // the AI service and will keep attracting new ones.
        merges.save(new ClusterMerge(source, target,
                sourceDraft == null ? null : sourceDraft.getRepresentativeQuestion(), actor));

        targetDraft.setSize((int) questions.countByClusterId(target));
        invalidateDraft(targetDraft, "the cluster grew by a merge");
        drafts.save(targetDraft);

        if (sourceDraft != null) drafts.delete(sourceDraft);

        log.info("{} merged cluster {} into {}: {} questions moved.", actor, source, target, moved);
        return target;
    }

    /**
     * Pull questions out of a cluster into a new one of their own.
     *
     * <p>The new cluster gets a fresh id minted here rather than by the AI service, which has no
     * centroid for it — see the class note on why a split cannot be durable.
     *
     * @return the id of the new cluster
     */
    @Transactional
    public UUID split(UUID clusterId, List<UUID> questionIds, String actor) {
        UUID source = resolve(clusterId);
        if (questionIds == null || questionIds.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Choose which questions to separate out.");
        }

        ClusterDraft sourceDraft = drafts.findById(source).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "That cluster no longer exists. Reload the board."));

        long total = questions.countByClusterId(source);
        if (questionIds.size() >= total) {
            // Moving everything would leave an empty cluster behind and a new one identical to it —
            // a no-op dressed up as an action, and it would silently orphan the existing answer.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "That would move every question out. Leave at least one behind, or delete the "
                    + "cluster instead.");
        }

        UUID newClusterId = UUID.randomUUID();
        int moved = questions.moveQuestions(questionIds, source, newClusterId);
        if (moved == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "None of those questions are in this cluster any more. Reload the board.");
        }

        // The representative question is the first one moved, so the new cluster is recognisable on
        // the board before anything has drafted an answer for it.
        List<Question> movedQuestions = questions.findByClusterIdOrderByCreatedAtAsc(newClusterId);
        String representative = movedQuestions.isEmpty()
                ? sourceDraft.getRepresentativeQuestion()
                : movedQuestions.get(0).getText();

        ClusterDraft fresh = new ClusterDraft(newClusterId, representative, moved,
                                              sourceDraft.getPriorityScore());
        drafts.save(fresh);

        sourceDraft.setSize((int) questions.countByClusterId(source));
        invalidateDraft(sourceDraft, "questions were split out of the cluster");
        drafts.save(sourceDraft);

        log.info("{} split {} questions out of cluster {} into {}.", actor, moved, source,
                 newClusterId);
        return newClusterId;
    }

    /** Move a single question to an existing cluster — the fix for one misfiled question. */
    @Transactional
    public void moveQuestion(UUID questionId, UUID targetClusterId, String actor) {
        Question question = questions.findById(questionId).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "No such question."));
        UUID target = resolve(targetClusterId);
        UUID from = question.getClusterId();

        if (target.equals(from)) return;
        ClusterDraft targetDraft = drafts.findById(target).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "That cluster no longer exists. Reload the board."));

        question.setClusterId(target);
        questions.save(question);

        targetDraft.setSize((int) questions.countByClusterId(target));
        invalidateDraft(targetDraft, "a question was moved in");
        drafts.save(targetDraft);

        // The cluster it came from shrank, so its answer may now cover a question it no longer has.
        if (from != null) {
            drafts.findById(from).ifPresent(previous -> {
                previous.setSize((int) questions.countByClusterId(from));
                invalidateDraft(previous, "a question was moved out");
                drafts.save(previous);
            });
        }
        log.info("{} moved question {} from cluster {} to {}.", actor, questionId, from, target);
    }

    /** The questions actually inside a cluster — what a moderator reads before splitting it. */
    @Transactional(readOnly = true)
    public List<Question> questionsIn(UUID clusterId) {
        return questions.findByClusterIdOrderByCreatedAtAsc(resolve(clusterId));
    }

    /** What was merged into this cluster, so a moderator can see why it is as big as it is. */
    @Transactional(readOnly = true)
    public List<ClusterMerge> mergedInto(UUID clusterId) {
        return merges.findByTargetClusterId(resolve(clusterId));
    }

    /**
     * Mark a draft as needing to be written again, because the cluster it answered has changed.
     *
     * <p><b>A moderator's own answer is never touched.</b> That invariant holds across the rest of
     * the application and this is not the place to break it: someone who wrote an answer by hand and
     * then tidied up the grouping would lose their work to the tidying, which would teach them not
     * to tidy up. Their answer stays, and the size beside it tells them whether it still fits.
     *
     * <p>A machine-written draft is different. It answered a different set of questions from the one
     * that now exists, so leaving it in place would present a stale answer as a current one.
     */
    private void invalidateDraft(ClusterDraft draft, String because) {
        if (draft.isHumanWritten()) return;

        draft.setStatus(DraftStatus.PENDING);
        draft.setDraftAnswer(null);
        draft.setCitationsJson(null);
        draft.setDraftError(null);
        // Reset the counter too: the previous failures were against different content, and a cluster
        // that had exhausted its retries deserves a fresh go now that it has changed.
        draft.setAttempts(0);
        log.debug("Draft for cluster {} reset because {}.", draft.getClusterId(), because);
    }
}
