"""Online (streaming) semantic clustering of live questions.

Classic batch clustering (k-means) needs all points up front and a fixed k — useless
for a live stream where questions arrive one at a time and the number of distinct topics
is unknown. So we use **incremental nearest-centroid clustering**:

    for each incoming question:
        embed it
        find the existing cluster whose centroid is most similar
        if similarity >= threshold:  fold into that cluster, update centroid (running mean)
        else:                        start a new cluster with this question as centroid

This is O(#clusters) per question, gives real-time dedup, and needs no k.

Centroids live in memory here; the backend keeps the durable record in `cluster_drafts`,
so losing this process loses speed, not data.

PARTITIONED BY MEETING
----------------------
Every operation is scoped to one meeting. Without that, a question asked at this year's
AGM would be compared against last year's centroids and folded into a topic from a
different meeting — not a tidiness problem but a wrong answer, and one that is invisible
until somebody reads the board and finds a question they never asked.

Questions with no meeting (asked before meetings existed, or while none was active) share
a single partition of their own. That keeps the old, unpartitioned behaviour intact for
deployments that do not use meetings at all.

Partitioning is UNCONDITIONAL — it does not depend on the backend's MEETINGS feature flag.
If it did, everything ingested with the flag off would land in the meeting-less partition,
and switching the flag on would leave the live board unable to find any of it. The backend
follows the same rule: record always, filter only when asked.
"""
from __future__ import annotations
import threading
import uuid
from dataclasses import dataclass

import numpy as np

from .config import get_settings
from .embeddings import cosine

# Partition key for questions that belong to no meeting. A sentinel rather than None so the
# partition map has one key type, and a string no UUID can collide with.
NO_MEETING = "__no_meeting__"


def _partition_key(meeting_id: str | None) -> str:
    """Normalise a meeting id into a partition key. Blank and missing mean the same thing."""
    if meeting_id is None:
        return NO_MEETING
    cleaned = meeting_id.strip()
    return cleaned if cleaned else NO_MEETING


@dataclass
class Cluster:
    cluster_id: str
    representative_question: str        # the first / most central question text
    centroid: np.ndarray                # running mean of member embeddings (normalized)
    size: int = 1
    weight_sum: float = 0.0             # sum of shareholder weights (for ranking)
    draft: str | None = None            # cached RAG draft answer, once generated
    citations: list | None = None       # [{source, snippet}] backing the draft
    # Which meeting this topic belongs to, or None. Carried on the cluster as well as in the
    # partition map so a cluster handed to a caller still knows where it came from.
    meeting_id: str | None = None

    @property
    def priority_score(self) -> float:
        # Rank = how many people asked  ×  how much equity they hold (log-damped size).
        return float(np.log1p(self.size) * (1.0 + self.weight_sum))


@dataclass
class ClusterResult:
    cluster: Cluster
    is_new: bool
    similarity: float


