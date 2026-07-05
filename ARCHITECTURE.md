# AGM Sentinel — Architecture & Flow Guide

A guide to **how the application works**: the pieces, how they talk, and the exact flow of
every major action. Read this to understand the system end to end.

> For a formal project report see [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md).
> For running it locally see [RUN_LOCAL.md](RUN_LOCAL.md).

---

## Table of Contents
1. [What the app does (in one minute)](#1-what-the-app-does-in-one-minute)
2. [The three services](#2-the-three-services)
3. [High-level architecture](#3-high-level-architecture)
4. [Why it's split this way](#4-why-its-split-this-way)
5. [Component map (every file's job)](#5-component-map-every-files-job)
6. [Flow 1 — Ask a question → live board](#flow-1--ask-a-question--live-board)
7. [Flow 2 — Draft a grounded answer (RAG) + citations](#flow-2--draft-a-grounded-answer-rag--citations)
8. [Flow 3 — Click a source → open the PDF at the page](#flow-3--click-a-source--open-the-pdf-at-the-page)
9. [Flow 4 — Upload the annual report](#flow-4--upload-the-annual-report)
10. [Flow 5 — Upload a question bank](#flow-5--upload-a-question-bank)
11. [The clustering algorithm](#6-the-clustering-algorithm)
12. [Data model](#7-data-model)
13. [Security model](#8-security-model)
14. [API surface (quick reference)](#9-api-surface-quick-reference)

---

## 1. What the app does (in one minute)

During a virtual **Annual General Meeting (AGM)**, thousands of shareholders type questions at
once — most are duplicates worded differently. AGM Sentinel:

1. **Collects** questions in real time.
2. **Clusters** them by meaning, so "When's the dividend?" and "What date is the payout?" become
   **one** topic with a count.
3. **Ranks** topics by how many people asked × their shareholding.
4. **Drafts** a grounded answer for a topic using the company's annual report (RAG), with
   **clickable citations** back to the source pages.
5. Shows moderators a **live board** that updates over WebSocket.

Moderators can also **upload** the annual report and a question bank from a **Setup** page.

---

## 2. The three services

| Service | Language / framework | Port (local) | Responsibility |
|---|---|---|---|
| **frontend** | Angular 22 (zoneless, signals) | 4200 | UI: ask, moderator board, setup |
| **backend** | Spring Boot (Java 17) | 8080 | Auth, orchestration, WebSocket, persistence, proxy |
| **ai-service** | Python (FastAPI + LangChain) | 8000 | Embeddings, clustering, RAG, PDF serving |

The frontend only ever talks to the **backend**. The backend talks to the **ai-service**.
The ai-service owns all the "AI math" (vectors, clustering, LLM calls).

---

## 3. High-level architecture

```
   Browser (Angular 22 SPA, port 4200)
        │   REST (JSON) + WebSocket (STOMP)
        ▼
   Spring Boot backend (port 8080)
        │            ▲
        │ HTTP       │ STOMP push  /topic/board
        ▼            │
   Python AI service (port 8000)         Spring Boot also:
        • /ingest    embed + cluster       • issues JWTs
        • /draft     RAG answer + cites     • persists questions (H2/Postgres)
        • /clusters  ranked board           • proxies source PDFs
        • /knowledge upload + serve PDF
        │
        ├── sentence-transformers  (local embeddings, no API)
        ├── FAISS index            (annual-report chunks)
        └── Groq / Gemini LLM       (draft generation)
```

Data stores:
- **Questions** → H2 (local) or Postgres (prod), via the backend.
- **Vectors / cluster centroids** → in-memory in the ai-service (FAISS + a dict of clusters).

---

## 4. Why it's split this way

- **Java (backend)** is where enterprises put transactional business logic, auth, and real-time
  fan-out. It's the secure front door.
- **Python (ai-service)** is where the ML/LLM ecosystem lives (sentence-transformers, FAISS,
  LangChain). Keeping it separate lets the AI scale and deploy independently.
- **Angular (frontend)** renders the live board and the forms.

This "polyglot microservice" split mirrors how real AI-enabled products are built, and each
boundary is a plain HTTP call, so any service can be replaced without touching the others.

---

## 5. Component map (every file's job)

### frontend (`frontend/src/app`)
| File | Job |
|---|---|
| `app.component.ts` | Shell + nav (Ask / Board / Setup) |
| `app.config.ts` | **Zoneless** change detection, router, HttpClient |
| `app.routes.ts` | Routes: `/ask`, `/board`, `/setup` |
| `pages/attendee.component.ts` | Submit a question; shows new-vs-merged result |
| `pages/moderator.component.ts` | Live board; draft button; **citation links** |
| `pages/admin.component.ts` | **Setup**: upload report + question bank |
| `services/api.service.ts` | All REST calls + `parseCitation()` link builder |
| `services/board.service.ts` | STOMP/WebSocket board subscription (signals) |

### backend (`backend/src/main/java/com/agmsentinel`)
| Class | Job |
|---|---|
| `controller/AuthController` | Issue demo JWT (`/api/auth/login`) |
| `controller/QuestionController` | Attendee submits (`POST /api/questions`) |
| `controller/ClusterController` | Board + draft (`/api/clusters…`) |
| `controller/AdminController` | Upload report + question bank (`/api/admin…`) |
| `controller/SourceController` | Serve source PDFs publicly (`/api/source/{file}`) |
| `service/QuestionService` | Orchestrates ingest → cluster → broadcast; bulk ingest |
| `service/AiClient` | HTTP client to the Python service |
| `service/BoardRefreshScheduler` | Periodic board re-broadcast + keep-warm |
| `config/WebSocketConfig` | STOMP broker (`/topic`, endpoint `/ws`) |
| `config/SecurityConfig` + `security/*` | JWT auth + role rules |
| `model/Question` + `repository/*` | Persistence |

### ai-service (`ai-service/app`)
| Module | Job |
|---|---|
| `main.py` | FastAPI endpoints |
| `embeddings.py` | Local sentence-transformer embeddings |
| `clustering.py` | **Online nearest-centroid clustering** |
| `rag.py` | FAISS knowledge base + LangChain draft chain + PDF resolve |
| `llm.py` | LLM provider factory (Groq / Gemini / Azure) |
| `consumer.py` | Optional Redis Streams worker (scale path) |

---

## Flow 1 — Ask a question → live board

What happens when an attendee submits a question.

```
Attendee (browser)        Backend (8080)                 AI service (8000)
     │  POST /api/questions     │                              │
     │  {text, attendeeId} +JWT │                              │
     │─────────────────────────►│                              │
     │                          │  save Question (H2)          │
     │                          │  POST /ingest {text,weight}  │
     │                          │─────────────────────────────►│
     │                          │                   embed(text) → 384-dim vector
     │                          │                   nearest cluster? merge : new
     │                          │  ◄─── {cluster_id,size,is_new,similarity}
     │                          │  store cluster_id on Question │
     │  ◄──── IngestResult ─────│                              │
     │                          │  GET /clusters (ranked board)│
     │                          │─────────────────────────────►│
     │                          │  ◄──── [ClusterView...] ─────│
     │                          │  STOMP send → /topic/board    │
     │                          │                              │
Moderator board (subscribed to /topic/board) receives the update and re-renders live.
```

Key points:
- The attendee's POST returns immediately with *their* cluster assignment.
- Separately, the backend pushes the **whole ranked board** to every moderator over WebSocket.
- Signals in `board.service.ts` make the Angular view update with no zone.js.

---

## Flow 2 — Draft a grounded answer (RAG) + citations

What happens when a moderator clicks **Draft answer** (or a cluster auto-drafts when it gets hot).

```
Moderator            Backend                    AI service (rag.py)
   │ POST /api/clusters/{id}/draft │                    │
   │──────────────────────────────►│  POST /draft       │
   │                               │───────────────────►│
   │                               │        embed(question)
   │                               │        FAISS: top-k similar report chunks
   │                               │        build prompt = chunks + question
   │                               │        LLM (Groq) → concise answer
   │                               │  ◄── {answer, citations:[{source,snippet}]}
   │                               │   cache answer+citations ON the cluster
   │  ◄──── DraftResult ───────────│                    │
   │                               │  broadcast board (now includes citations)
```

- **RAG = Retrieval-Augmented Generation**: the LLM only sees retrieved report passages, so it
  can't invent figures; each answer carries **citations** (`filename p.N` + snippet).
- The draft + citations are **cached on the cluster**, so they ride along on the next board push
  and appear for every moderator, not just the one who clicked.

---

## Flow 3 — Click a source → open the PDF at the page

How a citation becomes a clickable link that opens the report at the right page.

```
Board shows:  "Sources: nimbus-annual-report-2024.pdf p.2"   (link)
      │  parseCitation("...pdf p.2")  →  /api/source/...pdf#page=2
      ▼  (new browser tab)
   Backend  GET /api/source/{file}      ── PUBLIC (no auth: a new tab sends no token) ──
      │  GET /knowledge/files/{file}
      ▼
   AI service  → returns the PDF bytes (basenamed → no path traversal)
      │
   Browser PDF viewer opens the file and jumps to #page=2
```

- `parseCitation()` (in `api.service.ts`) splits `"file.pdf p.2"` into filename + page and builds
  the URL with a `#page=N` anchor.
- The source route is **public** on purpose: the PDF opens in a new tab, which won't carry the
  JWT header, and an annual report is a public disclosure anyway.
- **Limitation:** browsers can jump to a *page* (`#page=N`) but can't highlight an exact span;
  the snippet is shown as a tooltip so you know what to look for.

---

## Flow 4 — Upload the annual report

Setup page → the report becomes the RAG knowledge base at runtime (no restart).

```
Moderator (Setup)     Backend                       AI service (rag.py)
   │ POST /api/admin/knowledge (multipart PDF) +JWT │
   │───────────────────────────►│  POST /knowledge/upload (multipart)
   │                            │────────────────────────►│
   │                            │      read PDF bytes
   │                            │      split pages → ~1000-char chunks
   │                            │      embed chunks (local model)
   │                            │      add to FAISS index (rebuild if first)
   │                            │      save PDF into knowledge/ (so links can serve it)
   │  ◄── {filename, chunks_indexed, ready} ──────────────│
```

Now **Draft answer** retrieves from the uploaded report, and citation links can open it.

---

## Flow 5 — Upload a question bank

Setup page → bulk-ingest a list of questions, clustered like live ones.

```
Moderator (Setup)     Backend (QuestionService.submitBulk)      AI service
   │ POST /api/admin/question-bank (.txt/.csv) +JWT │
   │───────────────────────────►│  split into lines (skip blanks/header)
   │                            │  for each line:  POST /ingest → cluster it
   │                            │  broadcast board ONCE at the end
   │  ◄── {received, ingested} ─│
```

- One question per line. Near-duplicate lines collapse into the same cluster automatically.
- The board is pushed once (not per line) to avoid a flood of WebSocket updates.

---

## 6. The clustering algorithm

Live streams can't use batch k-means (unknown number of topics, one-at-a-time arrival). So we use
**incremental nearest-centroid clustering** (`clustering.py`):

```
for each incoming question:
    v = embed(question)                        # 384-dim, normalized
    find existing cluster c with max cosine(v, centroid(c))
    if similarity >= THRESHOLD (0.78):
        merge: centroid = running_mean(centroid, v); size += 1; weight_sum += weight
    else:
        create a new cluster with centroid = v
```

- **O(#clusters)** per question → real-time.
- No fixed `k` — topics emerge on their own.
- **Ranking:** `priority = log(1 + size) × (1 + weight_sum)` — volume (log-damped) × shareholding.

---

## 7. Data model

**Persisted (H2 local / Postgres prod), owned by the backend:**
- `questions(id, text, attendee_id, weight, cluster_id, created_at)`

**In-memory, owned by the ai-service:**
- FAISS index of annual-report chunks (`page_content`, `source = "file.pdf p.N"`).
- `clusters{ id → centroid, representative_question, size, weight_sum, draft, citations }`.

The backend stores the durable *record* of each question; the ai-service holds the *vector math*
and live cluster state. They're linked by `cluster_id`.

---

## 8. Security model

- **JWT** (stateless) with a `role` claim: `ATTENDEE` or `MODERATOR`.
- Route rules (`SecurityConfig`):
  - `/api/auth/**`, `/api/source/**`, `/ws/**`, health → **public**
  - `/api/questions/**` → attendee or moderator
  - `/api/clusters/**`, `/api/admin/**` → **moderator only**
- `/api/source/**` is intentionally public (PDF opens in a new tab without a token).
- Input validation on submissions; RAG prompt forbids inventing figures.

---

## 9. API surface (quick reference)

### Backend (browser → backend)
| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | public | Get a demo JWT |
| POST | `/api/questions` | attendee/mod | Submit a question |
| GET | `/api/clusters` | moderator | Ranked board (with citations) |
| POST | `/api/clusters/{id}/draft` | moderator | Draft a grounded answer |
| GET | `/api/admin/knowledge` | moderator | Knowledge-base status |
| POST | `/api/admin/knowledge` | moderator | Upload annual report (PDF) |
| POST | `/api/admin/question-bank` | moderator | Upload question bank |
| GET | `/api/source/{filename}` | public | Serve a source PDF (citation link) |
| WS | `/ws` → `/topic/board` | — | Live board push |

### AI service (backend → ai-service)
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| POST | `/ingest` | Embed + cluster one question |
| POST | `/draft` | RAG answer + citations |
| GET | `/clusters` | Ranked board |
| GET | `/knowledge/status` | Indexed sources + chunk count |
| POST | `/knowledge/upload` | Index an uploaded PDF |
| GET | `/knowledge/files/{filename}` | Serve a source PDF |

---

*This document reflects the current codebase, including the Setup uploads and citation-link
features. Diagrams are ASCII so they render anywhere (GitHub, editors, PDF exports).*
