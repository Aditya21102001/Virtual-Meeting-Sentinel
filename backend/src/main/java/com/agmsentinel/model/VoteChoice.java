package com.agmsentinel.model;

/**
 * How a member voted.
 *
 * <p>{@link #ABSTAIN} is a real, recorded position rather than an absence: an abstention counts
 * towards quorum — the member was present and participating — but is excluded from the majority
 * calculation. Conflating it with "did not vote" would misstate both numbers.
 */
public enum VoteChoice { FOR, AGAINST, ABSTAIN }
