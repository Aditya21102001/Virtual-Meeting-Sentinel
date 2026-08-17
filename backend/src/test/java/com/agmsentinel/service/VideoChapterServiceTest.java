package com.agmsentinel.service;

import com.agmsentinel.dto.VideoDtos.ChapterInput;
import com.agmsentinel.dto.VideoDtos.ChapterView;
import com.agmsentinel.model.VideoChapter;
import com.agmsentinel.repository.VideoChapterRepository;
import com.agmsentinel.security.Feature;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Saving an agenda.
 *
 * <h2>Why this is worth testing without Spring</h2>
 * The rules here are the ones a moderator hits: rows typed in the wrong order, a title left blank,
 * two items on the same second. Every one of them is a decision made in plain Java before anything
 * touches the database, so they are asserted against a hand-written repository rather than a Spring
 * context — the backend's tests do not load one, so a @SpringBootTest here would prove nothing and
 * cost seconds.
 */
class VideoChapterServiceTest {

    /** Minimal in-memory stand-in: only the four methods the service actually calls. */
    private static class FakeRepo implements VideoChapterRepository {
        final List<VideoChapter> rows = new ArrayList<>();

        @Override public List<VideoChapter> findByVideoIdOrderByStartSecondsAsc(UUID videoId) {
            return rows.stream().filter(c -> c.getVideoId().equals(videoId))
                    .sorted(java.util.Comparator.comparingDouble(VideoChapter::getStartSeconds))
                    .toList();
        }
        @Override public List<VideoChapter> findByVideoIdInOrderByStartSecondsAsc(
                Collection<UUID> videoIds) {
            return rows.stream().filter(c -> videoIds.contains(c.getVideoId()))
                    .sorted(java.util.Comparator.comparingDouble(VideoChapter::getStartSeconds))
                    .toList();
        }
        @Override public void deleteByVideoId(UUID videoId) {
            rows.removeIf(c -> c.getVideoId().equals(videoId));
        }
        @Override public <S extends VideoChapter> List<S> saveAll(Iterable<S> entities) {
            List<S> saved = new ArrayList<>();
            entities.forEach(e -> { rows.add(e); saved.add(e); });
            return saved;
        }

        // ---- unused JpaRepository surface ------------------------------------
        @Override public void flush() { }
        @Override public <S extends VideoChapter> S saveAndFlush(S entity) { throw new UnsupportedOperationException(); }
        @Override public <S extends VideoChapter> List<S> saveAllAndFlush(Iterable<S> entities) { throw new UnsupportedOperationException(); }
        @Override public void deleteAllInBatch(Iterable<VideoChapter> entities) { }
        @Override public void deleteAllByIdInBatch(Iterable<UUID> uuids) { }
        @Override public void deleteAllInBatch() { }
        @Override public VideoChapter getOne(UUID uuid) { throw new UnsupportedOperationException(); }
        @Override public VideoChapter getById(UUID uuid) { throw new UnsupportedOperationException(); }
        @Override public VideoChapter getReferenceById(UUID uuid) { throw new UnsupportedOperationException(); }
        @Override public <S extends VideoChapter> List<S> findAll(org.springframework.data.domain.Example<S> example) { throw new UnsupportedOperationException(); }
        @Override public <S extends VideoChapter> List<S> findAll(org.springframework.data.domain.Example<S> example, org.springframework.data.domain.Sort sort) { throw new UnsupportedOperationException(); }
        @Override public <S extends VideoChapter> S save(S entity) { rows.add(entity); return entity; }
        @Override public java.util.Optional<VideoChapter> findById(UUID uuid) { return java.util.Optional.empty(); }
        @Override public boolean existsById(UUID uuid) { return false; }
        @Override public List<VideoChapter> findAll() { return List.copyOf(rows); }
        @Override public List<VideoChapter> findAllById(Iterable<UUID> uuids) { return List.of(); }
        @Override public long count() { return rows.size(); }
        @Override public void deleteById(UUID uuid) { }
        @Override public void delete(VideoChapter entity) { rows.remove(entity); }
        @Override public void deleteAllById(Iterable<? extends UUID> uuids) { }
        @Override public void deleteAll(Iterable<? extends VideoChapter> entities) { }
        @Override public void deleteAll() { rows.clear(); }
        @Override public List<VideoChapter> findAll(org.springframework.data.domain.Sort sort) { throw new UnsupportedOperationException(); }
        @Override public org.springframework.data.domain.Page<VideoChapter> findAll(org.springframework.data.domain.Pageable pageable) { throw new UnsupportedOperationException(); }
        @Override public <S extends VideoChapter> java.util.Optional<S> findOne(org.springframework.data.domain.Example<S> example) { throw new UnsupportedOperationException(); }
        @Override public <S extends VideoChapter> org.springframework.data.domain.Page<S> findAll(org.springframework.data.domain.Example<S> example, org.springframework.data.domain.Pageable pageable) { throw new UnsupportedOperationException(); }
        @Override public <S extends VideoChapter> long count(org.springframework.data.domain.Example<S> example) { return 0; }
        @Override public <S extends VideoChapter> boolean exists(org.springframework.data.domain.Example<S> example) { return false; }
        @Override public <S extends VideoChapter, R> R findBy(org.springframework.data.domain.Example<S> example, java.util.function.Function<org.springframework.data.repository.query.FluentQuery.FetchableFluentQuery<S>, R> queryFunction) { throw new UnsupportedOperationException(); }
    }

