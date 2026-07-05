# AGM Sentinel — Project Documentation

**Live Crowd-Question Intelligence for Virtual Annual General Meetings**

| | |
|---|---|
| **Author** | Aditya Yadav |
| **Type** | Full-Stack + Generative AI · Polyglot Microservices |
| **Stack** | Angular · Spring Boot (Java) · Python (FastAPI + LangChain) |
| **Status** | Built & verified locally; deployable on 100% free infrastructure |
| **Repository** | `agm-sentinel` (Angular / Spring Boot / Python monorepo) |

---

## Table of Contents
1. [Abstract](#1-abstract)
2. [Problem Statement](#2-problem-statement)
3. [Objectives](#3-objectives)
4. [Scope](#4-scope)
5. [Technology Stack](#5-technology-stack)
6. [System Architecture](#6-system-architecture)
7. [Module Descriptions](#7-module-descriptions)
8. [Core Algorithm — Online Semantic Clustering](#8-core-algorithm--online-semantic-clustering)
9. [RAG Pipeline — Grounded Answer Drafting](#9-rag-pipeline--grounded-answer-drafting)
10. [Database Design](#10-database-design)
11. [API Reference](#11-api-reference)
12. [Data Flow](#12-data-flow)
13. [Security Design](#13-security-design)
14. [Deployment (Free Tier)](#14-deployment-free-tier)
15. [Build & Verification Results](#15-build--verification-results)
16. [Future Enhancements](#16-future-enhancements)
17. [Conclusion](#17-conclusion)

---

## 1. Abstract

AGM Sentinel is a real-time, AI-powered system that manages the flood of questions asked
during a large virtual **Annual General Meeting (AGM)**, town-hall, or webinar. When
thousands of shareholders type questions simultaneously, 60–70% are duplicates phrased
differently, and human moderators cannot keep up.

The system ingests questions over WebSocket, **embeds and clusters them live** using
semantic similarity (not keyword matching), **ranks** clusters by how many people asked and
their shareholder weight, and **drafts grounded answers** for the most important topics using
Retrieval-Augmented Generation (RAG) over the company's annual report. The result is a live,
deduplicated, prioritized moderator board with suggested answers.

The project is intentionally built as a **polyglot microservice architecture** — Angular for
the UI, Spring Boot for enterprise business/auth logic, and Python + LangChain for the AI
layer — mirroring how AI-enabled enterprises structure production systems. It is designed to
run entirely on **free-tier infrastructure with no credit card required**.

---

## 2. Problem Statement

Virtual AGMs at large listed companies routinely host **10,000+ concurrent attendees**.
During the Q&A window:

- Hundreds of questions arrive within seconds.
- A majority are **semantic duplicates** ("When is the dividend paid?" vs. "What's the payout
  date for dividends?") that keyword/text de-duplication cannot catch.
- Moderators must manually read, group, prioritize, and answer — an impossible task at scale.
- Answers must be **factually grounded** in official disclosures (annual report, financials),
  not improvised.

No off-the-shelf tool performs **live semantic clustering + ranking + grounded drafting** on a
real-time question stream. AGM Sentinel solves this specific, high-value problem.

---

## 3. Objectives

1. Accept questions from many concurrent attendees in real time.
2. Automatically **deduplicate** semantically similar questions into a single topic.
3. **Rank** topics by importance (cluster size × shareholder weight).
4. Generate **grounded, cited draft answers** for hot topics via RAG.
5. Present moderators a **live board** that updates over WebSocket.
6. Demonstrate a clean **polyglot microservice** design with a clear rationale per language.
7. Be deployable at **zero cost**.

---

## 4. Scope

**In scope**
- Real-time question ingestion, semantic clustering, ranking, and RAG drafting.
- JWT-based role separation (attendee vs. moderator).
- Live moderator board over STOMP/WebSocket.
- **Moderator Setup page**: upload the annual report (indexed into RAG at runtime) and a
  question bank (bulk-ingested and clustered).
- **Cited answers**: each draft lists its sources as **clickable links that open the source
  PDF at the cited page**.
- Free-tier cloud deployment.

**Out of scope (future work)**
- Full shareholder identity federation (OAuth2/MFA) — stubbed via demo JWT.
- Horizontal auto-scaling and Kafka-grade throughput (Redis Streams path included as the
  production-scale option).
- Pixel-exact in-PDF highlighting of a cited chunk (native PDF viewers jump to a page only).
- Multi-tenant company onboarding UI.

---

## 5. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | **Angular 22** (standalone, **zoneless**, signals), STOMP/SockJS | Real-time board UI; current best-practice change detection |
| Core API | **Spring Boot 3 / Java 17** | Enterprise auth, WebSocket fan-out, transactional store |
| AI Service | **Python 3.11 · FastAPI · LangChain** | The entire LLM/embeddings ecosystem lives in Python |
| Embeddings | **sentence-transformers** `all-MiniLM-L6-v2` (local) | Runs in-process; zero API cost |
| LLM | **Groq (Llama 3.3 70B)** / **Google Gemini** — swappable to Azure OpenAI | Free inference; LangChain abstracts the provider |
| Vector search | **FAISS** (knowledge base) + **pgvector** (persistence) | Fast similarity search without a paid vector DB |
| Database | **PostgreSQL + pgvector** (Neon free tier) | Relational + vector in one store |
| Messaging | **Redis Streams** (Upstash free tier) — optional | Backpressure for high-volume ingest |
| Auth | **JWT (JJWT)** | Stateless role separation |

**Why polyglot?** Java gives transactional, secure, high-concurrency business logic; Python
gives first-class access to embeddings, vector stores, and LLM orchestration. Splitting them
lets each scale and deploy independently — exactly how production AI systems are built.

---

## 6. System Architecture

```
                         ┌─────────────────────────┐
   Attendees ──────────► │  Angular SPA (Vercel)    │
   (many concurrent)     │  submit + moderator board│
                         └───────────┬──────────────┘
                                     │ REST + WebSocket (STOMP), JWT
                         ┌───────────▼──────────────┐
                         │  Spring Boot API (Koyeb)  │
                         │  • JWT auth               │
                         │  • WebSocket gateway       │
                         │  • Question ingest + store │
                         │  • Board broadcast / rank  │
                         └─────┬──────────────┬──────┘
              publish (optional)│              │ read / write
              Redis Stream      │              │
                         ┌──────▼──────┐  ┌────▼─────────┐
                         │  Upstash    │  │ Postgres      │
                         │  Redis      │  │ + pgvector    │
                         └──────┬──────┘  │ (Neon)        │
                        consume │         └──────────────┘
                  ┌─────────────▼─────────────────┐
                  │  Python AI Service (HF Spaces) │
                  │  • local embeddings            │
                  │  • online clustering           │
                  │  • LangChain RAG draft chain    │
                  │  • Groq / Gemini (free LLM)     │
                  └───────────────────────────────┘
```

The **Spring Boot** service is the front door: it authenticates users, persists questions,
calls the **Python AI service** for embedding/clustering/drafting, and pushes the live board
to moderators. The **Python service** owns all vector math and LLM orchestration. This keeps
each service single-responsibility and independently deployable.

---

## 7. Module Descriptions

### 7.1 Frontend (Angular) — `frontend/`
| File | Responsibility |
|---|---|
| `app.config.ts` | **Zoneless** change detection, router, HttpClient providers |
| `pages/attendee.component.ts` | Question submission; shows new-topic vs. merged result |
| `pages/moderator.component.ts` | Live ranked board; draft generation; **citation links** |
| `pages/admin.component.ts` | **Setup**: upload annual report + question bank |
| `services/api.service.ts` | REST calls + `parseCitation()` (builds page-anchored PDF links) |
| `services/board.service.ts` | STOMP/SockJS subscription to `/topic/board` (signals) |

### 7.2 Backend (Spring Boot) — `backend/`
| Class | Responsibility |
|---|---|
| `QuestionService` | Orchestrates persist → AI cluster → broadcast; bulk ingest |
| `AiClient` | WebClient over the Python service (ingest, draft, upload, fetch PDF) |
| `controller/AdminController` | Upload annual report + question bank (moderator) |
| `controller/SourceController` | Serve source PDFs publicly (citation-link target) |
| `WebSocketConfig` | STOMP broker on `/topic`, endpoint `/ws` |
| `BoardRefreshScheduler` | Periodic board re-broadcast + keep-warm ping |
| `SecurityConfig` / `JwtService` / `JwtAuthFilter` | JWT auth + role rules |
| `Question` / `QuestionRepository` | JPA persistence |

### 7.3 AI Service (Python) — `ai-service/`
| Module | Responsibility |
|---|---|
| `main.py` | FastAPI endpoints (ingest, draft, clusters, knowledge upload/serve) |
| `embeddings.py` | Local sentence-transformer embeddings (LangChain-compatible) |
| `clustering.py` | **Online nearest-centroid clustering** (core algorithm) |
| `rag.py` | FAISS knowledge base + LangChain draft chain + runtime PDF ingest/serve |
| `llm.py` | Provider factory — Groq / Gemini / Azure, one-line swap |
| `consumer.py` | Optional Redis Streams worker (production-scale ingest) |

---

## 8. Core Algorithm — Online Semantic Clustering

Batch clustering (e.g., k-means) needs all points up front and a fixed number of clusters `k`.
A live question stream has neither — questions arrive one at a time and the number of distinct
topics is unknown. AGM Sentinel therefore uses **incremental nearest-centroid clustering**:

```
for each incoming question q:
    v ← embed(q)                              # 384-dim, L2-normalized
    (c*, sim*) ← argmax over clusters c of cosine(v, centroid(c))
    if sim* ≥ THRESHOLD:                       # default 0.78
        fold q into c*:
            centroid(c*) ← normalize( (centroid(c*)·n + v) / (n+1) )   # running mean
            size(c*)     ← n + 1
            weight_sum(c*) += weight(q)
    else:
        create new cluster with centroid = v, size = 1
```

**Properties**
- **O(number of clusters)** per question → real-time.
- **No `k` required** — topics emerge organically.
- **Incremental centroid** (running mean) keeps each cluster's center accurate as it grows.
- Cosine on normalized vectors = semantic similarity, so paraphrases merge; distinct
  questions split.

**Ranking:** `priority_score = log(1 + size) × (1 + weight_sum)` — combining how many people
asked (log-damped so one topic can't dominate purely on volume) with how much equity those
askers hold.

---

## 9. RAG Pipeline — Grounded Answer Drafting

To keep draft answers factual, the system uses **Retrieval-Augmented Generation** over the
company's annual report:

1. **Ingest:** PDFs are split into ~1000-char chunks, embedded locally, and indexed in **FAISS**.
   This happens at **startup** (from `ai-service/knowledge/`) *and* at **runtime** when a
   moderator uploads a report via the Setup page (`add_pdf` extends the live index).
2. **Retrieve:** for a cluster's representative question, fetch the top-k (default 4) most
   similar chunks.
3. **Augment:** inject those chunks as context into a strict LangChain prompt that forbids
   inventing figures and requires escalation if the answer isn't in the report.
4. **Generate:** a free LLM (Groq/Gemini) produces a concise (<120-word) answer.
5. **Cite:** each answer returns source citations (`filename p.N` + snippet). The draft **and its
   citations are cached on the cluster**, so they ride along on the next board broadcast and
   appear for every moderator.

**Citation links:** in the UI each source is a clickable link. `parseCitation()` turns
`"report.pdf p.3"` into `…/api/source/report.pdf#page=3`; the browser's PDF viewer opens the
document at that page. The backend `SourceController` proxies the PDF from the AI service over a
**public** route (a new tab carries no JWT), with path-traversal guarded by basenaming.

Because the LLM is accessed through LangChain's provider abstraction (`llm.py`), switching to
**Azure OpenAI** later is a one-line change — the RAG logic is untouched.

---

## 10. Database Design

`ai-service/db/init.sql` (PostgreSQL + pgvector):

**`questions`**
| Column | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| text | TEXT | the raw question |
| attendee_id | TEXT | submitter |
| weight | REAL | shareholder equity weight (0–1) |
| cluster_id | UUID | assigned cluster |
| embedding | vector(384) | all-MiniLM-L6-v2 dimension |
| created_at | TIMESTAMPTZ | |

**`clusters`**
| Column | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| representative_question | TEXT | first/most central question |
| centroid | vector(384) | running-mean center |
| size | INT | member count |
| weight_sum | REAL | Σ shareholder weights |
| priority_score | REAL | ranking value |
| draft_answer | TEXT | cached RAG draft |
| created_at / updated_at | TIMESTAMPTZ | |

An **IVFFlat** index on `clusters.centroid` (`vector_cosine_ops`) accelerates nearest-centroid
lookups at scale.

---

## 11. API Reference

### Spring Boot (backend)
| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | public | Issue a demo JWT `{username, role}` |
| POST | `/api/questions` | attendee/mod | Submit a question → returns cluster assignment |
| GET | `/api/clusters?limit=N` | moderator | Current ranked board (includes citations) |
| POST | `/api/clusters/{id}/draft` | moderator | Trigger RAG draft for a cluster |
| GET | `/api/admin/knowledge` | moderator | Knowledge-base status (sources, chunk count) |
| POST | `/api/admin/knowledge` | moderator | Upload annual-report PDF (indexed into RAG) |
| POST | `/api/admin/question-bank` | moderator | Upload question bank (bulk-ingested) |
| GET | `/api/source/{filename}` | public | Serve a source PDF (citation-link target) |
| WS | `/ws` → subscribe `/topic/board` | — | Live board push |

### Python AI service
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness / keep-warm |
| POST | `/ingest` | Embed + cluster one question |
| POST | `/draft` | RAG draft for a cluster (returns answer + citations) |
| GET | `/clusters?limit=N` | Ranked cluster board |
| GET | `/knowledge/status` | Indexed sources + chunk count |
| POST | `/knowledge/upload` | Index an uploaded PDF at runtime |
| GET | `/knowledge/files/{filename}` | Serve a source PDF |

**Example — deduplication in action**
```bash
POST /ingest {"question_id":"1","text":"When will the dividend be paid?", ...}
POST /ingest {"question_id":"2","text":"What is the date for dividend payout?", ...}
GET  /clusters
# → ONE cluster of size 2 (the two paraphrases merged)
```

---

## 12. Data Flow

1. Attendee submits a question in the Angular app → `POST /api/questions` (with JWT).
2. Spring Boot persists the question, calls the AI service `POST /ingest`.
3. AI service embeds the text, runs online clustering, returns the cluster assignment.
4. Spring Boot stores the `cluster_id`; if the cluster just turned "hot" (≥3 asks), it triggers
   `POST /draft` for a grounded answer.
5. Spring Boot broadcasts the refreshed ranked board to `/topic/board`.
6. All subscribed moderator clients update in real time over WebSocket.

**Setup flows (moderator):**
7. **Upload annual report** → backend forwards the PDF to the AI service, which chunks, embeds,
   and adds it to the live FAISS index (no restart).
8. **Upload question bank** → backend splits the file into lines and bulk-ingests each through the
   clustering pipeline, broadcasting the board once at the end.
9. **Click a citation** → opens `/api/source/{file}#page=N` in a new tab; the backend proxies the
   PDF and the browser jumps to the cited page.

> Full step-by-step sequence diagrams for every flow are in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 13. Security Design

- **Stateless JWT auth** (JJWT, HMAC-SHA) with role claims.
- **Role-based access:** attendees may submit questions; only **moderators** may read the board,
  trigger drafts, or use the Setup uploads (`/api/admin/**`). The `/api/source/**` PDF route is
  intentionally **public** (opened in a new browser tab, which sends no JWT); path traversal is
  blocked by basenaming the filename.
- **CORS** restricted (configurable to the Vercel domain in production).
- **CSRF disabled** (stateless API), **sessions stateless**.
- **Input validation** via Bean Validation (`@NotBlank`, size limits) on submissions.
- Prompt hardening in RAG: the model is instructed to answer only from retrieved context and
  never fabricate figures — reducing hallucination risk on financial data.

---

## 14. Deployment (Free Tier)

Full step-by-step in `DEPLOY.md`. Summary — **no credit card on any service**:

| Layer | Free host | Notes |
|---|---|---|
| Frontend | **Vercel** | Static hosting, SPA rewrites via `vercel.json` |
| Backend | **Koyeb** (or Render) | Dockerfile build; idle-sleep mitigated by UptimeRobot |
| AI service | **Hugging Face Spaces** (Docker) | Embedding model pre-baked into image |
| LLM | **Groq / Gemini** | Free API keys, email login only |
| Database | **Neon** | Postgres + pgvector |
| Redis (optional) | **Upstash** | Redis Streams |
| Keep-warm | **UptimeRobot** | Prevents free-tier cold sleeps |

A `docker-compose.yml` runs the entire system locally with one command (requires Docker).

---

## 15. Build & Verification Results

All three services were built, run, and verified locally end to end:

| Service | Command | Result |
|---|---|---|
| Backend (Spring Boot) | `mvn clean package` | ✅ `backend-1.0.0.jar` (~72 MB) produced |
| Frontend (Angular 22) | `npm run build` | ✅ Production bundle ~366 KB (98 KB gzipped) |
| AI service (Python) | venv install + `py_compile` | ✅ All modules import & compile |

End-to-end runtime verification (all three services live):
- Question submission → **semantic dedup** confirmed (paraphrases merged into one cluster).
- Question-bank upload → `{"received":5,"ingested":5}`.
- Annual-report upload → indexed into FAISS at runtime (`chunks_indexed` increased).
- Draft answer → grounded response with **4 citations** to specific report pages.
- Citation link → `/api/source/...pdf` returns a valid PDF (`%PDF-1.4`, `application/pdf`, 200).

Issues found and fixed during build/upgrade:
- Aligned `pom.xml` to **Java 17** (matching the installed JDK).
- Upgraded the frontend to **Angular 22** (zoneless + signals); required **Node ≥ 24.15**.
- Fixed a strict-TypeScript typing error and a `sockjs-client` `global` shim (blank-screen bug).
- Local run uses an embedded **H2** profile (no Postgres) and a **keyless** AI service
  (clustering works without an LLM key; only drafting needs one).

---

## 16. Future Enhancements

- **Sentiment & urgency scoring** to refine ranking beyond size × weight.
- **Real-time streaming drafts** (token streaming to the moderator UI).
- **Shareholder identity federation** (OAuth2 + MFA) replacing demo JWT.
- **Kafka** ingest path for true 10k+/sec throughput and replay.
- **Multi-language** question support (multilingual embedding model).
- **Analytics dashboard** — post-meeting report of top concerns and answer coverage.
- **PDF.js viewer** with exact in-page chunk highlighting (beyond page-level jump).
- **De-duplicate report re-uploads** (currently re-uploading the same PDF doubles its chunks).
- **Tune the clustering threshold** live from the Setup page.

---

## 17. Conclusion

AGM Sentinel demonstrates a production-shaped, polyglot microservice system that solves a
genuine, non-trivial problem: making sense of a live flood of questions at scale. It combines
real-time messaging, semantic machine learning, and retrieval-augmented generation — with each
technology chosen for a concrete reason. The design is cloud-native yet runs at zero cost,
proving that strong system design does not require expensive infrastructure. The LLM-agnostic
AI layer means the same architecture scales seamlessly from free Groq/Gemini to enterprise
Azure OpenAI with only configuration changes.

---

**Related documents**
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it works, with per-flow sequence diagrams
- [RUN_LOCAL.md](RUN_LOCAL.md) — run it locally (exact commands)
- [DEPLOY.md](DEPLOY.md) — free-tier deployment
- [README.md](README.md) — quick overview

*Document reflects the current codebase, including the Setup uploads and cited-answer features.*
