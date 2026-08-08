package com.agmsentinel.model;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for the rule that decides whether a motion passed.
 *
 * <p>This is the most important arithmetic in the application. If it is wrong, the system records
 * that a company's members approved something they did not — so the cases below are deliberately
 * about the boundaries, where an off-by-one or a rounding error would hide.
 *
 * <p><b>Background for anyone new to this.</b> At a shareholders' meeting, motions ("resolutions")
 * are voted on. An <em>ordinary</em> resolution needs a simple majority: more votes for than
 * against. A <em>special</em> resolution — used for bigger decisions, like changing the company's
 * constitution — needs at least 75%. Members can abstain, which means "I am here, but I am not
 * taking a side". Abstentions are left out of the maths entirely: they neither help nor hinder.
 *
 * <p>Votes are counted by <em>weight</em>, not by headcount: a member holding 1,000 shares usually
 * gets 1,000 votes. That is why every number below is a weight.
 */
class ResolutionTypeTest {

    // ---- ordinary resolutions: more for than against --------------------------

    @Test
    @DisplayName("ordinary: carries on a simple majority")
    void ordinaryCarriesOnMajority() {
        assertTrue(ResolutionType.ORDINARY.carried(51, 49));
    }

    @Test
    @DisplayName("ordinary: a tie does not carry")
    void ordinaryTieFails() {
        // A tied vote is not a majority. The motion fails; it is not the chair's to break here.
        assertFalse(ResolutionType.ORDINARY.carried(50, 50));
    }

    @Test
    @DisplayName("ordinary: one vote either way is enough")
    void ordinaryNarrowestMajority() {
        assertTrue(ResolutionType.ORDINARY.carried(2, 1));
        assertFalse(ResolutionType.ORDINARY.carried(1, 2));
    }

    @Test
    @DisplayName("ordinary: abstentions are excluded, so they cannot defeat a motion")
    void ordinaryIgnoresAbstentions() {
        // carried() is never told about abstentions — that is the point. Ten members abstaining
        // alongside 2 for and 1 against still leaves a motion that carried.
        assertTrue(ResolutionType.ORDINARY.carried(2, 1));
    }

    // ---- special resolutions: at least 75% ------------------------------------

    @Test
    @DisplayName("special: exactly 75% carries")
    void specialExactlyThreeQuartersCarries() {
        // 3 for and 1 against is precisely 75%. "Not less than 75%" includes 75%, so this passes.
        // This is the case a percentage comparison built on floating point can get wrong.
        assertTrue(ResolutionType.SPECIAL.carried(3, 1));
    }

    @Test
    @DisplayName("special: just under 75% does not carry")
    void specialJustUnderFails() {
        // 74 of 100 decisive votes = 74%.
        assertFalse(ResolutionType.SPECIAL.carried(74, 26));
    }

    @Test
    @DisplayName("special: a simple majority is not enough")
    void specialNeedsMoreThanMajority() {
        assertFalse(ResolutionType.SPECIAL.carried(60, 40));
    }

    @Test
    @DisplayName("special: exactly 75% still carries at awkward numbers")
    void specialExactBoundaryAtLargerNumbers() {
        // 750 of 1000. Chosen because 750/1000 is exactly representable, and 3/4 of many other
        // totals is not — the integer test does not care either way.
        assertTrue(ResolutionType.SPECIAL.carried(750, 250));
        assertFalse(ResolutionType.SPECIAL.carried(749, 251));
    }

    // ---- nothing voted --------------------------------------------------------

    @Test
    @DisplayName("neither type carries when nobody voted")
    void nothingVotedDoesNotCarry() {
        // Guards the trap in the ratio test: with no votes, 0 * 4 >= 0 * 3 is true, which would
        // have reported an untouched motion as passed.
        assertFalse(ResolutionType.ORDINARY.carried(0, 0));
        assertFalse(ResolutionType.SPECIAL.carried(0, 0));
    }

    @Test
    @DisplayName("neither type carries when every vote was against")
    void allAgainstDoesNotCarry() {
        assertFalse(ResolutionType.ORDINARY.carried(0, 10));
        assertFalse(ResolutionType.SPECIAL.carried(0, 10));
    }

    @Test
    @DisplayName("both types carry when every vote was in favour")
    void allForCarries() {
        assertTrue(ResolutionType.ORDINARY.carried(10, 0));
        assertTrue(ResolutionType.SPECIAL.carried(10, 0));
    }

    // ---- the displayed threshold ----------------------------------------------

    @Test
    @DisplayName("the displayed threshold matches the rule being applied")
    void displayedThresholdMatchesRule() {
        // requiredMajorityPercent() is only ever shown to a human ("needs 75%"). It must still agree
        // with carried(), or the screen would explain a different rule from the one being used.
        assertTrue(ResolutionType.ORDINARY.requiredMajorityPercent() == 50.0);
        assertTrue(ResolutionType.SPECIAL.requiredMajorityPercent() == 75.0);
    }
}