    private FakeRepo repo;
    private VideoChapterService service;
    private UUID video;
    /** Flipped per test, so the gate can be asserted rather than only satisfied. */
    private boolean featureOn;

    @BeforeEach
    void setUp() {
        repo = new FakeRepo();
        featureOn = true;
        // Mockito is on the classpath but a two-line anonymous subclass reads better here and does
        // not need the flag's whole resolution machinery stubbed.
        FeatureService features = new FeatureService(null) {
            @Override public boolean isEnabled(Feature feature) { return featureOn; }
        };
        service = new VideoChapterService(repo, features);
        video = UUID.randomUUID();
    }

    @Test
    @DisplayName("chapters submitted out of order come back in playing order, numbered from zero")
    void sortsAndNumbers() {
        // The order a moderator produces after inserting an item into the middle of the list.
        List<ChapterView> saved = service.replace(video, List.of(
                new ChapterInput(1865, "Item 2 — Auditor's report"),
                new ChapterInput(0, "Welcome & apologies"),
                new ChapterInput(760, "Item 1 — Minutes")));

        assertThat(saved).extracting(ChapterView::title)
                .containsExactly("Welcome & apologies", "Item 1 — Minutes", "Item 2 — Auditor's report");
        assertThat(saved).extracting(ChapterView::ordinal).containsExactly(0, 1, 2);
    }

    @Test
    @DisplayName("saving replaces the previous agenda rather than adding to it")
    void replacesWholesale() {
        service.replace(video, List.of(new ChapterInput(0, "First go"),
                                       new ChapterInput(60, "Second")));
        service.replace(video, List.of(new ChapterInput(0, "Rewritten")));

        assertThat(service.forVideo(video)).extracting(ChapterView::title)
                .as("the old rows must not survive; a diff was deliberately not implemented")
                .containsExactly("Rewritten");
    }

    @Test
    @DisplayName("an empty list clears the agenda")
    void emptyClears() {
        service.replace(video, List.of(new ChapterInput(0, "Only one")));
        service.replace(video, List.of());

        assertThat(service.forVideo(video)).isEmpty();
    }

    @Test
    @DisplayName("two chapters on the same second are refused")
    void rejectsDuplicateStart() {
        // They would render as one marker on top of another, so one of them is unreachable.
        assertThatThrownBy(() -> service.replace(video, List.of(
                new ChapterInput(600, "Item 1"),
                new ChapterInput(600, "Item 2"))))
                .hasMessageContaining("same time")
                .hasMessageContaining("10:00");
    }

    @Test
    @DisplayName("a blank title is refused, and names the moment")
    void rejectsBlankTitle() {
        assertThatThrownBy(() -> service.replace(video, List.of(new ChapterInput(3725, "   "))))
                .hasMessageContaining("1:02:05")
                .hasMessageContaining("no title");
    }

