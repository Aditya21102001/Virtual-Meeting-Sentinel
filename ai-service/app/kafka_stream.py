"""Kafka ingest path + event-sourced cluster rebuild — the QUEUE_MODE=kafka backbone.

When QUEUE_MODE=kafka the Spring Boot backend PRODUCES every submitted question to the
`questions.incoming` topic instead of calling POST /ingest. That topic is a durable, retained
append-only log — the **source of truth** for what shareholders asked. The in-memory cluster
board is a **materialized view** derived from that log.

Why this matters: the OnlineClusterer keeps its centroids in memory, so a process restart
would normally wipe every cluster (the gap called out in HOW_IT_WORKS.md). Kafka's retained
log closes it. On startup we **replay the whole topic from offset 0**, re-running each question
through the same clusterer, so the board is reconstructed exactly as it was. Then we keep
consuming new questions live. This is classic event sourcing: state = fold(events).

We deliberately do NOT use a consumer-group partition split here. This process needs the FULL
history to rebuild complete cluster state, so it manually assigns every partition and seeks to
the beginning. (Sharding across instances would require distributed/shared cluster state, which
is out of scope for the single in-memory clusterer.)

The worker runs as a background thread INSIDE the FastAPI app (started in main.py's lifespan)
so the rebuilt + live clusters are the SAME singleton that the /clusters and /draft HTTP
endpoints serve.
"""
from __future__ import annotations
import json
import threading
import time
from functools import lru_cache

from kafka import KafkaConsumer
from kafka.structs import TopicPartition

from .clustering import get_clusterer
from .config import get_settings
from .embeddings import get_embeddings
from .rag import get_kb

# Auto-draft a cluster once this many distinct people have asked it (mirrors the backend's
# HOT_CLUSTER_THRESHOLD on the HTTP path). Only fires for LIVE questions, never during replay,
# so rebuilding history doesn't stampede the LLM.
_HOT_CLUSTER_THRESHOLD = 3


class KafkaIngestWorker:
    """Consumes `questions.incoming`, rebuilding cluster state from the log then staying live."""

    def __init__(self) -> None:
        self._settings = get_settings()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        # Observable state (exposed via /kafka/status for the demo).
        self.rebuilt = 0        # questions replayed from history at startup
        self.live = 0           # questions consumed live since replay finished
        self.ready = False      # True once the historical replay has fully caught up

    # ---- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run_forever, name="kafka-ingest", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def status(self) -> dict:
        return {
            "mode": "kafka",
            "topic": self._settings.kafka_questions_topic,
            "running": bool(self._thread and self._thread.is_alive()),
            "replay_complete": self.ready,
            "questions_replayed": self.rebuilt,
            "questions_live": self.live,
            "clusters": len(get_clusterer().top(1_000_000)),
        }

    # ---- worker loop -------------------------------------------------------
    def _run_forever(self) -> None:
        # Keep the worker alive across transient broker errors (cold start, restarts).
        while not self._stop.is_set():
            try:
                self._run()
            except Exception as exc:
                print(f"[kafka] worker error: {exc}; reconnecting in 3s")
                time.sleep(3)

    def _run(self) -> None:
        s = self._settings
        consumer = KafkaConsumer(
            bootstrap_servers=s.kafka_bootstrap_servers.split(","),
            value_deserializer=lambda b: json.loads(b.decode("utf-8")),
            enable_auto_commit=False,     # we ALWAYS replay from 0 on boot; committed offsets are irrelevant
            auto_offset_reset="earliest",
            group_id=None,                # no consumer group → manual assignment, full-history replay
            api_version_auto_timeout_ms=10_000,
        )
        try:
            self._replay_and_consume(consumer)
        finally:
            consumer.close()

    def _replay_and_consume(self, consumer: KafkaConsumer) -> None:
        s = self._settings

        # The topic may not exist yet on a cold cluster — wait until the backend produces the
        # first question (Kafka auto-creates the topic on first publish).
        partitions = consumer.partitions_for_topic(s.kafka_questions_topic)
        while partitions is None and not self._stop.is_set():
            print(f"[kafka] topic '{s.kafka_questions_topic}' not found yet; waiting for first question…")
            time.sleep(2)
            partitions = consumer.partitions_for_topic(s.kafka_questions_topic)
        if partitions is None:
            return

        tps = [TopicPartition(s.kafka_questions_topic, p) for p in partitions]
        consumer.assign(tps)
        consumer.seek_to_beginning(*tps)            # rewind to the very start of the log
        end_offsets = consumer.end_offsets(tps)     # snapshot where "history" ends before we drain

        embeddings = get_embeddings()
        clusterer = get_clusterer()
        print(f"[kafka] replaying '{s.kafka_questions_topic}' from offset 0 to rebuild clusters…")

        while not self._stop.is_set():
            records = consumer.poll(timeout_ms=1000)
            for _tp, messages in records.items():
                for message in messages:
                    self._handle(message.value, embeddings, clusterer)

            # Flip to "live" the moment every partition has been consumed up to the snapshot.
            if not self.ready and self._caught_up(consumer, tps, end_offsets):
                self.ready = True
                print(f"[kafka] rebuild complete: replayed {self.rebuilt} questions → "
                      f"{len(clusterer.top(1_000_000))} clusters. Now consuming live.")

    def _handle(self, payload: dict, embeddings, clusterer) -> None:
        text = (payload or {}).get("text", "").strip()
        if not text:
            return
        vec = embeddings.embed_query(text)
        result = clusterer.assign(text, vec, weight=float(payload.get("weight", 0.0)))

        if self.ready:
            self.live += 1
            # Auto-draft a freshly-hot cluster (best-effort; needs an LLM key). Skipped during
            # replay so rebuilding history never floods the LLM.
            if result.cluster.size == _HOT_CLUSTER_THRESHOLD and result.cluster.draft is None:
                self._auto_draft(result.cluster)
        else:
            self.rebuilt += 1

    @staticmethod
    def _auto_draft(cluster) -> None:
        try:
            d = get_kb().draft(cluster.cluster_id, cluster.representative_question)
            cluster.draft = d.answer
            cluster.citations = [c.model_dump() for c in d.citations]
        except Exception as exc:
            print(f"[kafka] auto-draft skipped for hot cluster: {exc}")

    @staticmethod
    def _caught_up(consumer: KafkaConsumer, tps: list[TopicPartition], end_offsets: dict) -> bool:
        try:
            return all(consumer.position(tp) >= end_offsets.get(tp, 0) for tp in tps)
        except Exception:
            return False


@lru_cache
def get_kafka_worker() -> KafkaIngestWorker:
    return KafkaIngestWorker()
