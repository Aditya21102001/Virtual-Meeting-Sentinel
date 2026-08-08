# VIRTUAL MEETING Sentinel — Live Crowd-Question Intelligence

> Real-time system that **clusters, deduplicates, ranks, and drafts grounded answers**
> to thousands of live questions during a virtual Annual General Meeting (VIRTUAL MEETING),
> town-hall, or webinar.

A polyglot microservice project built to run on **100% free infrastructure — no credit card required.**

---

## The problem it solves

In a live virtual VIRTUAL MEETING with 10,000+ attendees, hundreds of shareholders type questions
_at the same time_. 60–70% are duplicates phrased differently ("What about the dividend?"
asked 400 ways). Human moderators drown. **No off-the-shelf tool clusters a live flood of
questions in real time and drafts factual answers grounded in the company's annual report.**

VIRTUAL MEETING Sentinel does exactly that:

1. **Ingest** questions at scale over WebSocket.
2. **Embed + cluster** them live (semantic dedup — not text matching).
3. **Rank** clusters by size × shareholder weight × urgency.
4. **Draft** a cited answer for the top clusters via RAG over the annual report.
5. **Stream** the live, deduplicated, ranked board back to moderators.

Afterwards, the meeting itself has to be watchable. A **video library** lets moderators upload the
recording and members stream it on demand: the file is stored on a NAS share and cut into ~6-second
segments at several bitrates, so playback starts immediately, seeking anywhere is instant, and the
quality adapts to the network instead of stalling — nobody downloads a 2 GB file to watch it. See
**[VIDEO_LIBRARY.md](docs/VIDEO_LIBRARY.md)**.

---

## Architecture

```
                         ┌─────────────────────────┐
   Attendees ──────────► │  Angular SPA (Vercel)    │
   (many concurrent)     │  submit + moderator board│
                         └───────────┬──────────────┘
                                     │ WSS / REST + JWT
                         ┌───────────▼──────────────┐
                         │  Spring Boot API (Koyeb)  │
                         │  • Auth (JWT)             │
                         │  • WebSocket gateway       │
                         │  • Question ingest + store │
                         │  • Cluster board / SSE     │
                         └─────┬──────────────┬──────┘
              publish question │              │ read/write
              (Redis Stream)   │              │
                         ┌──────▼──────┐  ┌────▼─────────┐
                         │  Upstash    │  │ Postgres      │
                         │  Redis      │  │ + pgvector    │
                         └──────┬──────┘  │ (Neon)        │
                        consume │         └──────────────┘
                  ┌─────────────▼─────────────────┐
                  │  Python AI Service (HF Spaces) │
                  │  • ONNX MiniLM embed           │
                  │  • online clustering           │
                  │  • LangChain RAG draft chain    │
                  │  • Groq / Gemini (free LLM)     │
                  └───────────────────────────────┘

   Meeting recordings take a separate path — bytes to a NAS share, metadata to Postgres:

                         ┌──────────────────────────┐
   Members ────────────► │  Angular SPA              │
   (watch on demand)     │  custom HLS player        │
                         └───────────┬──────────────┘
                          segments + │ ticketed media URLs
                          manifests  │
                         ┌───────────▼──────────────┐        ┌──────────────┐
                         │  Spring Boot API          │───────►│ NAS share     │
                         │  • upload → NAS           │  bytes │ segments +    │
                         │  • FFmpeg → HLS ladder    │        │ the original  │
                         │  • segment index → DB     │        └──────────────┘
                         │  • signed playback tickets │
                         └───────────────────────────┘
```

### Why each language (the interview talking point)

| Service  | Tech                   | Why this language                                                         |
| -------- | ---------------------- | ------------------------------------------------------------------------- |
| Frontend | **Angular**            | Real-time board, your core skill                                          |
| Core API | **Spring Boot (Java)** | Enterprise auth, WebSocket fan-out, transactional store                   |
| AI layer | **Python + LangChain** | The entire LLM/embeddings ecosystem lives in Python; scales independently |

Polyglot microservices with a _reason_ for each language is exactly what AI-enabled
enterprises run in production. That rationale is the point of the design.

---

## The 100%-free stack (no credit card anywhere)

| Layer               | Free host                              | Card? | Catch                                    |
| ------------------- | -------------------------------------- | ----- | ---------------------------------------- |
| Angular frontend    | **Vercel**                             | No    | None                                     |
| Spring Boot API     | **Koyeb** (or Render)                  | No    | Sleeps when idle → ~30s cold start       |
| Python AI service   | **Hugging Face Spaces** (Docker)       | No    | 2 vCPU/16GB, sleeps when idle            |
| LLM inference       | **Ollama** (local) / Groq / Gemini     | No    | Ollama needs no key at all               |
| Embeddings          | `all-MiniLM-L6-v2` on ONNX **in-process** | No | Runs inside the container, $0         |
| Postgres + pgvector | **Neon** (or Supabase)                 | No    | 0.5GB — plenty                           |
| Video storage       | NAS share, or **in Postgres**          | No    | Needs a volume, or use `database` mode   |
| Redis Streams       | **Upstash**                            | No    | 10k cmd/day free                         |
| Keep-warm ping      | **UptimeRobot**                        | No    | Pings every ~10 min so hosts don't sleep |

