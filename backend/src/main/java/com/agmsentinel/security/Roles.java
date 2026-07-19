package com.agmsentinel.security;

import java.util.Set;

/**
 * The application's roles as constants (AppUser.role is stored as a plain String).
 *
 *  - ADMIN       full control, including assigning roles
 *  - MODERATOR   runs the VIRTUAL MEETING board (clusters, drafts) — the default for new registrations
 *  - SHAREHOLDER a registered member who can use the Lounge (1-on-1 chat + GenAI assistant)
 *  - ATTENDEE    ephemeral, anonymous token for question submission (no user row)
 */
public final class Roles {
    private Roles() { }

    public static final String ADMIN = "ADMIN";
    public static final String MODERATOR = "MODERATOR";
    public static final String SHAREHOLDER = "SHAREHOLDER";
    public static final String ATTENDEE = "ATTENDEE";

    /** Roles an admin/moderator may assign to a user via the members screen. */
    public static final Set<String> ASSIGNABLE = Set.of(ADMIN, MODERATOR, SHAREHOLDER);

    public static boolean isAssignable(String role) {
        return role != null && ASSIGNABLE.contains(role.toUpperCase());
    }
}
