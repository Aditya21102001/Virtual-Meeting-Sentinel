"""Optional Redis Streams consumer — the production-scale ingest path.

When QUEUE_MODE=redis, the Spring Boot backend publishes each question to a Redis Stream
instead of calling /ingest directly. This decouples a burst of 10k writers from the bounded
throughput of embedding+clustering: the stream absorbs the spike (backpressure) and this
worker drains it at a steady rate. Run as a separate process:

    python -m app.consumer

For the free/demo deployment you can ignore this entirely and use the HTTP /ingest endpoint.
"""
import json
import time

import redis

from .clustering import get_clusterer
from .config import get_settings
from .embeddings import get_embeddings


def run() -> None:
    s = get_settings()
    r = redis.Redis.from_url(s.redis_url, decode_responses=True)

    # Create the consumer group (idempotent).
    try:
        r.xgroup_create(s.question_stream, s.consumer_group, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise

    embeddings = get_embeddings()
    clusterer = get_clusterer()
    print(f"[consumer] draining {s.question_stream} as group {s.consumer_group}")

    while True:
        resp = r.xreadgroup(
            s.consumer_group, "worker-1",
            {s.question_stream: ">"}, count=32, block=5000,
        )
        if not resp:
            continue
        for _stream, messages in resp:
            for msg_id, fields in messages:
                payload = json.loads(fields["data"])
                vec = embeddings.embed_query(payload["text"])
                result = clusterer.assign(payload["text"], vec, weight=payload.get("weight", 0.0))
                # Publish the assignment back so the backend can push it to moderators.
                r.xadd("clusters:assigned", {"data": json.dumps({
                    "question_id": payload["question_id"],
                    "cluster_id": result.cluster.cluster_id,
                    "is_new": result.is_new,
                    "size": result.cluster.size,
                })})
                r.xack(s.question_stream, s.consumer_group, msg_id)


if __name__ == "__main__":
    while True:
        try:
            run()
        except Exception as exc:  # keep the worker alive across transient errors
            print(f"[consumer] error: {exc}; retrying in 3s")
            time.sleep(3)