class OnlineClusterer:
    """Thread-safe incremental clusterer, partitioned by meeting. One instance per process."""

    def __init__(self, threshold: float | None = None):
        self._threshold = threshold or get_settings().cluster_similarity_threshold
        # meeting partition key -> {cluster_id -> Cluster}
        self._partitions: dict[str, dict[str, Cluster]] = {}
        self._lock = threading.Lock()

    def assign(
        self,
        text: str,
        embedding: list[float],
        weight: float = 0.0,
        meeting_id: str | None = None,
    ) -> ClusterResult:
        """Place one question into a cluster (existing or new) and return the outcome.

        `text`       : the raw question (kept as the cluster's representative if it's new).
        `embedding`  : the question's 384-dim vector (already L2-normalized by the embedder).
        `weight`     : the asker's shareholder weight (0..1), accumulated for ranking.
        `meeting_id` : which meeting it was asked at. The search below NEVER leaves this
                       partition, which is what stops one meeting's questions merging into
                       another's topics.
        """
        vec = np.asarray(embedding, dtype=np.float32)
        key = _partition_key(meeting_id)

        # Lock: many web requests hit this concurrently and mutate shared cluster state.
        with self._lock:
            clusters = self._partitions.setdefault(key, {})

            # 1) Most similar existing cluster IN THIS MEETING (linear scan over its centroids).
            best_id, best_sim = None, -1.0
            for cid, cluster in clusters.items():
                sim = cosine(vec, cluster.centroid)
                if sim > best_sim:
                    best_id, best_sim = cid, sim

            # 2) Close enough to an existing topic? Fold it in (this is the dedup step).
            if best_id is not None and best_sim >= self._threshold:
                cluster = clusters[best_id]
                # Update the centroid as a running mean of all member vectors:
                #   new_centroid = (old_centroid * n + new_vec) / (n + 1)
                # then re-normalize so future cosine comparisons stay on the unit sphere.
                n = cluster.size
                cluster.centroid = (cluster.centroid * n + vec) / (n + 1)
                norm = np.linalg.norm(cluster.centroid)
                if norm > 0:
                    cluster.centroid /= norm
                cluster.size += 1              # one more person asked this
                cluster.weight_sum += weight   # accumulate their equity weight
                return ClusterResult(cluster=cluster, is_new=False, similarity=best_sim)

            # 3) Nothing similar enough → this is a brand-new topic; seed a cluster with it.
            cluster = Cluster(
                cluster_id=str(uuid.uuid4()),
                representative_question=text,
                centroid=vec,                  # the seed vector IS the initial centroid
                size=1,
                weight_sum=weight,
                meeting_id=None if key == NO_MEETING else key,
            )
            clusters[cluster.cluster_id] = cluster
            # similarity reported as the best we saw (0 if this is the very first cluster).
            return ClusterResult(cluster=cluster, is_new=True, similarity=best_sim if best_id else 0.0)

    def top(self, n: int = 20, meeting_id: str | None = None, *, all_meetings: bool = False) -> list[Cluster]:
        """The ranked board.

        Pass `meeting_id` for one meeting's topics. Pass `all_meetings=True` for everything,
        merged and re-ranked — which is what the backend asks for when per-meeting filtering
        is switched off, so that deployment behaves exactly as it did before partitioning.

        The two are kept distinct on purpose: `meeting_id=None` means the meeting-less
        partition specifically, NOT "any meeting". Conflating them would silently turn a
        request for one meeting's board into a request for every meeting's.
        """
        with self._lock:
            if all_meetings:
                pool: list[Cluster] = []
                for clusters in self._partitions.values():
                    pool.extend(clusters.values())
            else:
                pool = list(self._partitions.get(_partition_key(meeting_id), {}).values())
            return sorted(pool, key=lambda c: c.priority_score, reverse=True)[:n]

    def get(self, cluster_id: str) -> Cluster | None:
        """Find a cluster by id, wherever it lives.

        Not partition-scoped: a cluster id is globally unique, and the caller asking to draft
        an answer for one already knows which it wants. Making them supply the meeting too
        would be a second chance to get it wrong for no benefit.
        """
        with self._lock:
            for clusters in self._partitions.values():
                found = clusters.get(cluster_id)
                if found is not None:
                    return found
        return None

    def retain_only(self, meeting_id: str | None) -> dict[str, int]:
        """Drop every partition except one — called when a meeting is activated.

        This is what makes a new meeting start genuinely clean rather than merely
        filtered, and it is safe because these centroids are a cache: the durable record of
        every topic lives in the backend's `cluster_drafts`, and a board whose live ranking
        is missing falls back to those rows.

        It also matters for memory. This service runs in a small container and has been
        killed for exceeding it; holding every past meeting's centroids forever is a leak
        with a slow fuse.

        Returns what was dropped, so the caller can log something meaningful rather than
        assuming it worked.
        """
        keep = _partition_key(meeting_id)
        with self._lock:
            dropped_partitions = 0
            dropped_clusters = 0
            for key in list(self._partitions.keys()):
                if key == keep:
                    continue
                dropped_clusters += len(self._partitions[key])
                del self._partitions[key]
                dropped_partitions += 1
            return {
                "kept": keep,
                "dropped_meetings": dropped_partitions,
                "dropped_clusters": dropped_clusters,
                "remaining_clusters": len(self._partitions.get(keep, {})),
            }

    def stats(self) -> dict:
        """Per-partition counts, for the health endpoint and for diagnosing memory."""
        with self._lock:
            return {
                "meetings_held": len(self._partitions),
                "clusters_total": sum(len(c) for c in self._partitions.values()),
                "by_meeting": {k: len(v) for k, v in self._partitions.items()},
            }


_clusterer: OnlineClusterer | None = None


def get_clusterer() -> OnlineClusterer:
    global _clusterer
    if _clusterer is None:
        _clusterer = OnlineClusterer()
    return _clusterer
