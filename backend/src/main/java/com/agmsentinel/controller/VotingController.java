package com.agmsentinel.controller;

import com.agmsentinel.dto.VotingDtos.QuorumView;
import com.agmsentinel.dto.VotingDtos.ResolutionView;
import com.agmsentinel.dto.VotingDtos.TallyView;
import com.agmsentinel.model.Resolution;
import com.agmsentinel.model.ResolutionType;
import com.agmsentinel.model.Vote;
import com.agmsentinel.model.VoteChoice;
import com.agmsentinel.security.Feature;
import com.agmsentinel.security.RequiresFeature;
import com.agmsentinel.security.Roles;
import com.agmsentinel.service.VotingService;
import com.agmsentinel.service.VotingService.Tally;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Resolutions, votes and quorum.
 *
 * <p>Behind the {@code VOTING} flag, which ships off — a deployment that does not take formal
 * business never sees any of this.
 *
 * <p><b>What the client may say, and what it may not.</b> A vote request carries the resolution and
 * the choice. It does not carry who is voting — that is the authenticated subject — and it does not
 * carry the weight, which comes from the meeting's member list. A weight the client could send would
 * be a weight the client could inflate, and that is the whole of the security model here.
 *
 * <p><b>Results are withheld while a vote is open</b> unless the chair has published them. Seeing a
 * running tally changes the votes still to come, which is why a show of hands is taken at once. The
 * {@code result} field is null in that case rather than zeroed — an all-zero tally would read as "no
 * support" instead of "not published yet".
 *
 * <p>Named POST routes with identifiers in the body, matching the rest of the API.
 */
@RequiresFeature(Feature.VOTING)
@RestController
@RequestMapping("/api/voting")
public class VotingController {

    private final VotingService voting;

    public VotingController(VotingService voting) {
        this.voting = voting;
    }

    public record MeetingRef(@NotNull UUID meetingId) { }

    public record ResolutionRef(@NotNull UUID id) { }

    public record CreateResolutionRequest(@NotNull UUID meetingId, String title, String text,
                                          String type) { }

    public record UpdateResolutionRequest(@NotNull UUID id, String title, String text, String type,
                                          Integer seq, Boolean liveResultsVisible) { }

    /** The whole of what a voter may assert: which motion, and how they vote. */
    public record CastVoteRequest(@NotNull UUID resolutionId, String choice) { }

    public record DeletedResponse(UUID id, boolean deleted) { }

    // ---- reading -------------------------------------------------------------

    /**
     * The agenda for a meeting, with this caller's own vote on each motion.
     *
     * <p>Tallies for the whole agenda come from one grouped query, and each is included only if this
     * caller may see it.
     */
    @PostMapping("/list-resolutions")
    public List<ResolutionView> listResolutions(@RequestBody MeetingRef req) {
        requireRealAccount();
        voting.assertMayViewAgenda(req.meetingId(), currentSubject(), isModerator());

        List<Resolution> agenda = voting.agenda(req.meetingId());
        Map<UUID, Tally> tallies = voting.tallies(agenda);
        Map<UUID, VoteChoice> mine = voting.myChoices(agenda, currentSubject());
        boolean moderator = isModerator();

        return agenda.stream()
                .map(r -> ResolutionView.of(r, mine.get(r.getId()),
                        voting.maySeeResults(r, moderator)
                                ? TallyView.of(tallies.get(r.getId()))
                                : null))
                .toList();
    }

    @PostMapping("/resolution-details")
    public ResolutionView resolutionDetails(@RequestBody ResolutionRef req) {
        requireRealAccount();
        Resolution resolution = voting.get(req.id());
        voting.assertMayViewAgenda(resolution.getMeetingId(), currentSubject(), isModerator());

        VoteChoice mine = voting.myVote(req.id(), currentSubject())
                .map(Vote::getChoice).orElse(null);
        TallyView result = voting.maySeeResults(resolution, isModerator())
                ? TallyView.of(voting.tally(resolution))
                : null;
        return ResolutionView.of(resolution, mine, result);
    }

    /**
     * Whether enough of the register is taking part for business to be valid.
     *
     * <p>Behind its own flag as well as {@code VOTING}: plenty of meetings run votes without
     * tracking quorum, and a quorum bar that a deployment has no register to populate would show a
     * permanent, meaningless zero.
     *
     * <p>Both are stated here rather than relying on VOTING being inherited from the class. The
     * inherited version worked, but it made a security property depend on where the annotation
     * happened to sit — move this method to another controller and the VOTING requirement would
     * vanish silently.
     */
    @RequiresFeature(Feature.VOTING)
    @RequiresFeature(Feature.QUORUM)
    @PostMapping("/meeting-quorum")
    public QuorumView meetingQuorum(@RequestBody MeetingRef req) {
        requireRealAccount();
        voting.assertMayViewAgenda(req.meetingId(), currentSubject(), isModerator());
        return QuorumView.of(voting.quorum(req.meetingId()));
    }

    // ---- voting --------------------------------------------------------------