**LLM-agnostic by design:** LangChain abstracts the provider. `LLM_PROVIDER=ollama` runs a local
open-source model with no API key and no account; Groq and Gemini are hosted alternatives; Azure
OpenAI is one line away. Resume-legit phrasing:
_"LLM-agnostic RAG layer (LangChain), tested on Ollama/Gemini/Groq, swappable to Azure OpenAI."_

### Fully open source, fully self-hosted

Every dependency is open source — audited in **[THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md)**,
which also covers the one nuance worth knowing (FFmpeg's GPL vs LGPL builds). To run with **no
third-party service and no account anywhere**:

```bash
LLM_PROVIDER=ollama            # local open-source model — no key, no bill
VECTOR_STORE=faiss             # in-process, no external vector DB
QUEUE_MODE=inproc              # no Redis or Kafka
VIDEO_STORAGE_MODE=filesystem  # local disk or a NAS share
```

Postgres, FFmpeg and Ollama all install locally. Clustering, dedup, ranking, the live board and the
whole video library already work with no API key; only "Draft answer" needs an LLM, and Ollama
supplies that locally.

---

## Repo layout

```
UniquePersonalProject/
├── README.md               ← you are here (master doc)
├── LICENSE                 ← MIT
├── docs/                   ← every other document lives here
│   ├── PROJECT_DOCUMENTATION.md ← the formal project report
│   ├── ARCHITECTURE.md          ← design, with per-flow sequence diagrams
│   ├── HOW_IT_WORKS.md          ← complete end-to-end walkthrough
│   ├── RUN_LOCAL.md             ← run it locally (exact commands)
│   ├── DEPLOY.md                ← free-tier deployment, no credit card
│   ├── MEETING_OPERATIONS.md    ← meetings, feature flags, voting, curation, the room, reports
│   ├── VIDEO_LIBRARY.md         ← recordings: storage modes, HLS segmentation, the player
│   ├── VIDEO_MODULE_SPEC.md     ← portable spec: build this feature in another application
│   ├── KAFKA.md                 ← Kafka ingest + event-sourced cluster rebuild
│   ├── LOUNGE.md                ← 1-on-1 chat + GenAI assistant + real roles
│   ├── INTERVIEW_GUIDE.md       ← the decisions, defended
│   └── THIRD_PARTY_LICENSES.md  ← every dependency audited; all open source
├── video-module/           ← the same feature extracted, shareable (code + DDL + PUML)
├── docker-compose.yml      ← run EVERYTHING locally with one command
├── .env.example            ← copy to .env and fill in free API keys
├── ai-service/             ← Python + FastAPI + LangChain      (see its README)
├── backend/                ← Spring Boot API                   (see its README)
└── frontend/               ← Angular SPA                       (see its README)
```

---

## Run it all locally (one command)

Prereqs: Docker Desktop, and a free **Groq** API key (https://console.groq.com — no card).

```bash
cp .env.example .env          # then paste your GROQ_API_KEY into .env
docker compose up --build
```

This starts Postgres+pgvector, Redis, the Python AI service, and the Spring Boot API.
Then run the Angular app:

```bash
cd frontend && npm install && npm start   # http://localhost:4200
```

Open two browser tabs: one as an attendee submitting questions, one as the moderator
board — watch questions cluster and get drafted answers in real time.

---

## Free deployment — quick map

Each service folder has a detailed deploy guide. High level:

1. **Neon** → create a free Postgres project, enable `pgvector`, copy the connection string.
2. **Upstash** → create a free Redis DB, copy REST/redis URL. _(Optional — see cheaper variant.)_
3. **Hugging Face Spaces** → new Space (Docker SDK), push `ai-service/`, set secrets.
4. **Koyeb** → deploy `backend/` from GitHub (Dockerfile), set env vars.
5. **Vercel** → import `frontend/`, set `VERCEL` env, deploy.
6. **UptimeRobot** → add HTTP monitors on the Koyeb + HF URLs to prevent cold sleeps.

See [ai-service/README.md](ai-service/README.md), [backend/README.md](backend/README.md),
and [frontend/README.md](frontend/README.md).

---

## Cheaper-to-run variant (fewer moving parts)

For a pure portfolio demo you can drop two external services and keep the design intact:

- **Drop Upstash** → set `QUEUE_MODE=inproc` (an in-process queue). Redis stays in the
  design/README as the documented production choice.
- **Drop pgvector** → set `VECTOR_STORE=faiss` to keep embeddings in-memory (FAISS).

That leaves just **Vercel + Koyeb + HF Spaces + one free LLM key**.

---

## Resume bullet

> Architected a polyglot microservice system (Angular + Spring Boot + Python/LangChain)
> that clusters, deduplicates, and drafts grounded answers to thousands of concurrent live
> questions in real time — Redis Streams for backpressure, pgvector RAG, LLM-agnostic
> LangChain layer — deployed entirely on free infrastructure (Vercel + Koyeb + HF Spaces).
