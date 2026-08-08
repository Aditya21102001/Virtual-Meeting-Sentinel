package com.agmsentinel.service;

import com.agmsentinel.model.Meeting;
import com.agmsentinel.repository.ClusterDraftRepository;
import com.agmsentinel.repository.QuestionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * Adopts questions and topics that belong to no meeting.
 *
 * <h2>The problem this exists to prevent</h2>
 * Every question and topic recorded before meetings existed carries no {@code meeting_id}. Switch on
 * per-meeting filtering without dealing with them and <b>the board goes blank</b> — everything ever
 * asked becomes invisible, because none of it matches the meeting being filtered by.
 *
 * <p>That is a genuinely alarming thing to discover in production, and the fix afterwards is the
 * same as the fix beforehand. So it is offered as an explicit step: count what is unattributed, pick
 * the meeting it belongs to, adopt it.
 *
 * <h2>Why adopt rather than treat null as "visible everywhere"</h2>
 * The alternative is to make every query say "this meeting, or no meeting at all". That needs no
 * migration, but the ambiguity is permanent: every future query has to remember the extra clause,
 * and forgetting it is a silent bug. Adopting once leaves the data unambiguous and the queries
 * simple.
 *
 * <h2>What it will not do</h2>
 * It only ever claims rows with no meeting. It cannot move anything from one meeting to another, so
 * running it twice is harmless and running it against the wrong meeting costs one more run against
 * the right one — not a restore from backup.
 */
@Service
public class MeetingBackfillService {

    private static final Logger log = LoggerFactory.getLogger(MeetingBackfillService.class);

    private final QuestionRepository questions;
    private final ClusterDraftRepository drafts;
    private final MeetingService meetings;

    public MeetingBackfillService(QuestionRepository questions, ClusterDraftRepository drafts,
                                  MeetingService meetings) {
        this.questions = questions;
        this.drafts = drafts;
        this.meetings = meetings;
    }

    /** How much belongs to no meeting, so an administrator can see the size before acting. */
    public record Unattributed(long questions, long topics) {
        public boolean any() {
            return questions > 0 || topics > 0;
        }
    }

    /** What a backfill actually moved. */
    public record BackfillResult(UUID meetingId, String meetingTitle,
                                 int questionsAdopted, int topicsAdopted) { }

    @Transactional(readOnly = true)
    public Unattributed count() {
        return new Unattributed(questions.countUnattributed(), drafts.countUnattributed());
    }

    /**
     * Adopt everything unattributed into one meeting.
     *
     * <p>Questions and topics move together in one transaction. Half a backfill is worse than none:
     * questions counted against a meeting whose topics are still orphaned would give a report that
     * silently disagrees with the board it came from.
     */
    @Transactional
    public BackfillResult adoptInto(UUID meetingId) {
        Meeting meeting = meetings.get(meetingId);   // 404 rather than stamping a meeting that is gone

        int adoptedQuestions = questions.adoptUnattributed(meetingId);
        int adoptedTopics = drafts.adoptUnattributed(meetingId);

        log.warn("Backfill: {} questions and {} topics adopted into meeting {} (\"{}\").",
                 adoptedQuestions, adoptedTopics, meetingId, meeting.getTitle());
        return new BackfillResult(meetingId, meeting.getTitle(), adoptedQuestions, adoptedTopics);
    }
}
