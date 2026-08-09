package com.agmsentinel.controller;

import com.agmsentinel.dto.ChatDtos.UserDto;
import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.security.Roles;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.security.Principal;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Member directory + role management (the /members screen). Gated to MODERATOR/ADMIN in
 * SecurityConfig. This is what finally makes the previously-unassigned ADMIN and the new
 * SHAREHOLDER roles reachable — you can promote/assign users here.
 *
 * <h2>Two kinds of role</h2>
 * The <b>primary</b> role says what kind of participant someone is, and there is exactly one.
 * <b>Additional</b> roles — MEETING_MANAGER, USER_MANAGER — are duties granted on top, any number of
 * them, because they are orthogonal to being a moderator or a shareholder. Managing them separately
 * is what lets the same person run the board and schedule the meeting it belongs to.
 */
@RestController
@RequestMapping("/api/users")
public class UserController {

    /**
     * Role changes are logged here as an audit trail, not as debugging noise.
     *
     * <p>Granting USER_MANAGER, MEETING_MANAGER or ADMIN hands somebody authority over a governance
     * record. Left unlogged — as it was — there is no way afterwards to answer "who made this person
     * an admin, and when?", which is the first question anyone asks when a permission turns out to
     * be wrong. Each entry names the actor, the subject, and the value it replaced, because a new
     * value alone does not say what changed.
     */
    private static final Logger log = LoggerFactory.getLogger(UserController.class);

    private final AppUserRepository users;

    public UserController(AppUserRepository users) {
        this.users = users;
    }

    /** The user whose role is changing, alongside the role to give them. */
    public record SetRoleFor(UUID id, String role) { }

    /** The user whose duties are changing, and the full set they should end up with. */
    public record SetExtraRolesFor(UUID id, Set<String> roles) { }

    /**
     * A member as the directory shows them: primary role plus any additional duties.
     *
     * <p>A wider shape than {@code UserDto}, which is shared with the chat directory and has no
     * business carrying role administration detail.
     */
    public record MemberView(String id, String username, String email, String role,
                             Set<String> extraRoles, Instant createdAt) {

        static MemberView of(AppUser user) {
            return new MemberView(user.getId().toString(), user.getUsername(), user.getEmail(),
                    user.getRole(), Set.copyOf(user.getExtraRoles()), user.getCreatedAt());
        }
    }

    @PostMapping("/list-members")
    public List<UserDto> listMembers() {
        return users.findAll().stream()
                .map(u -> new UserDto(u.getId().toString(), u.getUsername(), u.getEmail(), u.getRole()))
                .toList();
    }

    /** The directory with role administration detail — used by the members screen. */
    @PostMapping("/list-members-detailed")
    public List<MemberView> listMembersDetailed() {
        return users.findAll().stream().map(MemberView::of).toList();
    }

    @PostMapping("/set-member-role")
    public UserDto setMemberRole(@RequestBody SetRoleFor req, Principal actor) {
        if (req.id() == null || req.role() == null || req.role().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "id and role are required.");
        }
        String role = req.role().toUpperCase();
        if (!Roles.isAssignable(role)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Role must be one of " + Roles.ASSIGNABLE);
        }
        AppUser user = users.findById(req.id())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found."));
        String previous = user.getRole();
        user.setRole(role);
        users.save(user);
        // Captured before the change and reported alongside it: "set to MODERATOR" does not say
        // whether that was a promotion or a demotion, and that difference is the whole point of
        // reading this line back later.
        log.info("Role change: {} set {} from {} to {}.",
                 actorName(actor), user.getUsername(), previous, role);
        return new UserDto(user.getId().toString(), user.getUsername(), user.getEmail(), user.getRole());
    }

    /**
     * Replace a user's additional duties with exactly this set.
     *
     * <p>Set semantics rather than add/remove: the screen presents checkboxes, and sending the
     * resulting state means an unchecked box is unambiguous. Add/remove endpoints would have made
     * "not mentioned" mean "leave alone", which is the same request as "remove" from the UI's point
     * of view and cannot be told apart.
     *
     * <p>Takes effect on the user's next token — an existing session keeps the roles it was issued
     * with until it renews, which is at most a few minutes of activity away.
     */
    /**
     * Who performed the change, for the audit line.
     *
     * <p>Never null in practice — both routes require a session — but defended anyway, because an
     * audit entry that throws while recording a privilege grant would lose the very event it exists
     * to capture.
     */
    private static String actorName(Principal actor) {
        return actor == null || actor.getName() == null ? "an unidentified caller" : actor.getName();
    }

    @PostMapping("/set-member-extra-roles")
    public MemberView setMemberExtraRoles(@RequestBody SetExtraRolesFor req, Principal actor) {
        if (req.id() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "id is required.");
        }
        Set<String> requested = new LinkedHashSet<>();
        for (String raw : req.roles() == null ? Set.<String>of() : req.roles()) {
            if (raw == null || raw.isBlank()) continue;
            String role = raw.toUpperCase();
            if (!Roles.isAdditional(role)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Additional roles must be from " + Roles.ADDITIONAL
                        + ". The primary role is set separately.");
            }
            requested.add(role);
        }
        AppUser user = users.findById(req.id())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found."));
        Set<String> previous = Set.copyOf(user.getExtraRoles());
        user.setExtraRoles(requested);
        users.save(user);
        // These are the duties that carry real authority — USER_MANAGER can map anyone to any
        // meeting, MEETING_MANAGER can open and close the ballot — so the grant is recorded with
        // the same care as the primary role above.
        log.info("Duty change: {} set {} from {} to {}.",
                 actorName(actor), user.getUsername(),
                 previous.isEmpty() ? "no additional duties" : previous,
                 requested.isEmpty() ? "no additional duties" : requested);
        return MemberView.of(user);
    }
}
