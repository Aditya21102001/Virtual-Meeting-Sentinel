package com.agmsentinel.service;

import com.agmsentinel.model.ClusterMerge;
import com.agmsentinel.repository.ClusterDraftRepository;
import com.agmsentinel.repository.ClusterMergeRepository;
import com.agmsentinel.repository.ClusterUpvoteRepository;
import com.agmsentinel.repository.QuestionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Tests for merge resolution — the lookup that every incoming question passes through.
 *
 * <p><b>Why this is worth testing on its own.</b> When a moderator merges one group of questions
 * into another, moving the existing rows is not enough: the clustering service still holds a
 * centroid for the group that was merged away, and will keep assigning new questions to it. So
 * every cluster id coming back from that service is put through {@code resolve} first. If this is
 * wrong, merges silently undo themselves and nobody notices until the board looks strange.
 *
 * <p>A hand-written fake repository rather than a mocking framework's stubbing, because the
 * behaviour under test <em>is</em> "follow the pointers", and a fake map makes the chains being
 * followed obvious in the test itself.
 */
class ClusterCurationServiceResolveTest {

    /** source -> target, the same shape the real table has. */
    private final Map<UUID, UUID> table = new HashMap<>();
    private ClusterCurationService curation;

    @BeforeEach
    void setUp() {
        ClusterMergeRepository merges = mock(ClusterMergeRepository.class);
        when(merges.findById(any())).thenAnswer(call -> {
            UUID source = call.getArgument(0);
            UUID target = table.get(source);
            return target == null
                    ? Optional.empty()
                    : Optional.of(new ClusterMerge(source, target, null, "test"));
        });

        // Only the merge repository matters here — resolve() touches nothing else, and mocks for
        // the rest keep that obvious.
        curation = new ClusterCurationService(
                mock(QuestionRepository.class), mock(ClusterDraftRepository.class), merges,
                mock(ClusterUpvoteRepository.class));
    }

    private UUID id() {
        return UUID.randomUUID();
    }

    @Test
    @DisplayName("a cluster that was never merged resolves to itself")
    void unmergedResolvesToItself() {
        UUID a = id();
        assertEquals(a, curation.resolve(a));
    }

    @Test
    @DisplayName("null resolves to null rather than throwing")
    void nullIsTolerated() {
        // Questions can carry no cluster at all — bulk ingest when the AI service was unreachable,
        // for one. That must not blow up the path every question travels.
        assertNull(curation.resolve(null));
    }

    @Test
    @DisplayName("a merged cluster resolves to its target")
    void singleHop() {
        UUID a = id(), b = id();
        table.put(a, b);   // a was merged into b
        assertEquals(b, curation.resolve(a));
    }

    @Test
    @DisplayName("a chain is followed to its end")
    void followsChain() {
        // Merging b into a, then a into c, leaves b -> a -> c. Somebody asking a question that the
        // clusterer would have filed under b has to end up in c.
        UUID a = id(), b = id(), c = id();
        table.put(b, a);
        table.put(a, c);
        assertEquals(c, curation.resolve(b));
        assertEquals(c, curation.resolve(a));
        assertEquals(c, curation.resolve(c));
    }

    @Test
    @DisplayName("a cycle terminates instead of looping forever")
    void cycleTerminates() {
        // merge() refuses to create this. The data could still be edited by hand, and an infinite
        // loop in the path every incoming question travels would take the whole board down.
        UUID a = id(), b = id();
        table.put(a, b);
        table.put(b, a);

        UUID resolved = curation.resolve(a);
        assertTrue(List.of(a, b).contains(resolved),
                "should stop on one of the two clusters in the cycle rather than hanging");
    }

    @Test
    @DisplayName("a chain longer than the hop limit stops rather than running away")
    void deepChainStops() {
        // Far deeper than any real sequence of moderator actions. The point is that it returns.
        UUID first = id();
        UUID current = first;
        for (int i = 0; i < 50; i++) {
            UUID next = id();
            table.put(current, next);
            current = next;
        }
        // Does not reach the true end, and says so in the log rather than pretending it did.
        assertTrue(curation.resolve(first) != null);
    }
}
