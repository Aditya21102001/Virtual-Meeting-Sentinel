package com.agmsentinel.model;

/**
 * Where a resolution is in its life.
 *
 * <p>Votes are accepted only while {@link #OPEN}. That is the whole point of the state: a resolution
 * put to the meeting has a moment when the chair opens the floor and a moment when they close it,
 * and a vote arriving outside that window is not a late vote — it is an invalid one.
 */
public enum ResolutionStatus {

    /** Drafted and visible to the moderator, not yet put to the meeting. */
    DRAFT,

    /** The floor is open. This is the only state in which a vote is accepted. */
    OPEN,

    /** Voting has ended. The tally is final and the record is closed. */
    CLOSED
}