    @Test
    @DisplayName("a negative or non-finite start is refused")
    void rejectsImpossibleStart() {
        assertThatThrownBy(() -> service.replace(video, List.of(new ChapterInput(-5, "Before time"))))
                .hasMessageContaining("invalid start time");
        assertThatThrownBy(() -> service.replace(video, List.of(new ChapterInput(Double.NaN, "NaN"))))
                .hasMessageContaining("invalid start time");
    }

    @Test
    @DisplayName("titles are trimmed")
    void trimsTitles() {
        assertThat(service.replace(video, List.of(new ChapterInput(0, "  Item 1  "))))
                .extracting(ChapterView::title).containsExactly("Item 1");
    }

    @Test
    @DisplayName("more than MAX_CHAPTERS is refused rather than rendered")
    void rejectsTooMany() {
        List<ChapterInput> tooMany = new ArrayList<>();
        for (int i = 0; i <= VideoChapterService.MAX_CHAPTERS; i++) {
            tooMany.add(new ChapterInput(i, "Item " + i));
        }
        assertThatThrownBy(() -> service.replace(video, tooMany))
                .hasMessageContaining("at most " + VideoChapterService.MAX_CHAPTERS);
    }

    @Test
    @DisplayName("a rejected save leaves the previous agenda untouched")
    void rejectionDoesNotClobber() {
        // The order matters: validation runs over the whole set BEFORE the delete, so a bad row
        // cannot leave a recording with no chapters at all.
        service.replace(video, List.of(new ChapterInput(0, "Good")));

        assertThatThrownBy(() -> service.replace(video, List.of(
                new ChapterInput(0, "Fine"), new ChapterInput(0, "Clash"))))
                .isInstanceOf(RuntimeException.class);

        assertThat(service.forVideo(video)).extracting(ChapterView::title)
                .containsExactly("Good");
    }

    @Test
    @DisplayName("one video's agenda never leaks into another's")
    void scopedPerVideo() {
        UUID other = UUID.randomUUID();
        service.replace(video, List.of(new ChapterInput(0, "Mine")));
        service.replace(other, List.of(new ChapterInput(0, "Theirs")));

        assertThat(service.forVideo(video)).extracting(ChapterView::title).containsExactly("Mine");
        assertThat(service.forVideo(other)).extracting(ChapterView::title).containsExactly("Theirs");
    }

    @Test
    @DisplayName("deleteFor removes only that recording's agenda")
    void deleteForIsScoped() {
        UUID other = UUID.randomUUID();
        service.replace(video, List.of(new ChapterInput(0, "Mine")));
        service.replace(other, List.of(new ChapterInput(0, "Theirs")));

        service.deleteFor(video);

        assertThat(service.forVideo(video)).isEmpty();
        assertThat(service.forVideo(other)).hasSize(1);
    }

    @Test
    @DisplayName("times are formatted the way the player shows them")
    void formatsTime() {
        assertThat(VideoChapterService.formatTime(0)).isEqualTo("0:00");
        assertThat(VideoChapterService.formatTime(65)).isEqualTo("1:05");
        assertThat(VideoChapterService.formatTime(3725)).isEqualTo("1:02:05");
        // Guard rather than a crash: a negative should never arrive, and clamping beats an exception
        // inside an error message that is itself reporting a problem.
        assertThat(VideoChapterService.formatTime(-10)).isEqualTo("0:00");
    }

    // ---- the feature gate ---------------------------------------------------------

    @Test
    @DisplayName("with the feature off, enrich does not touch the database at all")
    void gateSkipsTheQueryEntirely() {
        // The whole point of the flag: a deployment with chapters off must cost the library page
        // nothing. Gating the response instead would still have added a query per page load to a
        // pool of five connections — which is the thing that would actually hurt production.
        service.replace(video, List.of(new ChapterInput(0, "Welcome")));
        featureOn = false;

        FakeRepo counting = new FakeRepo() {
            @Override public List<VideoChapter> findByVideoIdInOrderByStartSecondsAsc(
                    Collection<UUID> videoIds) {
                throw new AssertionError("the repository must not be reached when the flag is off");
            }
        };
        VideoChapterService gated = new VideoChapterService(counting, new FeatureService(null) {
            @Override public boolean isEnabled(Feature feature) { return false; }
        });

        List<com.agmsentinel.dto.VideoDtos.VideoCard> cards = List.of();
        assertThat(gated.enrich(cards)).isEmpty();
    }
}
