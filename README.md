# AGM Sentinel — Live Crowd-Question Intelligence

> Real-time system that **clusters, deduplicates, ranks, and drafts grounded answers**
> to thousands of live questions during a virtual Annual General Meeting (AGM),
> town-hall, or webinar.

A polyglot microservice project built to run on **100% free infrastructure — no credit card required.**

---

## The problem it solves

In a live virtual AGM with 10,000+ attendees, hundreds of shareholders type questions
*at the same time*. 60–70% are duplicates phrased differently ("What about the dividend?"
asked 400 ways). Human moderators drown. **No off-the-shelf tool clusters a live flood of
questions in real time and drafts factual answers grounded in the company's annual report.**

AGM Sentinel does exactly that:

1. **Ingest** questions at scale over WebSocket.
2. **Embed + cluster** them live (semantic dedup — not text matching).
3. **Rank** clusters by size × shareholder weight × urgency.
4. **Draft** a cited answer for the top clusters via RAG over the annual report.
5. **Stream** the live, deduplicated, ranked board back to moderators.

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
                  │  • sentence-transformers embed │
                  │  • online clustering           │
                  │  • LangChain RAG draft chain    │
                  │  • Groq / Gemini (free LLM)     │
                  └───────────────────────────────┘
```

### Why each language (the interview talking point)

| Service | Tech | Why this language |
|---|---|---|
| Frontend | **Angular** | Real-time board, your core skill |
| Core API | **Spring Boot (Java)** | Enterprise auth, WebSocket fan-out, transactional store |
| AI layer | **Python + LangChain** | The entire LLM/embeddings ecosystem lives in Python; scales independently |

Polyglot microservices with a *reason* for each language is exactly what AI-enabled
enterprises run in production. That rationale is the point of the design.

---

## The 100%-free stack (no credit card anywhere)

| Layer | Free host | Card? | Catch |
|---|---|---|---|
| Angular frontend | **Vercel** | No | None |
| Spring Boot API | **Koyeb** (or Render) | No | Sleeps when idle → ~30s cold start |
| Python AI service | **Hugging Face Spaces** (Docker) | No | 2 vCPU/16GB, sleeps when idle |
| LLM inference | **Groq** or **Google Gemini** | No | Generous free rate limits |
| Embeddings | `sentence-transformers` **in-process** | No | Runs inside the container, $0 |
| Postgres + pgvector | **Neon** (or Supabase) | No | 0.5GB — plenty |
| Redis Streams | **Upstash** | No | 10k cmd/day free |
| Keep-warm ping | **UptimeRobot** | No | Pings every ~10 min so hosts don't sleep |

**LLM-agnostic by design:** LangChain abstracts the provider. Develop on free Groq/Gemini;
swap to Azure OpenAI with one line later. Resume-legit phrasing:
*"LLM-agnostic RAG layer (LangChain), tested on Gemini/Groq, swappable to Azure OpenAI."*

---

## Repo layout

```
UniquePersonalProject/
├── README.md               ← you are here (master doc)
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
2. **Upstash** → create a free Redis DB, copy REST/redis URL. *(Optional — see cheaper variant.)*
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
