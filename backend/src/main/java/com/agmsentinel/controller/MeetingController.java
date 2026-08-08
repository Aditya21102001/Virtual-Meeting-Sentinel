package com.agmsentinel.controller;

import com.agmsentinel.dto.MeetingDtos.MeetingMemberView;
import com.agmsentinel.dto.MeetingDtos.MeetingView;
import com.agmsentinel.model.Meeting;
import com.agmsentinel.security.Feature;
import com.agmsentinel.security.RequiresFeature;
import com.agmsentinel.service.MeetingService;
import jakarta.validation.constraints.NotNull;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Meeting management, and mapping users to meetings.
 *
 * <p>Two duties behind two roles (see {@code Roles} and {@code SecurityConfig}): MEETING_MANAGER
 * creates meetings and decides which is live; USER_MANAGER decides who is in one. Both are additive
 * to a user's primary role, so a moderator can hold either without giving up the board.
 *
 * <p>{@code active-meeting} is the exception — any signed-in user may ask what is live, because
 * every other screen needs to know.
 *
 * <p>Named POST routes with identifiers in the body, matching the rest of the API: the network panel
 * labels a request by its last path segment, so {@code activate-meeting} is readable where
 * {@code /api/meetings/{uuid}} was a column of indistinguishable ids.
 */
@RequiresFeature(Feature.MEETINGS)
@RestController
@RequestMapping("/api/meetings")
public class MeetingController {

    private final MeetingService meetings;

    public MeetingController(MeetingService meetings) {
        this.meetings = meetings;
    }

    public record MeetingRef(@NotNull UUID id) { }

    public record CreateMeetingRequest(String title, String description, Instant scheduledAt) { }

    public record UpdateMeetingRequest(@NotNull UUID id, String title, String description,
                                       Instant scheduledAt, Double quorumThresholdPercent) { }

    /**
     * {@code votingWeight} is the member's entitlement — shares held, or 1 for
     * one-member-one-vote. Set here by a user manager and never by the voter.
     */
    public record MemberRequest(@NotNull UUID id, String username, String roleInMeeting,
                                Integer votingWeight) { }

    public record DeletedResponse(UUID id, boolean deleted) { }

    // ---- reading -------------------------------------------------------------

    /**
     * Every meeting, newest first, each with its member count.
     *
     * <p>Counts come from one batched query rather than one per row — the same reason the video
     * catalogue resolves its engagement counts in a batch.
     */
    @PostMapping("/list-meetings")
    public List<MeetingView> listMeetings() {
        List<Meeting> all = meetings.listAll();
        Map<UUID, Long> counts = meetings.memberCounts(all);
        return all.stream()
                .map(m -> MeetingView.of(m, counts.getOrDefault(m.getId(), 0L)))
                .toList();
    }

    /**
     * The live meeting, or null when none has been activated.
     *
     * <p>Open to any signed-in user: the board, the question form and the library all need to know
     * which meeting they are part of, and that is not privileged information.
     */
    @PostMapping("/active-meeting")
    public MeetingView activeMeeting() {
        return meetings.active()
                .map(m -> MeetingView.of(m, meetings.memberCounts(List.of(m))
                        .getOrDefault(m.getId(), 0L)))
                .orElse(null);
    }

    @PostMapping("/list-members")
    public List<MeetingMemberView> listMembers(@RequestBody MeetingRef req) {
        return meetings.membersOf(req.id()).stream().map(MeetingMemberView::of).toList();
    }

    // ---- lifecycle (MEETING_MANAGER) -----------------------------------------

    @PostMapping("/create-meeting")
    public MeetingView createMeeting(@RequestBody CreateMeetingRequest req) {
        Meeting meeting = meetings.create(req.title(), req.description(), req.scheduledAt(),
                                          currentSubject());
        return MeetingView.of(meeting, 0);
    }

    @PostMapping("/update-meeting")
    public MeetingView updateMeeting(@RequestBody UpdateMeetingRequest req) {
        return view(meetings.updateDetails(req.id(), req.title(), req.description(),
                                           req.scheduledAt(), req.quorumThresholdPercent()));
    }

    /** Make this meeting live. Whichever meeting was live is closed in the same transaction. */
    @PostMapping("/activate-meeting")
    public MeetingView activateMeeting(@RequestBody MeetingRef req) {
        return view(meetings.activate(req.id(), currentSubject()));
    }

    @PostMapping("/close-meeting")
    public MeetingView closeMeeting(@RequestBody MeetingRef req) {
        return view(meetings.close(req.id(), currentSubject()));
    }

    @PostMapping("/delete-meeting")
    public DeletedResponse deleteMeeting(@RequestBody MeetingRef req) {
        meetings.delete(req.id(), currentSubject());
        return new DeletedResponse(req.id(), true);
    }

    // ---- membership (USER_MANAGER) -------------------------------------------

    /** Idempotent: adding somebody already mapped updates their role rather than failing. */
    @PostMapping("/add-member")
    public MeetingMemberView addMember(@RequestBody MemberRequest req) {
        return MeetingMemberView.of(meetings.addMember(req.id(), req.username(),
                req.roleInMeeting(), req.votingWeight(), currentSubject()));
    }

    @PostMapping("/remove-member")
    public DeletedResponse removeMember(@RequestBody MemberRequest req) {
        meetings.removeMember(req.id(), req.username());
        return new DeletedResponse(req.id(), true);
    }

    private MeetingView view(Meeting meeting) {
        return MeetingView.of(meeting,
                meetings.memberCounts(List.of(meeting)).getOrDefault(meeting.getId(), 0L));
    }

    private String currentSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth == null ? "system" : String.valueOf(auth.getName());
    }
}
