package com.agmsentinel.service;

import com.agmsentinel.model.VideoWatch;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * How a watch row moves.
 *
 * <h2>Why this tests the entity rather than the service</h2>
 * The rules that decide what a view count means live in {@link VideoWatch#touch} — latching
 * completion, moving the position, counting a sitting. The service around it is repository
 * plumbing and a clock comparison; stubbing a repository to re-assert the same three lines would
 * test the stub. What matters is that "finished" cannot be un-finished and that a re-watch does
 * not silently reset progress, and both are decided here.
 */
class VideoWatchServiceTest {

    private VideoWatch watch() {
        return new VideoWatch(UUID.randomUUID(), "yash");
    }

    @Test
    @DisplayName("a first view counts once, not twice")
    void firstViewCountsOnce() {
        VideoWatch w = watch();

        w.touch(30, false, false);

        assertThat(w.getViewCount())
                .as("the row is created for the first view; touch must not add a second")
                .isEqualTo(1);
        assertThat(w.getPositionSeconds()).isEqualTo(30);
    }

    @Test
    @DisplayName("continued watching moves the position without counting a new view")
    void continuedWatchingDoesNotInflateTheCount() {
        VideoWatch w = watch();

        w.touch(30, false, false);
        w.touch(90, false, false);
        w.touch(150, false, false);

        assertThat(w.getViewCount())
                .as("progress is reported continuously; each report is not a view")
                .isEqualTo(1);
        assertThat(w.getPositionSeconds()).isEqualTo(150);
    }

    @Test
    @DisplayName("a new sitting counts another view")
    void newSittingCounts() {
        VideoWatch w = watch();

        w.touch(30, false, false);
        w.touch(45, false, true);

        assertThat(w.getViewCount()).isEqualTo(2);
    }

    @Test
    @DisplayName("having finished once is never undone by watching part of it again")
    void completionLatches() {
        VideoWatch w = watch();

        w.touch(3600, true, false);
        assertThat(w.isCompleted()).isTrue();

        // Re-opened later and stopped ten minutes in.
        w.touch(600, false, true);

        assertThat(w.isCompleted())
                .as("assigning rather than latching would make a re-watch erase the fact")
                .isTrue();
        assertThat(w.getPositionSeconds())
                .as("the position still follows them, so resume works on the second pass")
                .isEqualTo(600);
    }

    @Test
    @DisplayName("a negative position is clamped rather than stored")
    void negativePositionIsClamped() {
        VideoWatch w = watch();

        w.touch(-5, false, false);

        assertThat(w.getPositionSeconds()).isZero();
    }

    @Test
    @DisplayName("lastSeenAt advances but firstSeenAt does not")
    void timestampsMoveIndependently() throws InterruptedException {
        VideoWatch w = watch();
        var firstSeen = w.getFirstSeenAt();
        var before = w.getLastSeenAt();
        Thread.sleep(5);

        w.touch(10, false, false);

        assertThat(w.getFirstSeenAt())
                .as("first view is a fact about the past and must not move")
                .isEqualTo(firstSeen);
        assertThat(w.getLastSeenAt())
                .as("drives Continue watching ordering, so it has to advance")
                .isAfterOrEqualTo(before);
    }
}
