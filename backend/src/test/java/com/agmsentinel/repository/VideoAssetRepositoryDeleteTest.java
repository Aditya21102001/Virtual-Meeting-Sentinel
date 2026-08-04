package com.agmsentinel.repository;

import com.agmsentinel.model.VideoAsset;
import jakarta.persistence.EntityManager;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.test.context.TestPropertySource;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Deleting a video's stored media must cost the same whether it holds one segment or a thousand.
 *
 * <p>Guarding against a specific regression rather than a hypothetical one. These two methods were
 * once Spring Data derived deletes, which are not {@code delete} statements at all: they select the
 * matching entities and remove them one by one. Because {@link VideoAsset} holds its payload in a
 * non-lazy {@code byte[]}, deleting a fifty-megabyte recording pulled all fifty megabytes into heap
 * — as entities, again as Hibernate's dirty-checking snapshots, and again in the driver's buffered
 * result set. On a container with a 123 MB heap ceiling that killed the process mid-request, which
 * the proxy in front of it reported as an unexplained 502.
 *
 * <p>So the assertion that matters is not "the rows are gone" — a derived delete passes that too —
 * but that no row was ever loaded. Hibernate's entity-load counter states exactly that, and it is
 * the one thing a future refactor back to a derived delete cannot quietly satisfy.
 *
 * <p>H2 in PostgreSQL compatibility mode, matching the {@code local} profile: the payload column is
 * declared {@code bytea}, which plain H2 does not accept.
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:video-asset-delete;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "spring.jpa.properties.hibernate.generate_statistics=true",
})
class VideoAssetRepositoryDeleteTest {

    @Autowired
    private VideoAssetRepository assets;

    @Autowired
    private EntityManager em;

    @Test
    void deletingEveryAssetOfAVideoLoadsNothing() {
        UUID video = UUID.randomUUID();
        store(video, "source.mp4", "hls/480p/seg_00000.ts", "hls/480p/seg_00001.ts", "poster.jpg");

        Statistics stats = freshStatistics();
        assets.deleteByVideoId(video);
        em.flush();

        assertThat(stats.getEntityLoadCount())
                .as("a bulk delete must not pull VideoAsset payloads into heap")
                .isZero();
        assertThat(assets.findPaths(video)).isEmpty();
    }

    @Test
    void deletingTheTranscodeOutputKeepsTheOriginalAndLoadsNothing() {
        UUID video = UUID.randomUUID();
        store(video, "source.mp4", "poster.jpg", "hls/master.m3u8", "hls/480p/seg_00000.ts");

        Statistics stats = freshStatistics();
        assets.deleteByVideoIdAndRelPathStartingWith(video, "hls/");
        em.flush();

        assertThat(stats.getEntityLoadCount())
                .as("a bulk prefix delete must not pull VideoAsset payloads into heap")
                .isZero();
        // Re-processing rebuilds the ladder from the original, so the original has to survive.
        assertThat(assets.findPaths(video)).containsExactly("poster.jpg", "source.mp4");
    }

    @Test
    void deletingOneVideoLeavesTheRestOfTheLibraryAlone() {
        UUID doomed = UUID.randomUUID();
        UUID keeper = UUID.randomUUID();
        store(doomed, "source.mp4", "hls/480p/seg_00000.ts");
        store(keeper, "source.mp4", "hls/480p/seg_00000.ts");

        assets.deleteByVideoId(doomed);
        em.flush();

        assertThat(assets.findPaths(doomed)).isEmpty();
        assertThat(assets.findPaths(keeper))
                .containsExactly("hls/480p/seg_00000.ts", "source.mp4");
    }

    /** Write assets, then detach them, so a load during the delete is a load and not a cache hit. */
    private void store(UUID video, String... relPaths) {
        for (String relPath : relPaths) {
            assets.save(new VideoAsset(video, relPath, "video/mp2t", new byte[] {1, 2, 3, 4}));
        }
        em.flush();
        em.clear();
    }

    private Statistics freshStatistics() {
        Statistics stats = em.getEntityManagerFactory()
                             .unwrap(SessionFactory.class)
                             .getStatistics();
        stats.clear();
        return stats;
    }
}
