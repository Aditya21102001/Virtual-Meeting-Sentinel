package com.agmsentinel.dto;

import com.agmsentinel.model.Resolution;
import com.agmsentinel.model.VoteChoice;
import com.agmsentinel.service.VotingService.Quorum;
import com.agmsentinel.service.VotingService.Tally;

import java.time.Instant;
import java.util.UUID;

/** Wire shapes for resolutions, votes and quorum. */
public final class VotingDtos {

    private VotingDtos() { }

    /**
     * A resolution as a ballot or an agenda renders it.
     *
     * <p>{@code result} is null when the caller is not entitled to see it — while a vote is open and
     * the chair has not published the running count. Null rather than a zeroed tally on purpose: an
     * all-zero result is indistinguishable from "nobody has voted", and the UI needs to say "results
     * are not published yet" instead of quietly implying no support.
     */
    public record ResolutionView(
            UUID id,
            UUID meetingId,
            int seq,
            String title,
            String text,
            /** ORDINARY · SPECIAL. */
            String type,
            /** DRAFT · OPEN · CLOSED. */
            String status,
            boolean open,
            /** The majority this motion needs, for display beside the result. */
            double requiredMajorityPercent,
            boolean liveResultsVisible,
            Instant openedAt,
            Instant closedAt,
            /** How this caller voted, or null if they have not. */
            String myChoice,
            /** Null when the caller may not see the tally yet — see the class note. */
            TallyView result) {

        public static ResolutionView of(Resolution r, VoteChoice myChoice, TallyView result) {
            return new ResolutionView(
                    r.getId(), r.getMeetingId(), r.getSeq(), r.getTitle(), r.getText(),
                    r.getType().name(), r.getStatus().name(), r.isOpen(),
                    r.getType().requiredMajorityPercent(), r.isLiveResultsVisible(),
                    r.getOpenedAt(), r.getClosedAt(),
                    myChoice == null ? null : myChoice.name(), result);
        }
    }

    /**
     * A tally.
     *
     * <p>Carries headcounts and weights separately because an AGM reports both, and with weighted
     * voting they are rarely the same number — "eleven members, holding 62% of the shares" is two
     * facts, not one.
     */
    public record TallyView(
            long forCount, long againstCount, long abstainCount,
            long forWeight, long againstWeight, long abstainWeight,
            /** For + against. Abstentions are excluded from the majority. */
            long decisiveWeight,
            double forPercent,
            boolean carried) {

        public static TallyView of(Tally t) {
            return new TallyView(
                    t.forCount(), t.againstCount(), t.abstainCount(),
                    t.forWeight(), t.againstWeight(), t.abstainWeight(),
                    t.decisiveWeight(), t.forPercent(), t.carried());
        }
    }

    /** Whether enough of the register is taking part for business to be valid. */
    public record QuorumView(
            long representedWeight,
            long totalWeight,
            double representedPercent,
            double thresholdPercent,
            boolean met) {

        public static QuorumView of(Quorum q) {
            return new QuorumView(q.represented(), q.total(), q.representedPercent(),
                                  q.thresholdPercent(), q.met());
        }
    }
}
