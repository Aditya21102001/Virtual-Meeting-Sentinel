package com.agmsentinel.security;

import java.util.Arrays;
import java.util.Optional;
import java.util.Set;

/**
 * The catalogue of switchable features — one entry per thing an admin can turn on or off.
 *
 * <p>A single source of truth on purpose. The database stores only what an admin has <em>changed</em>;
 * everything a feature is — its name, what it does, who may use it, whether it starts on — lives
 * here. That means adding a feature is one enum constant rather than an enum constant plus a
 * migration plus a row somebody has to remember to insert, and the admin screen populates itself.
 *
 * <h2>Why the defaults are split</h2>
 * Features that already shipped default to <b>on</b>; everything new defaults to <b>off</b>. That is
 * what makes deploying this safe with live users: the flags arrive, nothing changes, and each new
 * capability is switched on deliberately when someone is ready to watch it.
 *
 * <h2>Roles here are a ceiling, not a grant</h2>
 * {@code allowedRoles} narrows who may use a feature; it never widens anything. A role that could
 * not reach an endpoint before still cannot — {@code SecurityConfig} is checked first and
 * independently. Listing SHAREHOLDER on a moderator-only route grants a shareholder nothing.
 */
public enum Feature {

    // ---- already shipped: default ON so a deploy changes nothing ----------------

    VIDEO_LIBRARY("Video library",
            "Upload, transcode and stream meeting recordings.",
            true, Set.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER, Roles.ATTENDEE)),

    VIDEO_ENGAGEMENT("Likes and comments",
            "Let members like recordings and comment, optionally at a timestamp.",
            true, Set.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER, Roles.ATTENDEE)),

    VIDEO_DOWNLOAD("Recording downloads",
            "Offer a recording for download, in any available quality.",
            true, Set.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER)),

    LOUNGE_CHAT("Shareholder lounge",
            "Member-to-member chat and the GenAI assistant.",
            true, Set.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER, Roles.ATTENDEE)),

    AI_DRAFTING("AI answer drafting",
            "Draft grounded answers for question clusters, with citations.",
            true, Set.of(Roles.ADMIN, Roles.MODERATOR)),

    // ---- new: default OFF ------------------------------------------------------

    MEETINGS("Meeting management",
            "Schedule meetings, activate one at a time, and map users to them.",
            false, Set.of(Roles.ADMIN, Roles.MEETING_MANAGER, Roles.USER_MANAGER)),

    SEMANTIC_SEARCH("Semantic search",
            "Search the annual report and recording transcripts by meaning. Needs no LLM.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER, Roles.ATTENDEE)),

    /**
     * The floating bubble, and the search behind it.
     *
     * <p>Mostly user interface, so the visible half is enforced in the SPA. The half that matters is
     * on the server: {@code semantic-search} requires this feature <em>as well as</em>
     * {@link #SEMANTIC_SEARCH}, because that route exists to serve the widget and hiding the bubble
     * while leaving the endpoint answering direct callers would be a switch that only half works.
     *
     * <p>If another surface ever needs semantic search, give it its own route gated on
     * {@link #SEMANTIC_SEARCH} alone rather than loosening that one.
     */
    HELP_WIDGET("Help bubble",
            "A floating assistant on every page, for quick questions and FAQ.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER, Roles.ATTENDEE)),

    AUTO_TRANSCRIPTION("Automatic captions",
            "Generate recording captions with hosted speech-to-text after transcoding.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR)),

    VOTING("Resolutions and voting",
            "Put resolutions to the meeting and record weighted votes, with live results.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER)),

    QUORUM("Quorum tracking",
            "Track the share weight represented against the threshold the meeting needs.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR)),

    CLUSTER_UPVOTE("Question upvoting",
            "Let attendees upvote an existing topic instead of asking it again.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER, Roles.ATTENDEE)),

    CLUSTER_CURATION("Merge and split topics",
            "Let a moderator correct the clustering live — merge duplicates, split a topic.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR)),

    RUN_OF_SHOW("Run of show",
            "Order topics into a speaking sequence, mark them answered and track time.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR)),

    MEETING_REPORTS("Reports and minutes",
            "Draft minutes, list unanswered questions, and export the record.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR)),

    ATTENDEE_BOARD("Attendee board",
            "Show attendees the ranked topics and their answers, not just a submit box.",
            false, Set.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER, Roles.ATTENDEE));

    private final String label;
    private final String description;
    private final boolean enabledByDefault;
    private final Set<String> defaultRoles;

    Feature(String label, String description, boolean enabledByDefault, Set<String> defaultRoles) {
        this.label = label;
        this.description = description;
        this.enabledByDefault = enabledByDefault;
        this.defaultRoles = defaultRoles;
    }

    public String key() { return name(); }
    public String label() { return label; }
    public String description() { return description; }
    public boolean enabledByDefault() { return enabledByDefault; }
    public Set<String> defaultRoles() { return defaultRoles; }

    /** Empty for an unrecognised key — a stored row for a feature that no longer exists. */
    public static Optional<Feature> of(String key) {
        if (key == null) return Optional.empty();
        return Arrays.stream(values()).filter(f -> f.name().equalsIgnoreCase(key.trim())).findFirst();
    }
}
