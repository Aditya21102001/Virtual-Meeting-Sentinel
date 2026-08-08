package com.agmsentinel.controller;

import com.agmsentinel.dto.ChatDtos.UserDto;
import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.security.Roles;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

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
    public UserDto setMemberRole(@RequestBody SetRoleFor req) {
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
        user.setRole(role);
        users.save(user);
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
    @PostMapping("/set-member-extra-roles")
    public MemberView setMemberExtraRoles(@RequestBody SetExtraRolesFor req) {
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
        user.setExtraRoles(requested);
        users.save(user);
        return MemberView.of(user);
    }
}
