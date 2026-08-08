package com.agmsentinel.service;

import com.agmsentinel.model.Meeting;
import com.agmsentinel.security.Feature;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Tests for the decision that controls whether the board filters to one meeting.
 *
 * <h2>Why this one matters more than it looks</h2>
 * Getting it wrong in the permissive direction shows a moderator another meeting's questions.
 * Getting it wrong in the restrictive direction is worse: the board filters to a meeting nothing
 * matches, and <b>every question ever asked disappears at once</b>. That is indistinguishable from
 * total data loss to whoever is looking at it, in the middle of a live meeting.
 *
 * <p>So the rule is deliberately conservative — filter only when there is genuinely something to
 * filter by — and these tests pin each way it can be reached.
 */
class MeetingScopeTest {

    private final MeetingService meetings = mock(MeetingService.class);
    private final FeatureService features = mock(FeatureService.class);
    private final MeetingScope scope = new MeetingScope(meetings, features);

    private Meeting activeMeeting(UUID id) {
        Meeting meeting = mock(Meeting.class);
        when(meeting.getId()).thenReturn(id);
        return meeting;
    }

    @Test
    @DisplayName("does not scope when the MEETINGS feature is off")
    void featureOffMeansUnscoped() {
        // The whole safety property of shipping this: the flag defaults off, so deploying it
        // changes nothing until somebody deliberately turns it on.
        when(features.isEnabled(Feature.MEETINGS)).thenReturn(false);

        assertTrue(scope.activeMeetingId().isEmpty());
        assertFalse(scope.isScoped());
    }

    @Test
    @DisplayName("does not scope when the feature is on but no meeting is active")
    void noActiveMeetingMeansUnscoped() {
        // The case that would blank the board. With every meeting closed there is no meeting to
        // filter by, so filtering by "the active meeting" would filter by nothing and match nothing.
        when(features.isEnabled(Feature.MEETINGS)).thenReturn(true);
        when(meetings.active()).thenReturn(Optional.empty());

        assertTrue(scope.activeMeetingId().isEmpty(),
                "with no meeting active the board must stay unfiltered, not filter to nothing");
        assertFalse(scope.isScoped());
    }

    @Test
    @DisplayName("scopes to the active meeting when the feature is on and one is live")
    void featureOnAndMeetingActiveMeansScoped() {
        UUID id = UUID.randomUUID();
        // Built BEFORE the when(...) below, not inline inside it. Stubbing the meeting while
        // when(meetings.active()) is still waiting for its thenReturn is nested stubbing, and
        // Mockito rejects it with UnfinishedStubbing — which reads like a failure of the code
        // under test rather than of the test.
        Meeting meeting = activeMeeting(id);

        when(features.isEnabled(Feature.MEETINGS)).thenReturn(true);
        when(meetings.active()).thenReturn(Optional.of(meeting));

        assertEquals(Optional.of(id), scope.activeMeetingId());
        assertTrue(scope.isScoped());
    }

    @Test
    @DisplayName("the feature flag is checked before the meeting is looked up")
    void flagShortCircuits() {
        // Not a micro-optimisation. Turning the flag off must restore the previous behaviour
        // immediately and unconditionally — if the meeting lookup ran first and threw, a deployment
        // with the flag off would start failing on a code path it had opted out of.
        when(features.isEnabled(Feature.MEETINGS)).thenReturn(false);
        when(meetings.active()).thenThrow(new IllegalStateException(
                "must not be consulted when the feature is off"));

        assertTrue(scope.activeMeetingId().isEmpty());
    }
}
