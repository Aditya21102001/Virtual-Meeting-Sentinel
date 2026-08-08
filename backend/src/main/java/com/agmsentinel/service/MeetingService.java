package com.agmsentinel.service;

import com.agmsentinel.model.Meeting;
import com.agmsentinel.model.MeetingMember;
import com.agmsentinel.model.MeetingStatus;
import com.agmsentinel.repository.MeetingMemberRepository;
import com.agmsentinel.repository.MeetingRepository;
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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Meetings, and who belongs to them.
 *
 * <p>Two duties, deliberately separated (see {@code Roles}): a MEETING_MANAGER creates meetings and
 * decides which is live; a USER_MANAGER decides who is in one. Both are additive to whatever the
 * person's primary role is, so a moderator can hold either without giving up the board.
 *
 * <h2>Phase one is additive</h2>
 * Nothing here filters anything yet. Questions and recordings carry a nullable {@code meeting_id},
 * but every existing query still ignores it, so behaviour for current users is unchanged. Turning on
 * scoping is a separate, deliberate change once meetings exist and members are mapped — which is why
 * that column is nullable rather than required.
 */
@Service
public class MeetingService {

    private static final Logger log = LoggerFactory.getLogger(MeetingService.class);

    private final MeetingRepository meetings;
    private final MeetingMemberRepository members;
    private final ResolutionRepository resolutions;
    private final VoteRepository votes;

    public MeetingService(MeetingRepository meetings, MeetingMemberRepository members,
                          ResolutionRepository resolutions, VoteRepository votes) {
        this.meetings = meetings;
        this.members = members;
        this.resolutions = resolutions;
        this.votes = votes;
    }

    // ---- reading -------------------------------------------------------------

    @Transactional(readOnly = true)
    public List<Meeting> listAll() {
        return meetings.findAllByOrderByCreatedAtDesc();
    }

    /** The live meeting, or empty when none has been activated. */
    @Transactional(readOnly = true)
    public Optional<Meeting> active() {
        return meetings.findFirstByStatus(MeetingStatus.ACTIVE);
    }

