package com.agmsentinel.controller;

import com.agmsentinel.dto.ChatDtos.SetRoleRequest;
import com.agmsentinel.dto.ChatDtos.UserDto;
import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.security.Roles;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.UUID;

/**
 * Member directory + role management (the /members screen). Gated to MODERATOR/ADMIN in
 * SecurityConfig. This is what finally makes the previously-unassigned ADMIN and the new
 * SHAREHOLDER roles reachable — you can promote/assign users here.
 */
@RestController
@RequestMapping("/api/users")
public class UserController {

    private final AppUserRepository users;

    public UserController(AppUserRepository users) {
        this.users = users;
    }

    @GetMapping
    public List<UserDto> list() {
        return users.findAll().stream()
                .map(u -> new UserDto(u.getId().toString(), u.getUsername(), u.getEmail(), u.getRole()))
                .toList();
    }

    @PatchMapping("/{id}/role")
    public UserDto setRole(@PathVariable UUID id, @Valid @RequestBody SetRoleRequest req) {
        String role = req.role().toUpperCase();
        if (!Roles.isAssignable(role)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Role must be one of " + Roles.ASSIGNABLE);
        }
        AppUser user = users.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found."));
        user.setRole(role);
        users.save(user);
        return new UserDto(user.getId().toString(), user.getUsername(), user.getEmail(), user.getRole());
    }
}
