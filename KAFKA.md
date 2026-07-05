# Kafka ingest + event-sourced cluster rebuild

A third ingest path (`QUEUE_MODE=kafka`) alongside `inproc` and `redis`. It turns the
`questions.incoming` Kafka topic into the **durable source of truth** for every question, and
makes the AI service's in-memory cluster board a **materialized view** that is rebuilt by
replaying the log on startup.

This closes the gap called out in [HOW_IT_WORKS.md](HOW_IT_WORKS.md): the `OnlineClusterer`
keeps centroids in memory, so a restart used to lose every cluster. Now it doesn't.

---

## Architecture

```
                          QUEUE_MODE=kafka
 Attendee ─► POST /api/questions (Spring Boot)
                 │  1. save question to Postgres
                 │  2. produce event ──► ┌────────────────────────────┐
                 └───────────────────────►│  Kafka: questions.incoming │  ◄── retained log
                                          │  (durable, replayable)     │      (source of truth)
                                          └──────────────┬─────────────┘
                                                         │ consume
                              ┌──────────────────────────▼───────────────────────────┐
                              │  Python AI service (KafkaIngestWorker, bg thread)      │
                              │  • on boot: seek(0) → REPLAY whole log → rebuild        │
                              │    clusters  (event sourcing: state = fold(events))     │
                              │  • then: consume live, cluster, auto-draft hot clusters │
                              └──────────────────────────┬───────────────────────────┘
                                          same in-memory clusterer singleton
                              ┌──────────────────────────▼───────────────────────────┐
                              │  GET /clusters  → Spring Boot scheduled board push     │
                              │                 → STOMP /topic/board → moderators       │
                              └────────────────────────────────────────────────────────┘
```

**Key design choice — full-history replay, not a consumer group.** The worker manually
assigns *all* partitions and `seek_to_beginning`, because this process needs the entire history
to reconstruct complete cluster state. A consumer-group partition split would give each instance
only a slice of the questions → partial clusters. (Sharding would require distributed cluster
state, which is out of scope for the single in-memory clusterer — noted as the scaling path.)

The worker runs as a **background thread inside the FastAPI app** (`main.py` lifespan) so the
rebuilt + live clusters are the same singleton that `/clusters` and `/draft` serve.

---

## What changed

| Layer | File | Change |
|---|---|---|
| AI config | `ai-service/app/config.py` | `kafka_bootstrap_servers`, `kafka_questions_topic`; `queue_mode` gains `kafka` |
| AI worker | `ai-service/app/kafka_stream.py` | **new** — replay-then-live consumer, auto-draft, status |
| AI app | `ai-service/app/main.py` | start worker in lifespan when `queue_mode=kafka`; `GET /kafka/status` |
| AI deps | `ai-service/requirements.txt` | `kafka-python==2.0.2` |
| Backend | `backend/pom.xml` | `spring-kafka` dependency |
| Backend | `backend/.../service/KafkaQuestionProducer.java` | **new** — produces to `questions.incoming` (active only in kafka mode) |
| Backend | `backend/.../service/QuestionService.java` | `submit()` / `submitBulk()` branch to Kafka when `queue.mode=kafka` |
| Backend | `backend/src/main/resources/application.yml` | `queue.mode`, `spring.kafka.*` |
| Infra | `docker-compose.yml` | `kafka` (KRaft, single-node) + `kafkadata` volume; env wired into both services |
| Infra | `.env.example` | documents `QUEUE_MODE=kafka`, `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_QUESTIONS_TOPIC` |

The default is unchanged (`QUEUE_MODE=inproc`/`http`), so existing behaviour is untouched
until you opt in.

---

## Run it

```bash
cp .env.example .env         # then set QUEUE_MODE=kafka and add your GROQ_API_KEY
docker compose up --build
```

`docker compose` starts Kafka (KRaft, no ZooKeeper) and points both services at `kafka:9092`.
The `questions.incoming` topic is auto-created on the first published question.

Then run the frontend and submit some questions:

```bash
cd frontend && npm install && npm start   # http://localhost:4200
```

### Watch it work

```bash
# Ingest-worker telemetry: replay progress, live count, cluster count
curl http://localhost:8000/kafka/status
# → {"mode":"kafka","topic":"questions.incoming","running":true,
#    "replay_complete":true,"questions_replayed":0,"questions_live":12,"clusters":4}
```

---

## The event-sourcing demo (the payoff)

1. Submit a bunch of questions from the attendee page — watch clusters form on the moderator
   board.
2. Note the cluster count: `curl http://localhost:8000/kafka/status`.
3. **Kill and restart only the AI service** (its in-memory clusters are wiped):
   ```bash
   docker compose restart ai-service
   docker compose logs -f ai-service
   ```
4. In the logs you'll see it replay the log and rebuild:
   ```
   [kafka] replaying 'questions.incoming' from offset 0 to rebuild clusters…
   [kafka] rebuild complete: replayed 12 questions → 4 clusters. Now consuming live.
   ```
5. The moderator board comes back **identical** — reconstructed purely from the Kafka log.
   Because Kafka persists to the `kafkadata` volume, this survives even a full
   `docker compose down && docker compose up`.

That's the whole point: **cluster state = a deterministic fold over the question log**, so it's
always reproducible from Kafka.

---

## Notes & trade-offs

- **Async ingest.** In kafka mode, `POST /api/questions` returns immediately with
  `cluster_id: "pending"` (the assignment happens asynchronously in the AI consumer). The board
  reflects the new cluster on the next scheduled push (`board.refresh-ms`, default 10s) — lower
  it for a snappier demo.
- **Auto-draft** of hot clusters (size = 3) moves into the AI consumer in this mode
  (`_HOT_CLUSTER_THRESHOLD` in `kafka_stream.py`), and is skipped during replay so rebuilding
  history doesn't stampede the LLM.
- **Single-node broker** with replication factor 1 — fine for dev/portfolio. Production would
  use a managed multi-broker cluster (e.g. Upstash Kafka / Confluent free tier) via the same
  `KAFKA_BOOTSTRAP_SERVERS`.
- **Scaling path.** To scale consumers horizontally you'd move cluster centroids into a shared
  store (Postgres/pgvector or Redis) and switch to a real consumer group; the replay-on-boot
  logic would then seed a cold cache rather than the whole in-memory view.
