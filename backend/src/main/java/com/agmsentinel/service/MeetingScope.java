package com.agmsentinel.service;

import com.agmsentinel.model.Meeting;
import com.agmsentinel.security.Feature;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Optional;
import java.util.UUID;

/**
 * Decides whether the board should show one meeting's questions or all of them.
 *
 * <h2>Why this is one class rather than a check in each caller</h2>
 * Scoping has to be all-or-nothing. A board filtered to the active meeting while the "awaiting
 * answers" list is not would show a moderator a to-do item they cannot find on the board — two
 * screens disagreeing about what exists, which is worse than either behaviour on its own. Every
 * caller asks here, so they cannot drift apart.
 *
 * <h2>The safety property</h2>
 * Scoping applies only when <b>both</b> are true:
 *
 * <ol>
 *   <li>the MEETINGS feature is switched on, and
 *   <li>a meeting is actually active.
 * </ol>
 *
 * <p>Otherwise this returns empty and every caller behaves exactly as it did before meetings
 * existed — global, unfiltered. That is what makes deploying this safe: the flag ships off, so
 * nothing changes until an administrator turns it on, and turning it off again restores the old
 * behaviour immediately rather than leaving the board stuck on one meeting.
 *
 * <p>The second condition matters as much as the first. With MEETINGS on but every meeting closed,
 * scoping to "the active meeting" would scope to nothing and blank the board. Falling back to
 * unscoped is the honest answer: there is no meeting to filter by, so filtering by one is not
 * something we can do.
 */
@Service
public class MeetingScope {

    private final MeetingService meetings;
    private final FeatureService features;

    public MeetingScope(MeetingService meetings, FeatureService features) {
        this.meetings = meetings;
        this.features = features;
    }

    /**
     * The meeting to filter by, or empty to show everything.
     *
     * <p>Empty is not an error and not "no results" — it means "do not filter". Callers must treat
     * it as the unscoped path, never as a meeting id that matches nothing.
     */
    @Transactional(readOnly = true)
    public Optional<UUID> activeMeetingId() {
        if (!features.isEnabled(Feature.MEETINGS)) return Optional.empty();
        return meetings.active().map(Meeting::getId);
    }

    /** True when the board and its lists should be filtered. */
    public boolean isScoped() {
        return activeMeetingId().isPresent();
    }
}
