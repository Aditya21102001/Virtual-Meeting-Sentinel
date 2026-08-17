package com.agmsentinel.service;

import com.agmsentinel.model.VideoWatch;
import com.agmsentinel.repository.VideoWatchRepository;
import com.agmsentinel.security.Feature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Who watched what, how far they got, and how many watched at all.
 *
 * <p>One class for both because they are one row: the count of distinct viewers and a member's
 * resume position are two readings of the same fact, and splitting them would mean writing twice on
 * every progress report.
 */
@Service
public class VideoWatchService {

    private static final Logger log = LoggerFactory.getLogger(VideoWatchService.class);

    /**
     * A gap longer than this counts as a new sitting rather than continued watching.
     *
     * <p>Thirty minutes, so pausing to take a call does not inflate the number while coming back the
     * next morning does. Without a rule like this every seek would look like a fresh view, because
     * progress is reported continuously.
     */
    private static final Duration NEW_SITTING_AFTER = Duration.ofMinutes(30);

    /** Below this, "resume" is not worth offering — see the repository query. */
    private static final double MIN_RESUME_SECONDS = 15;

    /** Watched this close to the end counts as finished; nobody sits through the last few seconds. */
    private static final double COMPLETE_WITHIN_SECONDS = 20;

    /** Enough to fill a "Continue watching" row without turning it into a second library. */
    private static final int CONTINUE_LIMIT = 12;

    private final VideoWatchRepository watches;
    private final FeatureService features;

    public VideoWatchService(VideoWatchRepository watches, FeatureService features) {
        this.watches = watches;
        this.features = features;
    }

    /**
     * Record progress. Called as playback proceeds, so it must be cheap and idempotent.
     *
     * <p>Silently ignores anonymous viewers rather than refusing: playback works without signing in
     * and must keep working, it simply is not attributable to anyone.
     */
    @Transactional
    public void report(UUID videoId, String username, double positionSeconds, Double durationSeconds) {
        // The write this flag exists to control — see Feature.VIDEO_WATCH_TRACKING for the sums.
        if (!features.isEnabled(Feature.VIDEO_WATCH_TRACKING)) return;
        if (username == null || username.isBlank() || "anonymous".equals(username)) return;

        boolean completed = durationSeconds != null && durationSeconds > 0
                && positionSeconds >= durationSeconds - COMPLETE_WITHIN_SECONDS;

        watches.findByVideoIdAndUsername(videoId, username).ifPresentOrElse(
                existing -> {
                    boolean newSitting = existing.getLastSeenAt()
                            .isBefore(Instant.now().minus(NEW_SITTING_AFTER));
                    existing.touch(positionSeconds, completed, newSitting);
                    watches.save(existing);
                },
                () -> {
                    VideoWatch fresh = new VideoWatch(videoId, username);
                    fresh.touch(positionSeconds, completed, false);
                    watches.save(fresh);
                    log.debug("First view of {} by {}.", videoId, username);
                });
    }

    /** Distinct viewers for a page of recordings, in one query. Missing ids mean nobody watched. */
    @Transactional(readOnly = true)
    public Map<UUID, Long> viewerCounts(Collection<UUID> videoIds) {
        if (videoIds.isEmpty() || !features.isEnabled(Feature.VIDEO_WATCH_TRACKING)) return Map.of();
        Map<UUID, Long> counts = new HashMap<>();
        for (Object[] row : watches.viewerCountsByVideo(videoIds)) {
            counts.put((UUID) row[0], ((Number) row[1]).longValue());
        }
        return counts;
    }

    /** Where this member stopped, or 0 if they have not watched it. */
    @Transactional(readOnly = true)
    public double resumePosition(UUID videoId, String username) {
        if (username == null || username.isBlank()) return 0;
        if (!features.isEnabled(Feature.VIDEO_WATCH_TRACKING)) return 0;
        return watches.findByVideoIdAndUsername(videoId, username)
                .filter(w -> !w.isCompleted())
                .map(VideoWatch::getPositionSeconds)
                .orElse(0.0);
    }

    /** Unfinished recordings for this member, most recently watched first. */
    @Transactional(readOnly = true)
    public List<VideoWatch> continueWatching(String username) {
        if (username == null || username.isBlank()) return List.of();
        if (!features.isEnabled(Feature.VIDEO_WATCH_TRACKING)) return List.of();
        return watches.continueWatching(username, MIN_RESUME_SECONDS,
                                        PageRequest.of(0, CONTINUE_LIMIT));
    }

    @Transactional
    public void deleteFor(UUID videoId) {
        watches.deleteByVideoId(videoId);
    }
}
