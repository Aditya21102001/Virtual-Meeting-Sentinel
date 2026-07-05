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
Centroids are kept in memory for speed and persisted to Postgres for durability/restart.
"""
from __future__ import annotations
import threading
import uuid
from dataclasses import dataclass, field

import numpy as np

from .config import get_settings
from .embeddings import cosine


@dataclass
class Cluster:
    cluster_id: str
    representative_question: str        # the first / most central question text
    centroid: np.ndarray                # running mean of member embeddings (normalized)
    size: int = 1
    weight_sum: float = 0.0             # sum of shareholder weights (for ranking)
    draft: str | None = None            # cached RAG draft answer, once generated
    citations: list | None = None       # [{source, snippet}] backing the draft

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
    """Thread-safe incremental clusterer. One instance per running process."""

    def __init__(self, threshold: float | None = None):
        self._threshold = threshold or get_settings().cluster_similarity_threshold
        self._clusters: dict[str, Cluster] = {}
        self._lock = threading.Lock()

    def assign(self, text: str, embedding: list[float], weight: float = 0.0) -> ClusterResult:
        """Place one question into a cluster (existing or new) and return the outcome.

        `text`      : the raw question (kept as the cluster's representative if it's new).
        `embedding` : the question's 384-dim vector (already L2-normalized by the embedder).
        `weight`    : the asker's shareholder weight (0..1), accumulated for ranking.
        """
        vec = np.asarray(embedding, dtype=np.float32)
        # Lock: many web requests hit this concurrently and mutate shared cluster state.
        with self._lock:
            # 1) Find the single most similar existing cluster (linear scan over centroids).
            best_id, best_sim = None, -1.0
            for cid, cluster in self._clusters.items():
                sim = cosine(vec, cluster.centroid)
                if sim > best_sim:
                    best_id, best_sim = cid, sim

            # 2) Close enough to an existing topic? Fold it in (this is the dedup step).
            if best_id is not None and best_sim >= self._threshold:
                cluster = self._clusters[best_id]
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
            )
            self._clusters[cluster.cluster_id] = cluster
            # similarity reported as the best we saw (0 if this is the very first cluster).
            return ClusterResult(cluster=cluster, is_new=True, similarity=best_sim if best_id else 0.0)

    def top(self, n: int = 20) -> list[Cluster]:
        with self._lock:
            return sorted(self._clusters.values(), key=lambda c: c.priority_score, reverse=True)[:n]

    def get(self, cluster_id: str) -> Cluster | None:
        return self._clusters.get(cluster_id)


_clusterer: OnlineClusterer | None = None


def get_clusterer() -> OnlineClusterer:
    global _clusterer
    if _clusterer is None:
        _clusterer = OnlineClusterer()
    return _clusterer
