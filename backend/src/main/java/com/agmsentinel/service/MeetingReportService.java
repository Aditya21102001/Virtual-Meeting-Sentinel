package com.agmsentinel.service;

import com.agmsentinel.model.ClusterDraft;
import com.agmsentinel.model.Meeting;
import com.agmsentinel.model.Resolution;
import com.agmsentinel.repository.ClusterDraftRepository;
import com.agmsentinel.repository.QuestionRepository;
import com.agmsentinel.service.VotingService.Quorum;
import com.agmsentinel.service.VotingService.Tally;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Assembles what happened at a meeting into something a person can file.
 *
 * <h2>Why this exists</h2>
 * A meeting produces a record whether or not the software helps: what was asked, what was answered,
 * what was decided. Somebody was going to reconstruct that afterwards from the board and a notepad.
 * Everything needed is already stored, so reconstructing it by hand is work the application was
 * making people do for no reason.
 *
 * <h2>Honesty about coverage</h2>
 * Two limits are reported rather than hidden, because a minute that quietly omits things is worse
 * than no minute at all:
 *
 * <ul>
 *   <li><b>Unattributed questions.</b> Questions asked before the application recorded which meeting
 *       they belonged to carry no meeting, and always will. They are counted and disclosed rather
 *       than folded in — attributing them here would credit this meeting with another's questions.
 *   <li><b>Unanswered clusters.</b> Anything nobody answered appears in its own section, prominently.
 *       That is the part of a report people actually need, and it is the part most easily lost.
 * </ul>
 */
@Service
public class MeetingReportService {

    private final MeetingService meetings;
    private final VotingService voting;
    private final QuestionRepository questions;
    private final ClusterDraftRepository drafts;

    public MeetingReportService(MeetingService meetings, VotingService voting,
                                QuestionRepository questions, ClusterDraftRepository drafts) {
        this.meetings = meetings;
        this.voting = voting;
        this.questions = questions;
        this.drafts = drafts;
    }

    /** One motion and how it went. */
    public record ResolutionOutcome(UUID id, int seq, String title, String text, String type,
                                    String status, double requiredMajorityPercent,
                                    long forWeight, long againstWeight, long abstainWeight,
                                    long forCount, long againstCount, long abstainCount,
                                    double forPercent, boolean carried,
                                    Instant openedAt, Instant closedAt) { }

    /**
     * One topic raised, and the answer given.
     *
     * <p>{@code askedHere} is this meeting's share of the cluster, not the cluster's global size —
     * a topic carried over from a previous meeting must not inflate this meeting's numbers.
     */
    public record TopicOutcome(UUID clusterId, String question, long askedHere, double weightHere,
                               String answer, String answeredBy, String status,
                               boolean answered) { }

    /** Everything about one meeting, in the order a minute would set it out. */
    public record MeetingReport(UUID meetingId, String title, String description,
                                String status, Instant scheduledAt, Instant activatedAt,
                                Instant closedAt,
                                long memberCount, long totalVotingWeight,
                                QuorumSummary quorum,
                                List<ResolutionOutcome> resolutions,
                                List<TopicOutcome> answeredTopics,
                                List<TopicOutcome> unansweredTopics,
                                long questionsAsked,
                                long questionsNotAttributedToAnyMeeting,
                                Instant generatedAt) { }

    public record QuorumSummary(long representedWeight, long totalWeight, double representedPercent,
                                double thresholdPercent, boolean met) { }

