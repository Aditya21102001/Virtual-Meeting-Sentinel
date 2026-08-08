package com.agmsentinel.model;

/**
 * The majority a resolution needs to carry.
 *
 * <p>Stored per resolution rather than assumed, because the threshold is a matter of company law and
 * articles of association, not of preference — and ordinary and special resolutions routinely sit on
 * the same agenda.
 *
 * <p>Abstentions are excluded from the denominator throughout. An abstention is a decision not to
 * take a side; counting it as opposition would let abstainers defeat a motion they explicitly
 * declined to oppose.
 */
public enum ResolutionType {

    /** Carried by a simple majority — more votes for than against. */
    ORDINARY(50.0) {
        @Override
        public boolean carried(long forWeight, long againstWeight) {
            return forWeight > againstWeight;
        }
    },

    /**
     * Carried by at least three quarters of the votes cast — used for constitutional changes.
     *
     * <p>Exactly three quarters carries. That is what "not less than 75%" means, and it is the
     * boundary a float comparison would get wrong.
     */
    SPECIAL(75.0) {
        @Override
        public boolean carried(long forWeight, long againstWeight) {
            // The positive guard is load-bearing: with no votes at all the ratio test alone reads
            // 0 >= 0 and would report an unvoted motion as carried.
            return forWeight > 0 && forWeight * 4 >= (forWeight + againstWeight) * 3;
        }
    };

    private final double requiredMajorityPercent;

    ResolutionType(double requiredMajorityPercent) {
        this.requiredMajorityPercent = requiredMajorityPercent;
    }

    /**
     * Whether this motion carried on the given weights.
     *
     * <p>Integer arithmetic on purpose. Deciding by comparing a computed percentage against a
     * threshold puts a binary rounding error on the exact boundary — 3 for and 1 against is precisely
     * 75%, and whether that carries must not depend on how the division rounded.
     *
     * <p>A motion with no votes either way does not carry: nothing was decided.
     */
    public abstract boolean carried(long forWeight, long againstWeight);

    /** For display beside the result — "needs 75%". Never used to decide; see {@link #carried}. */
    public double requiredMajorityPercent() {
        return requiredMajorityPercent;
    }
}
