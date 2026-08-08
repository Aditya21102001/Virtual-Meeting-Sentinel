"""Checks that clustering never merges questions across meetings.

WHY THIS MATTERS
----------------
The clusterer folds a new question into the nearest existing topic. If that search is not
confined to one meeting, a question asked at this year's AGM gets absorbed into a topic
from last year's — and nothing looks broken. The board simply shows a topic whose count is
too high, containing questions nobody at this meeting asked. It is the kind of wrong that
survives a demo and surfaces when somebody reads the minutes.

So the partitioning is checked directly, on identical vectors: two questions that WOULD
merge in the same meeting must NOT merge across two.

RUNNING IT
----------
    cd ai-service
    ./.venv/Scripts/python.exe scripts/check_clustering.py     # Windows venv
    # or:  python scripts/check_clustering.py

Exits non-zero on the first failure, so it works as a pre-commit or CI step. Written as
plain functions with asserts, so it becomes a pytest module unchanged if pytest is ever
added — no rewrite, just move it.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

# Importable when run from anywhere in the repo, not just ai-service/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.clustering import NO_MEETING, OnlineClusterer  # noqa: E402

MEETING_A = "11111111-1111-1111-1111-111111111111"
MEETING_B = "22222222-2222-2222-2222-222222222222"


def unit(*components: float) -> list[float]:
    """A normalised vector, standing in for an embedding."""
    v = np.array(components, dtype=np.float32)
    return (v / np.linalg.norm(v)).tolist()


# Identical on purpose: cosine similarity 1.0, so these WOULD merge if allowed to.
DIVIDEND = unit(1, 0, 0)
BUYBACK = unit(0, 1, 0)


def clusterer() -> OnlineClusterer:
    # An explicit threshold rather than the configured one, so the check does not start
    # failing because somebody tuned a setting.
    return OnlineClusterer(threshold=0.9)


def test_identical_questions_merge_within_one_meeting():
    c = clusterer()
    first = c.assign("when is the dividend paid", DIVIDEND, 0.5, meeting_id=MEETING_A)
    second = c.assign("dividend timing please", DIVIDEND, 0.5, meeting_id=MEETING_A)

    assert first.is_new, "the first question should start a topic"
    assert not second.is_new, "an identical question in the same meeting should be folded in"
    assert first.cluster.cluster_id == second.cluster.cluster_id
    assert second.cluster.size == 2, "the topic should now count two askers"


def test_identical_questions_do_not_merge_across_meetings():
    """The whole point of the partitioning."""
    c = clusterer()
    at_a = c.assign("when is the dividend paid", DIVIDEND, 0.5, meeting_id=MEETING_A)
    at_b = c.assign("when is the dividend paid", DIVIDEND, 0.5, meeting_id=MEETING_B)

    assert at_b.is_new, "the same question at another meeting must start its own topic"
    assert at_a.cluster.cluster_id != at_b.cluster.cluster_id
    assert at_a.cluster.size == 1, "meeting A's topic must not have counted meeting B's asker"
    assert at_b.cluster.size == 1


def test_questions_with_no_meeting_share_their_own_partition():
    """Deployments that never use meetings keep the old behaviour exactly."""
    c = clusterer()
    first = c.assign("dividend?", DIVIDEND, 0.5, meeting_id=None)
    second = c.assign("about the dividend", DIVIDEND, 0.5, meeting_id=None)
    third = c.assign("dividend?", DIVIDEND, 0.5, meeting_id="")   # blank means the same as None

    assert not second.is_new, "with no meeting, identical questions still merge"
    assert not third.is_new, "a blank meeting id must be treated as no meeting, not a new one"
    assert first.cluster.meeting_id is None


def test_board_can_be_asked_for_one_meeting_or_all():
    c = clusterer()
    c.assign("dividend", DIVIDEND, 0.5, meeting_id=MEETING_A)
    c.assign("buyback", BUYBACK, 0.5, meeting_id=MEETING_A)
    c.assign("dividend", DIVIDEND, 0.5, meeting_id=MEETING_B)
    c.assign("dividend", DIVIDEND, 0.5, meeting_id=None)

    assert len(c.top(20, meeting_id=MEETING_A)) == 2
    assert len(c.top(20, meeting_id=MEETING_B)) == 1
    # meeting_id=None means the meeting-less partition SPECIFICALLY, not "any meeting".
    assert len(c.top(20, meeting_id=None)) == 1
    # all_meetings is the separate, explicit way to ask for everything.
    assert len(c.top(20, all_meetings=True)) == 4


def test_get_finds_a_cluster_in_any_meeting():
    """Drafting an answer looks a cluster up by id alone; it must not need the meeting too."""
    c = clusterer()
    at_b = c.assign("dividend", DIVIDEND, 0.5, meeting_id=MEETING_B)
    assert c.get(at_b.cluster.cluster_id) is not None
    assert c.get("not-a-real-id") is None


def test_activating_a_meeting_drops_every_other_meetings_state():
    c = clusterer()
    c.assign("dividend", DIVIDEND, 0.5, meeting_id=MEETING_A)
    c.assign("buyback", BUYBACK, 0.5, meeting_id=MEETING_A)
    c.assign("dividend", DIVIDEND, 0.5, meeting_id=MEETING_B)
    c.assign("dividend", DIVIDEND, 0.5, meeting_id=None)

    result = c.retain_only(MEETING_A)

    assert result["remaining_clusters"] == 2
    assert result["dropped_meetings"] == 2, "meeting B and the meeting-less partition"
    assert result["dropped_clusters"] == 2
    assert len(c.top(20, meeting_id=MEETING_B)) == 0
    assert len(c.top(20, all_meetings=True)) == 2, "only the retained meeting should remain"


def test_retaining_a_meeting_with_no_state_is_harmless():
    """Activating a brand-new meeting is the common case, and it holds nothing yet."""
    c = clusterer()
    c.assign("dividend", DIVIDEND, 0.5, meeting_id=MEETING_A)

    result = c.retain_only(MEETING_B)

    assert result["remaining_clusters"] == 0
    assert result["dropped_clusters"] == 1
    assert len(c.top(20, all_meetings=True)) == 0


def test_stats_reports_each_partition():
    c = clusterer()
    c.assign("dividend", DIVIDEND, 0.5, meeting_id=MEETING_A)
    c.assign("dividend", DIVIDEND, 0.5, meeting_id=None)

    stats = c.stats()
    assert stats["meetings_held"] == 2
    assert stats["clusters_total"] == 2
    assert stats["by_meeting"][MEETING_A] == 1
    assert stats["by_meeting"][NO_MEETING] == 1


def main() -> int:
    checks = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for check in checks:
        try:
            check()
        except AssertionError as err:
            failures += 1
            print(f"FAIL  {check.__name__}\n      {err}")
        except Exception as err:  # noqa: BLE001 - a broken check is a failure like any other
            failures += 1
            print(f"ERROR {check.__name__}\n      {type(err).__name__}: {err}")
        else:
            print(f"ok    {check.__name__}")

    print(f"\n{len(checks) - failures}/{len(checks)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