    /**
     * Build the report.
     *
     * <p>Read-only and assembled on demand rather than stored. A meeting's record is derived from
     * rows that are themselves the source of truth, so a saved copy would only be one more thing
     * that could disagree with them.
     */
    @Transactional(readOnly = true)
    public MeetingReport build(UUID meetingId) {
        Meeting meeting = meetings.get(meetingId);

        List<Resolution> agenda = voting.agenda(meetingId);
        Map<UUID, Tally> tallies = voting.tallies(agenda);
        List<ResolutionOutcome> outcomes = agenda.stream()
                .map(r -> toOutcome(r, tallies.get(r.getId())))
                .toList();

        Quorum quorum = voting.quorum(meetingId);

        List<TopicOutcome> answered = new ArrayList<>();
        List<TopicOutcome> unanswered = new ArrayList<>();
        for (Object[] row : questions.clusterTotalsForMeeting(meetingId)) {
            UUID clusterId = (UUID) row[0];
            long asked = ((Number) row[1]).longValue();
            double weight = row[2] == null ? 0 : ((Number) row[2]).doubleValue();

            ClusterDraft draft = drafts.findById(clusterId).orElse(null);
            if (draft == null) {
                // The cluster row is gone — merged away, or the board was rebuilt. The questions
                // still happened, so the topic is reported as unanswered rather than dropped.
                unanswered.add(new TopicOutcome(clusterId, "(question group no longer on the board)",
                        asked, weight, null, null, "UNKNOWN", false));
                continue;
            }

            boolean hasAnswer = draft.getDraftAnswer() != null && !draft.getDraftAnswer().isBlank();
            TopicOutcome topic = new TopicOutcome(clusterId, draft.getRepresentativeQuestion(),
                    asked, weight, draft.getDraftAnswer(), draft.getAnsweredBy(),
                    draft.getStatus().name(), hasAnswer);
            (hasAnswer ? answered : unanswered).add(topic);
        }

        // Most-asked first in both lists: that is the order they mattered in, and for the unanswered
        // list it is also the order they should be chased in.
        Comparator<TopicOutcome> byDemand = Comparator
                .comparingDouble(TopicOutcome::weightHere).reversed()
                .thenComparing(Comparator.comparingLong(TopicOutcome::askedHere).reversed());
        answered.sort(byDemand);
        unanswered.sort(byDemand);

        return new MeetingReport(
                meeting.getId(), meeting.getTitle(), meeting.getDescription(),
                meeting.getStatus().name(), meeting.getScheduledAt(), meeting.getActivatedAt(),
                meeting.getClosedAt(),
                meetings.memberCounts(List.of(meeting)).getOrDefault(meeting.getId(), 0L),
                meetings.totalVotingWeight(meetingId),
                new QuorumSummary(quorum.represented(), quorum.total(), quorum.representedPercent(),
                                  quorum.thresholdPercent(), quorum.met()),
                outcomes, answered, unanswered,
                questions.countByMeetingId(meetingId),
                questions.countUnattributed(),
                Instant.now());
    }

    private ResolutionOutcome toOutcome(Resolution r, Tally t) {
        return new ResolutionOutcome(
                r.getId(), r.getSeq(), r.getTitle(), r.getText(), r.getType().name(),
                r.getStatus().name(), r.getType().requiredMajorityPercent(),
                t.forWeight(), t.againstWeight(), t.abstainWeight(),
                t.forCount(), t.againstCount(), t.abstainCount(),
                t.forPercent(), t.carried(),
                r.getOpenedAt(), r.getClosedAt());
    }

