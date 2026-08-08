package com.agmsentinel.service;

import com.agmsentinel.model.Meeting;
import com.agmsentinel.model.MeetingStatus;
import com.agmsentinel.model.Resolution;
import com.agmsentinel.model.ResolutionStatus;
import com.agmsentinel.model.ResolutionType;
import com.agmsentinel.model.Vote;
import com.agmsentinel.model.VoteChoice;
import com.agmsentinel.repository.ResolutionRepository;
import com.agmsentinel.repository.VoteRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Resolutions and the votes cast on them.
 *
 * <h2>What this is, if you have never sat through an AGM</h2>
 *
 * An AGM — annual general meeting — is where a company's shareholders make formal decisions. Each
 * decision is put as a <b>resolution</b>: a motion with a title and some exact wording, such as
 * "That the accounts for the year ended 31 March be approved". The person chairing the meeting
 * <b>opens</b> the floor, members vote, the chair <b>closes</b> it, and the outcome is recorded.
 *
 * <p>A member votes one of three ways:
 * <ul>
 *   <li><b>FOR</b> — in favour.
 *   <li><b>AGAINST</b> — opposed.
 *   <li><b>ABSTAIN</b> — "I am here and taking part, but I am not taking a side." This is <em>not</em>
 *       the same as not voting. It counts towards {@linkplain #quorum quorum} but is left out of the
 *       majority calculation entirely.
 * </ul>
 *
 * <p>Votes are usually <b>weighted</b> by shareholding rather than counted by head: a member holding
 * 1,000 shares casts 1,000 votes. That weight is stored on the meeting's member list, which is why
 * {@code MeetingService} is involved below.
 *
 * <p>An <b>ordinary</b> resolution passes on a simple majority. A <b>special</b> resolution needs at
 * least 75% and is used for weightier decisions such as changing the company's constitution. Which
 * rule applies is stored per resolution — both kinds routinely appear on the same agenda. See
 * {@link ResolutionType}.
 *
 * <p><b>Quorum</b> is the minimum share of the register that must be taking part for the meeting's
 * decisions to be valid at all. A vote taken without quorum does not count, however lopsided it was.
 *
 * <h2>Why this class is stricter than it needs to be to "work"</h2>
 *
 * Being wrong here is expensive. A mis-stated tally is not a cosmetic bug — it is a false record of
 * what a company's members decided, and people rely on that record. Three rules follow, and they
 * explain most of the defensiveness below:
 *
 * <ol>
 *   <li><b>Only an open resolution accepts a vote.</b> The chair opens and closes the floor. A vote
 *       arriving outside that window is invalid rather than merely late, so it is refused rather
 *       than quietly accepted.
 *   <li><b>Entitlement comes from the member list, never from the request.</b> The client says
 *       <em>how</em> it votes; the server alone decides how much that is worth. If the weight came
 *       from the request, any member could inflate their own holding.
 *   <li><b>One row per member per resolution</b>, guaranteed by a database constraint rather than by
 *       a check in this class. See {@link #castVote} for why the check alone is not enough.
 * </ol>
 */
@Service
public class VotingService {

    private static final Logger log = LoggerFactory.getLogger(VotingService.class);

    private final ResolutionRepository resolutions;
    private final VoteRepository votes;
    private final MeetingService meetings;

    public VotingService(ResolutionRepository resolutions, VoteRepository votes,
                         MeetingService meetings) {
        this.resolutions = resolutions;
        this.votes = votes;
        this.meetings = meetings;
    }

    /**
     * A tally for one resolution.
     *
     * <p>Both headcounts and weights, because the two answer different questions: "how many members
     * voted for this" and "how much of the register voted for this" are both reported at an AGM, and
     * with weighted voting they are rarely the same number.
     */
    public record Tally(UUID resolutionId,
                        long forCount, long againstCount, long abstainCount,
                        long forWeight, long againstWeight, long abstainWeight,
                        boolean carried) {

        /** Votes that count towards the majority. Abstentions are excluded. */
        public long decisiveWeight() {
            return forWeight + againstWeight;
        }

        public long totalCount() {
            return forCount + againstCount + abstainCount;
        }

        /** Share of the decisive weight that voted for, or 0 when nothing decisive was cast. */
        public double forPercent() {
            long decisive = decisiveWeight();
            return decisive == 0 ? 0.0 : (forWeight * 100.0) / decisive;
        }

        static Tally empty(UUID resolutionId, ResolutionType type) {
            return new Tally(resolutionId, 0, 0, 0, 0, 0, 0, type.carried(0, 0));
        }
    }

    /** Whether enough of the register is taking part for business to be valid. */
    public record Quorum(long represented, long total, double thresholdPercent, boolean met) {

        public double representedPercent() {
            return total == 0 ? 0.0 : (represented * 100.0) / total;
        }
    }

    // ---- reading -------------------------------------------------------------

    /**
     * Refuse to show a meeting's agenda to someone who has no business seeing it.
     *
     * <p>Without this, any signed-in user could read any meeting's motions by guessing or harvesting
     * a meeting id — including the wording of business that has not been put yet. Membership is the
     * right test: the agenda belongs to the meeting, and the member list is what says who the
     * meeting belongs to.
     *
     * <p>Moderators are exempt because they run meetings, and are not necessarily members of the
     * ones they run.
     */
    @Transactional(readOnly = true)
    public void assertMayViewAgenda(UUID meetingId, String username, boolean moderator) {
        if (moderator) return;
        meetings.get(meetingId);   // 404 for a meeting that does not exist, before anything else
        if (!meetings.isMember(meetingId, username)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "You are not on the member list for this meeting, so you cannot see its "
                    + "agenda. Ask the organiser to add you.");
        }
    }

    @Transactional(readOnly = true)
    public List<Resolution> agenda(UUID meetingId) {
        return resolutions.findByMeetingIdOrderBySeqAscCreatedAtAsc(meetingId);
    }

    @Transactional(readOnly = true)
    public Resolution get(UUID id) {
        return resolutions.findById(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "No such resolution."));
    }

    @Transactional(readOnly = true)
    public Tally tally(Resolution resolution) {
        return toTally(resolution.getId(), resolution.getType(),
                       votes.tally(resolution.getId()));
    }

    /**
     * Tallies for a whole agenda in one query.
     *
     * <p>The results screen shows every motion at once; resolving these one at a time would issue a
     * query per row, which is the same N+1 the meetings and video listings already avoid.
     */
    @Transactional(readOnly = true)
    public Map<UUID, Tally> tallies(List<Resolution> agenda) {
        if (agenda.isEmpty()) return Map.of();

        // The query returns one row per (resolution, choice) pair as an Object[] laid out
        // [resolutionId, choice, count, weight] — that is what a JPQL query selecting several
        // columns gives back. Reshape it into resolution -> choice -> [count, weight] so the loop
        // below can look each resolution up directly.
        Map<UUID, Map<VoteChoice, long[]>> grouped = new HashMap<>();
        for (Object[] row : votes.tallies(agenda.stream().map(Resolution::getId).toList())) {
            grouped.computeIfAbsent((UUID) row[0], k -> new EnumMap<>(VoteChoice.class))
                   .put((VoteChoice) row[1],
                        new long[] { ((Number) row[2]).longValue(), ((Number) row[3]).longValue() });
        }

        // Walk the agenda rather than the query results, so a resolution nobody has voted on still
        // gets an entry. Iterating the results instead would silently omit it, and the caller would
        // have to guess whether a missing key meant "no votes" or "no such resolution".
        Map<UUID, Tally> result = new HashMap<>();
        for (Resolution resolution : agenda) {
            Map<VoteChoice, long[]> rows = grouped.get(resolution.getId());
            result.put(resolution.getId(), rows == null
                    ? Tally.empty(resolution.getId(), resolution.getType())
                    : fromGrouped(resolution.getId(), resolution.getType(), rows));
        }
        return result;
    }

    /** How this member voted on each motion of an agenda, for showing them their own ballot. */
    @Transactional(readOnly = true)
    public Map<UUID, VoteChoice> myChoices(List<Resolution> agenda, String username) {
        if (agenda.isEmpty() || username == null || username.isBlank()) return Map.of();
        Map<UUID, VoteChoice> mine = new HashMap<>();
        for (Object[] row : votes.myChoices(agenda.stream().map(Resolution::getId).toList(),
                                            username)) {
            mine.put((UUID) row[0], (VoteChoice) row[1]);
        }
        return mine;
    }

    /**
     * Quorum for a meeting: entitlement represented, against entitlement mapped.
     *
     * <p>"Represented" is the summed weight of members who have cast at least one vote. That is a
     * proxy for presence and it is the honest one available here — the application has no register of
     * who walked into the room, and inferring attendance from a websocket connection would count
     * someone who opened the page and left.
     *
     * <p>A meeting with nobody mapped has no quorum, rather than a vacuous 100%.
     */
    @Transactional(readOnly = true)
    public Quorum quorum(UUID meetingId) {
        Meeting meeting = meetings.get(meetingId);
        long total = meetings.totalVotingWeight(meetingId);
        long represented = meetings.representedVotingWeight(meetingId);

        double threshold = meeting.getQuorumThresholdPercent();
        boolean met = total > 0 && (represented * 100.0) >= (total * threshold);
        return new Quorum(represented, total, threshold, met);
    }

    // ---- authoring (moderator) ------------------------------------------------

    @Transactional
    public Resolution create(UUID meetingId, String title, String text, ResolutionType type,
                             String actor) {
        Meeting meeting = meetings.get(meetingId);
        if (meeting.getStatus() == MeetingStatus.CLOSED) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This meeting is closed; its agenda is now part of the record.");
        }
        String clean = title == null ? "" : title.trim();
        if (clean.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A resolution needs a title.");
        }
        Resolution resolution = resolutions.save(new Resolution(
                meetingId, resolutions.maxSeq(meetingId) + 1, clean, text, type, actor));
        log.info("Resolution {} created on meeting {} by {}.", resolution.getId(), meetingId, actor);
        return resolution;
    }

    /**
     * Edit the wording or type.
     *
     * <p>Refused once voting has started. Members voted on the text in front of them, and changing it
     * underneath a cast vote would misrepresent what they agreed to — which is precisely the kind of
     * silent rewrite a voting record exists to prevent. Withdraw the motion and put a new one.
     */
    @Transactional
    public Resolution update(UUID id, String title, String text, ResolutionType type,
                             Integer seq, Boolean liveResultsVisible) {
        Resolution resolution = get(id);
        if (resolution.getStatus() != ResolutionStatus.DRAFT) {
            // Ordering and result visibility are presentation, not substance, so they stay editable.
            if (seq != null) resolution.setSeq(seq);
            if (liveResultsVisible != null) resolution.setLiveResultsVisible(liveResultsVisible);
            if (title != null || text != null || type != null) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "This resolution has already been put to the meeting. Its wording can no "
                        + "longer change — withdraw it and put a new one instead.");
            }
            return resolutions.save(resolution);
        }
        if (title != null && !title.isBlank()) resolution.setTitle(title.trim());
        if (text != null) resolution.setText(text.isBlank() ? null : text);
        if (type != null) resolution.setType(type);
        if (seq != null) resolution.setSeq(seq);
        if (liveResultsVisible != null) resolution.setLiveResultsVisible(liveResultsVisible);
        return resolutions.save(resolution);
    }

    /**
     * Open the floor.
     *
     * <p>Only from DRAFT. Reopening a closed vote would let a result be revised after members had
     * seen it, so a closed resolution stays closed.
     */
    @Transactional
    public Resolution open(UUID id, String actor) {
        Resolution resolution = get(id);
        if (resolution.getStatus() == ResolutionStatus.OPEN) return resolution;
        if (resolution.getStatus() == ResolutionStatus.CLOSED) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This vote has been closed and its result recorded. Put a fresh resolution "
                    + "rather than reopening this one.");
        }
        Meeting meeting = meetings.get(resolution.getMeetingId());
        if (meeting.getStatus() != MeetingStatus.ACTIVE) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Activate the meeting before opening a vote — members can only vote in the "
                    + "meeting that is live.");
        }
        resolution.setStatus(ResolutionStatus.OPEN);
        resolution.setOpenedAt(Instant.now());
        log.info("Resolution {} opened for voting by {}.", id, actor);
        return resolutions.save(resolution);
    }

    @Transactional
    public Resolution close(UUID id, String actor) {
        Resolution resolution = get(id);
        if (resolution.getStatus() == ResolutionStatus.CLOSED) return resolution;
        if (resolution.getStatus() == ResolutionStatus.DRAFT) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This resolution was never opened, so there is nothing to close.");
        }
        resolution.setStatus(ResolutionStatus.CLOSED);
        resolution.setClosedAt(Instant.now());
        Resolution saved = resolutions.save(resolution);

        Tally result = tally(saved);
        log.info("Resolution {} closed by {}: {} for / {} against / {} abstained (by weight) — {}.",
                 id, actor, result.forWeight(), result.againstWeight(), result.abstainWeight(),
                 result.carried() ? "carried" : "not carried");
        return saved;
    }

    /**
     * Delete a resolution and any votes on it.
     *
     * <p>Refused once closed: the tally is the record of a decision, and deleting it is not an edit
     * the application should make easy.
     */
    @Transactional
    public void delete(UUID id, String actor) {
        Resolution resolution = get(id);
        if (resolution.getStatus() == ResolutionStatus.CLOSED) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "A closed resolution is part of the meeting's record and cannot be deleted.");
        }
        votes.deleteByResolutionId(id);
        resolutions.delete(resolution);
        log.info("Resolution {} deleted by {}.", id, actor);
    }

    // ---- voting ---------------------------------------------------------------

    /**
     * Record a member's vote, or change one already cast.
     *
     * <p>The weight is read from the member list here and never taken from the request — that is the
     * difference between a vote and a claim. A caller who is not mapped to the meeting has no
     * entitlement and is refused rather than defaulted to one vote.
     *
     * <p>The read-then-write is guarded by a unique constraint rather than trusted on its own. Two
     * requests arriving together — a double tap, a client retry — would both find no existing row and
     * both insert. The constraint turns that into an error we can recover from by re-reading, which
     * is the one outcome that never double-counts.
     */
    @Transactional
    public Vote castVote(UUID resolutionId, String username, VoteChoice choice) {
        if (username == null || username.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Sign in to vote.");
        }
        if (choice == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Choose for, against or abstain.");
        }

        Resolution resolution = get(resolutionId);
        if (!resolution.isOpen()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    resolution.getStatus() == ResolutionStatus.DRAFT
                            ? "Voting on this resolution has not opened yet."
                            : "Voting on this resolution has closed.");
        }

        int weight = meetings.votingWeightOf(resolution.getMeetingId(), username).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.FORBIDDEN,
                        "You are not on the member list for this meeting, so you cannot vote in "
                        + "it. Ask the organiser to add you."));
        if (weight <= 0) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "You are listed for this meeting but hold no voting entitlement.");
        }

        Optional<Vote> existing = votes.findByResolutionIdAndUsername(resolutionId, username);
        if (existing.isPresent()) {
            Vote vote = existing.get();
            vote.recast(choice, weight);
            return votes.save(vote);
        }

        try {
            return votes.saveAndFlush(
                    new Vote(resolutionId, resolution.getMeetingId(), username, choice, weight));
        } catch (DataIntegrityViolationException ex) {
            // Lost the race against a concurrent first vote from the same member. Their row exists
            // now, so treat this as the change of vote it effectively is.
            Vote vote = votes.findByResolutionIdAndUsername(resolutionId, username)
                    .orElseThrow(() -> ex);
            vote.recast(choice, weight);
            return votes.save(vote);
        }
    }

    @Transactional(readOnly = true)
    public Optional<Vote> myVote(UUID resolutionId, String username) {
        if (username == null || username.isBlank()) return Optional.empty();
        return votes.findByResolutionIdAndUsername(resolutionId, username);
    }

    /**
     * Whether this caller may see the tally for a resolution.
     *
     * <p>A moderator always may — they are running the vote. Everyone else may once it has closed, or
     * while it is open only if the chair has deliberately published the running count. Showing a live
     * tally by default would let early votes steer later ones, which is the reason a show of hands is
     * taken all at once.
     */
    public boolean maySeeResults(Resolution resolution, boolean moderator) {
        if (moderator) return true;
        return resolution.getStatus() == ResolutionStatus.CLOSED || resolution.isLiveResultsVisible();
    }

    // ---- internals ------------------------------------------------------------

    private Tally toTally(UUID resolutionId, ResolutionType type, List<Object[]> rows) {
        Map<VoteChoice, long[]> grouped = new EnumMap<>(VoteChoice.class);
        for (Object[] row : rows) {
            grouped.put((VoteChoice) row[0],
                        new long[] { ((Number) row[1]).longValue(), ((Number) row[2]).longValue() });
        }
        return fromGrouped(resolutionId, type, grouped);
    }

    /**
     * Build a tally from the grouped counts.
     *
     * <p>Each {@code long[]} is {@code [headcount, summedWeight]} for one choice. A choice nobody
     * picked is absent from the map, so it defaults to zeros rather than throwing.
     *
     * <p>Note which numbers decide the outcome: {@code carried} is given the <em>weights</em> of the
     * FOR and AGAINST votes, and is never told about abstentions. Passing headcounts instead would
     * quietly turn a weighted vote into one-member-one-vote, which is the sort of mistake that
     * produces a plausible-looking but wrong result.
     */
    private Tally fromGrouped(UUID resolutionId, ResolutionType type,
                              Map<VoteChoice, long[]> grouped) {
        long[] yes = grouped.getOrDefault(VoteChoice.FOR, new long[] { 0, 0 });
        long[] no = grouped.getOrDefault(VoteChoice.AGAINST, new long[] { 0, 0 });
        long[] abstain = grouped.getOrDefault(VoteChoice.ABSTAIN, new long[] { 0, 0 });
        return new Tally(resolutionId,
                         yes[0], no[0], abstain[0],
                         yes[1], no[1], abstain[1],
                         type.carried(yes[1], no[1]));
    }
}
