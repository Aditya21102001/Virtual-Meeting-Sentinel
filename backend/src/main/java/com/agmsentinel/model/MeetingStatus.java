package com.agmsentinel.model;

/**
 * Where a meeting is in its life.
 *
 * <p>Exactly one meeting may be {@link #ACTIVE} at a time — enforced by a partial unique index on
 * the table, not only in code, so two simultaneous activations cannot both succeed.
 */
public enum MeetingStatus {

    /** Created and being prepared. Members can be mapped; nothing is live yet. */
    DRAFT,

    /**
     * Live. Questions asked now belong to this meeting, and it is the one the board shows.
     * Activating another meeting closes this one.
     */
    ACTIVE,

    /** Finished. Its questions and recordings remain, as the record of what happened. */
    CLOSED
}