    /**
     * The same report as Markdown, for pasting into minutes or saving as a file.
     *
     * <p>Markdown rather than PDF: it reads perfectly well as plain text, pastes into every
     * document editor with its structure intact, and needs no rendering library on a container that
     * is already short of memory. Somebody who wants a PDF can print it.
     */
    public String toMarkdown(MeetingReport r) {
        StringBuilder md = new StringBuilder();
        md.append("# ").append(r.title()).append("\n\n");
        if (r.description() != null && !r.description().isBlank()) {
            md.append(r.description()).append("\n\n");
        }

        md.append("**Status:** ").append(r.status()).append("  \n");
        if (r.activatedAt() != null) md.append("**Opened:** ").append(r.activatedAt()).append("  \n");
        if (r.closedAt() != null) md.append("**Closed:** ").append(r.closedAt()).append("  \n");
        md.append("**Members:** ").append(r.memberCount())
          .append(" holding ").append(r.totalVotingWeight()).append(" votes  \n");

        QuorumSummary q = r.quorum();
        md.append("**Quorum:** ").append(q.met() ? "met" : "NOT MET")
          .append(" — ").append(q.representedWeight()).append(" of ").append(q.totalWeight())
          .append(" votes represented (")
          .append(String.format("%.1f", q.representedPercent())).append("%, threshold ")
          .append(String.format("%.1f", q.thresholdPercent())).append("%)\n\n");

        if (!q.met()) {
            // Stated plainly rather than left for the reader to infer from two percentages. If
            // quorum was not met, every decision below is in question, and that is the single most
            // important sentence in the document.
            md.append("> Quorum was not met. Business transacted at this meeting may not be valid.\n\n");
        }

        md.append("## Resolutions\n\n");
        if (r.resolutions().isEmpty()) {
            md.append("_No resolutions were put to this meeting._\n\n");
        } else {
            for (ResolutionOutcome o : r.resolutions()) {
                md.append("### ").append(o.seq()).append(". ").append(o.title()).append("\n\n");
                if (o.text() != null && !o.text().isBlank()) {
                    md.append("> ").append(o.text().replace("\n", "\n> ")).append("\n\n");
                }
                md.append("- Type: ").append(o.type())
                  .append(" (needs ").append(String.format("%.0f", o.requiredMajorityPercent()))
                  .append("%)\n");
                md.append("- For: ").append(o.forWeight()).append(" votes (")
                  .append(o.forCount()).append(" members)\n");
                md.append("- Against: ").append(o.againstWeight()).append(" votes (")
                  .append(o.againstCount()).append(" members)\n");
                md.append("- Abstained: ").append(o.abstainWeight()).append(" votes (")
                  .append(o.abstainCount()).append(" members)\n");

                if ("CLOSED".equals(o.status())) {
                    md.append("- **Result: ").append(o.carried() ? "CARRIED" : "NOT CARRIED")
                      .append("** (").append(String.format("%.1f", o.forPercent()))
                      .append("% in favour of votes cast)\n");
                } else {
                    md.append("- Result: not yet decided — voting is ")
                      .append("OPEN".equals(o.status()) ? "still open" : "not yet open").append("\n");
                }
                md.append("\n");
            }
        }

        md.append("## Questions answered\n\n");
        if (r.answeredTopics().isEmpty()) {
            md.append("_None recorded._\n\n");
        } else {
            for (TopicOutcome t : r.answeredTopics()) {
                md.append("### ").append(t.question()).append("\n\n");
                md.append("_Asked by ").append(t.askedHere())
                  .append(t.askedHere() == 1 ? " person" : " people");
                if (t.answeredBy() != null) md.append(", answered by ").append(t.answeredBy());
                md.append("._\n\n").append(t.answer()).append("\n\n");
            }
        }

        md.append("## Questions left unanswered\n\n");
        if (r.unansweredTopics().isEmpty()) {
            md.append("_None — everything raised was answered._\n\n");
        } else {
            md.append("These were raised but not answered. Most-asked first.\n\n");
            for (TopicOutcome t : r.unansweredTopics()) {
                md.append("- **").append(t.question()).append("** — asked by ")
                  .append(t.askedHere()).append(t.askedHere() == 1 ? " person" : " people")
                  .append("\n");
            }
            md.append("\n");
        }

        md.append("---\n\n");
        md.append("_").append(r.questionsAsked()).append(" questions recorded for this meeting.");
        if (r.questionsNotAttributedToAnyMeeting() > 0) {
            md.append(" A further ").append(r.questionsNotAttributedToAnyMeeting())
              .append(" questions in the system predate per-meeting recording and are not counted "
                      + "here or against any other meeting.");
        }
        md.append(" Generated ").append(r.generatedAt()).append("._\n");
        return md.toString();
    }
}