    @Transactional(readOnly = true)
    public Meeting get(UUID id) {
        return meetings.findById(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "No such meeting."));
    }

    /** Member counts for a page of meetings, in one query rather than one per row. */
    @Transactional(readOnly = true)
    public Map<UUID, Long> memberCounts(List<Meeting> page) {
        if (page.isEmpty()) return Map.of();
        Map<UUID, Long> counts = new HashMap<>();
        for (Object[] row : members.countsByMeeting(page.stream().map(Meeting::getId).toList())) {
            counts.put((UUID) row[0], ((Number) row[1]).longValue());
        }
        return counts;
    }

    @Transactional(readOnly = true)
    public List<MeetingMember> membersOf(UUID meetingId) {
        get(meetingId);   // 404 rather than an empty list for a meeting that does not exist
        return members.findByMeetingIdOrderByUsernameAsc(meetingId);
    }

    // ---- lifecycle -----------------------------------------------------------

    @Transactional
    public Meeting create(String title, String description, Instant scheduledAt, String createdBy) {
        String clean = title == null ? "" : title.trim();
        if (clean.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A meeting needs a title.");
        }
        if (meetings.existsByTitleIgnoreCase(clean)) {
            // Not a database constraint: two AGMs a year apart may legitimately share a name. This
            // is a guard against the same one being created twice by accident, which is the common
            // mistake — and it is worth a clear message rather than a silent duplicate.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "A meeting called \"" + clean + "\" already exists.");
        }
        Meeting meeting = meetings.save(new Meeting(clean, description, scheduledAt, createdBy));
        log.info("Meeting {} (\"{}\") created by {}.", meeting.getId(), clean, createdBy);
        return meeting;
    }

    /**
     * Make this the live meeting, closing whichever one was live before.
     *
     * <p>Closing rather than returning the old one to DRAFT: a meeting that has run has questions
     * attached to it, and "not started yet" would be a lie about something that already happened.
     *
     * <p>The swap is one transaction, and the database has a partial unique index on
     * {@code status = 'ACTIVE'}. Both matter: the transaction stops a gap where no meeting is live,
     * and the index stops two managers activating different meetings at the same instant and both
     * believing they won.
     */
    @Transactional
    public Meeting activate(UUID id, String actor) {
        Meeting meeting = get(id);
        if (meeting.getStatus() == MeetingStatus.ACTIVE) return meeting;
        if (meeting.getStatus() == MeetingStatus.CLOSED) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This meeting has been closed. Create a new one rather than reopening it — its "
                    + "questions and recordings are the record of what happened.");
        }

        Optional<Meeting> current = meetings.findFirstByStatus(MeetingStatus.ACTIVE);
        current.ifPresent(previous -> {
            previous.setStatus(MeetingStatus.CLOSED);
            previous.setClosedAt(Instant.now());
            meetings.save(previous);
            log.info("Meeting {} closed because {} was activated.", previous.getId(), id);
        });

        meeting.setStatus(MeetingStatus.ACTIVE);
        meeting.setActivatedAt(Instant.now());
        try {
            Meeting saved = meetings.saveAndFlush(meeting);
            log.info("Meeting {} activated by {}.", id, actor);
            return saved;
        } catch (DataIntegrityViolationException ex) {
            // The partial unique index refused it: someone else activated a meeting in the moment
            // between the read above and this write.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Another meeting was activated at the same time. Reload and try again.", ex);
        }
    }

    @Transactional
    public Meeting close(UUID id, String actor) {
        Meeting meeting = get(id);
        if (meeting.getStatus() == MeetingStatus.CLOSED) return meeting;
        meeting.setStatus(MeetingStatus.CLOSED);
        meeting.setClosedAt(Instant.now());
        log.info("Meeting {} closed by {}.", id, actor);
        return meetings.save(meeting);
    }

    @Transactional
    public Meeting updateDetails(UUID id, String title, String description, Instant scheduledAt,
                                 Double quorumThresholdPercent) {
        Meeting meeting = get(id);
        if (title != null && !title.isBlank()) meeting.setTitle(title.trim());
        if (description != null) meeting.setDescription(description.isBlank() ? null : description);
        if (scheduledAt != null) meeting.setScheduledAt(scheduledAt);
        if (quorumThresholdPercent != null) {
            meeting.setQuorumThresholdPercent(quorumThresholdPercent);
        }
        return meetings.save(meeting);
    }

    /**
     * Delete a meeting and its membership.
     *
     * <p>Refused while live: deleting the meeting people are currently asking questions in is
     * almost certainly a mistake, and closing it first makes the intent explicit.
     *
     * <p>Takes the ballot with it — votes first, then resolutions, then membership. Nothing here
     * relies on a database cascade because these rows reference their meeting by plain id rather than
     * by a mapped association, so orphaning them would leave a tally attached to a meeting that no
     * longer exists.
     */
    @Transactional
    public void delete(UUID id, String actor) {
        Meeting meeting = get(id);
        if (meeting.getStatus() == MeetingStatus.ACTIVE) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Close this meeting before deleting it — it is currently live.");
        }
        votes.deleteByMeetingId(id);
        resolutions.deleteByMeetingId(id);
        members.deleteByMeetingId(id);
        meetings.delete(meeting);
        log.info("Meeting {} deleted by {}.", id, actor);
    }

    // ---- membership ----------------------------------------------------------

    /**
     * Map a user to a meeting.
     *
     * <p>The username is stored as text and is not required to exist yet: an invitation list that
     * could only contain users who had already signed in would be useless for the case it exists
     * for. Idempotent — adding somebody twice updates their role rather than failing.
     *
     * <p>{@code votingWeight} is the member's entitlement: shares held, or 1 for
     * one-member-one-vote. It is set here, by a user manager, and never by the voter — see
     * {@code MeetingMember}.
     */
    @Transactional
    public MeetingMember addMember(UUID meetingId, String username, String roleInMeeting,
                                   Integer votingWeight, String addedBy) {
        Meeting meeting = get(meetingId);
        String clean = username == null ? "" : username.trim();
        if (clean.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A username is required.");
        }
        if (meeting.getStatus() == MeetingStatus.CLOSED) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This meeting is closed; its member list is now part of the record.");
        }

        Optional<MeetingMember> existing = members.findByMeetingIdAndUsername(meetingId, clean);
        if (existing.isPresent()) {
            MeetingMember member = existing.get();
            if (roleInMeeting != null && !roleInMeeting.isBlank()) {
                member.setRoleInMeeting(roleInMeeting.trim());
            }
            if (votingWeight != null) member.setVotingWeight(votingWeight);
            return members.save(member);
        }
        MeetingMember member = new MeetingMember(meetingId, clean, roleInMeeting, addedBy);
        if (votingWeight != null) member.setVotingWeight(votingWeight);
        return members.save(member);
    }

    /**
     * Total entitlement mapped to this meeting — the denominator for quorum.
     *
     * <p>Exposed here rather than read straight from the repository so the quorum calculation has one
     * definition of "everyone who could vote", and 404s for a meeting that does not exist instead of
     * quietly returning zero.
     */
    @Transactional(readOnly = true)
    public long totalVotingWeight(UUID meetingId) {
        get(meetingId);
        return members.totalVotingWeight(meetingId);
    }

    /** Entitlement of members who have voted at least once — the numerator for quorum. */
    @Transactional(readOnly = true)
    public long representedVotingWeight(UUID meetingId) {
        return members.representedVotingWeight(meetingId);
    }

    /**
     * This member's entitlement, or empty when they are not mapped to the meeting.
     *
     * <p>Empty is the answer that stops a non-member voting: the ballot asks for a weight and gets
     * nothing back, rather than defaulting to 1 and silently enfranchising someone.
     */
    @Transactional(readOnly = true)
    public Optional<Integer> votingWeightOf(UUID meetingId, String username) {
        if (username == null || username.isBlank()) return Optional.empty();
        return members.findByMeetingIdAndUsername(meetingId, username)
                .map(MeetingMember::getVotingWeight);
    }

    @Transactional
    public void removeMember(UUID meetingId, String username) {
        members.findByMeetingIdAndUsername(meetingId, username)
                .ifPresent(members::delete);
    }

    /** Whether a user is mapped to a meeting — the check scoping will use once it is turned on. */
    @Transactional(readOnly = true)
    public boolean isMember(UUID meetingId, String username) {
        return username != null && members.existsByMeetingIdAndUsername(meetingId, username);
    }
}
