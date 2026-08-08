package com.agmsentinel.security;

import java.util.Set;

/**
 * The application's roles.
 *
 * <h2>Primary roles</h2>
 * One per user, stored on {@code app_users.role}. These say what kind of participant someone is:
 *
 *  - ADMIN       full control, including assigning roles
 *  - MODERATOR   runs the VIRTUAL MEETING board (clusters, drafts) — the default for new registrations
 *  - SHAREHOLDER a registered member who can use the Lounge (1-on-1 chat + GenAI assistant)
 *  - ATTENDEE    ephemeral, anonymous token for question submission (no user row)
 *
 * <h2>Additional roles</h2>
 * Any number per user, stored in {@code user_roles}. These grant a <em>duty</em> on top of whatever
 * kind of participant someone is, which is why they are additive rather than another value of the
 * primary role:
 *
 *  - MEETING_MANAGER creates meetings and decides which one is active
 *  - USER_MANAGER    maps users to meetings
 *
 * <p>Made separate precisely so a MODERATOR can also manage meetings. Folding them into the primary
 * role would have forced a choice between running the board and scheduling the meeting it belongs
 * to — two jobs the same person routinely does.
 */
public final class Roles {
    private Roles() { }

    public static final String ADMIN = "ADMIN";
    public static final String MODERATOR = "MODERATOR";
    public static final String SHAREHOLDER = "SHAREHOLDER";
    public static final String ATTENDEE = "ATTENDEE";

    /** Creates meetings, and decides which one is active. */
    public static final String MEETING_MANAGER = "MEETING_MANAGER";
    /** Maps users to meetings. */
    public static final String USER_MANAGER = "USER_MANAGER";

    /** Primary roles an admin may assign — exactly one of these per user. */
    public static final Set<String> ASSIGNABLE = Set.of(ADMIN, MODERATOR, SHAREHOLDER);

    /** Duties that may be granted alongside any primary role, in any combination. */
    public static final Set<String> ADDITIONAL = Set.of(MEETING_MANAGER, USER_MANAGER);

    public static boolean isAssignable(String role) {
        return role != null && ASSIGNABLE.contains(role.toUpperCase());
    }

    public static boolean isAdditional(String role) {
        return role != null && ADDITIONAL.contains(role.toUpperCase());
    }
}