    /**
     * Cast or change a vote. The subject comes from the token, the weight from the member list.
     *
     * <p>Returns the resolution as this caller now sees it, so a client never has to guess whether
     * its vote landed — and still does not see the tally if the chair has not published it.
     */
    @PostMapping("/cast-vote")
    public ResolutionView castVote(@RequestBody CastVoteRequest req) {
        requireRealAccount();
        VoteChoice choice = parseChoice(req.choice());
        Vote vote = voting.castVote(req.resolutionId(), currentSubject(), choice);

        Resolution resolution = voting.get(req.resolutionId());
        TallyView result = voting.maySeeResults(resolution, isModerator())
                ? TallyView.of(voting.tally(resolution))
                : null;
        return ResolutionView.of(resolution, vote.getChoice(), result);
    }

    @PostMapping("/my-vote")
    public Map<String, Object> myVote(@RequestBody ResolutionRef req) {
        requireRealAccount();
        return voting.myVote(req.id(), currentSubject())
                .<Map<String, Object>>map(v -> Map.of(
                        "resolutionId", v.getResolutionId(),
                        "choice", v.getChoice().name(),
                        "weight", v.getWeight(),
                        "castAt", v.getCastAt()))
                .orElseGet(() -> Map.of("resolutionId", req.id(), "choice", ""));
    }

    // ---- the chair's acts (MODERATOR/ADMIN) -----------------------------------

    @PostMapping("/create-resolution")
    public ResolutionView createResolution(@RequestBody CreateResolutionRequest req) {
        Resolution resolution = voting.create(req.meetingId(), req.title(), req.text(),
                                              parseType(req.type()), currentSubject());
        return ResolutionView.of(resolution, null, TallyView.of(voting.tally(resolution)));
    }

    @PostMapping("/update-resolution")
    public ResolutionView updateResolution(@RequestBody UpdateResolutionRequest req) {
        Resolution resolution = voting.update(req.id(), req.title(), req.text(),
                                              req.type() == null ? null : parseType(req.type()),
                                              req.seq(), req.liveResultsVisible());
        return moderatorView(resolution);
    }

    /** Open the floor. Only a live meeting, and only from DRAFT. */
    @PostMapping("/open-resolution")
    public ResolutionView openResolution(@RequestBody ResolutionRef req) {
        return moderatorView(voting.open(req.id(), currentSubject()));
    }

    /** Close the vote and fix the result. Closed is final — see {@code VotingService}. */
    @PostMapping("/close-resolution")
    public ResolutionView closeResolution(@RequestBody ResolutionRef req) {
        return moderatorView(voting.close(req.id(), currentSubject()));
    }

    @PostMapping("/delete-resolution")
    public DeletedResponse deleteResolution(@RequestBody ResolutionRef req) {
        voting.delete(req.id(), currentSubject());
        return new DeletedResponse(req.id(), true);
    }

    // ---- internals -----------------------------------------------------------

    /** A moderator always sees the tally, so these responses never withhold it. */
    private ResolutionView moderatorView(Resolution resolution) {
        VoteChoice mine = voting.myVote(resolution.getId(), currentSubject())
                .map(Vote::getChoice).orElse(null);
        return ResolutionView.of(resolution, mine, TallyView.of(voting.tally(resolution)));
    }

    private VoteChoice parseChoice(String raw) {
        try {
            return VoteChoice.valueOf(String.valueOf(raw).trim().toUpperCase());
        } catch (IllegalArgumentException | NullPointerException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Choose FOR, AGAINST or ABSTAIN.");
        }
    }

    private ResolutionType parseType(String raw) {
        if (raw == null || raw.isBlank()) return ResolutionType.ORDINARY;
        try {
            return ResolutionType.valueOf(raw.trim().toUpperCase());
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "A resolution is either ORDINARY or SPECIAL.");
        }
    }

    /**
     * Refuse anonymous attendee tokens outright.
     *
     * <p><b>Why this exists.</b> {@code /api/auth/attendee} is a public endpoint that issues a token
     * whose subject is whatever username the caller typed — no password, no verification. That is
     * deliberate and harmless for asking a question, where the name is only a label on a card. It is
     * fatal for a ballot: anyone on the internet could ask for a token as "alice" and then cast
     * alice's vote.
     *
     * <p>{@code SecurityConfig} already keeps ATTENDEE off these routes by requiring a role that
     * only a real account can hold, and that is the primary defence. This is the second one. The
     * cost of the two disagreeing — a route added later under a looser matcher, a role renamed — is
     * a forged vote in a legal record, so it is worth paying for twice.
     */
    private void requireRealAccount() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Sign in to take part.");
        }
        for (GrantedAuthority authority : auth.getAuthorities()) {
            if (("ROLE_" + Roles.ATTENDEE).equals(authority.getAuthority())) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                        "Voting needs a registered account. The anonymous attendee pass lets you "
                        + "ask questions, but it cannot be used to vote.");
            }
        }
    }

    /**
     * Whether the caller is running the meeting.
     *
     * <p>Read from the granted authorities rather than from anything in the request — this decides
     * who may see a tally early, so it has to come from the token.
     */
    private boolean isModerator() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null) return false;
        for (GrantedAuthority authority : auth.getAuthorities()) {
            String role = authority.getAuthority();
            if (("ROLE_" + Roles.MODERATOR).equals(role) || ("ROLE_" + Roles.ADMIN).equals(role)) {
                return true;
            }
        }
        return false;
    }

    private String currentSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth == null ? null : String.valueOf(auth.getName());
    }
}
