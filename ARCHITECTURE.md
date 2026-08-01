# VIRTUAL MEETING Sentinel — Architecture & Flow Guide

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
11. [Flow 6 — Upload a recording → watch it on demand](#flow-6--upload-a-recording--watch-it-on-demand)
12. [The clustering algorithm](#6-the-clustering-algorithm)
13. [Data model](#7-data-model)
14. [Security model](#8-security-model)
15. [API surface (quick reference)](#9-api-surface-quick-reference)

---

## 1. What the app does (in one minute)

During a virtual **Annual General Meeting (VIRTUAL MEETING)**, thousands of shareholders type questions at
once — most are duplicates worded differently. VIRTUAL MEETING Sentinel:

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

| Service        | Language / framework           | Port (local) | Responsibility                                     |
| -------------- | ------------------------------ | ------------ | -------------------------------------------------- |
| **frontend**   | Angular 22 (zoneless, signals) | 4200         | UI: ask, moderator board, setup                    |
| **backend**    | Spring Boot (Java 17)          | 8080         | Auth, orchestration, WebSocket, persistence, proxy |
| **ai-service** | Python (FastAPI + LangChain)   | 8000         | Embeddings, clustering, RAG, PDF serving           |

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

| File                           | Job                                               |
| ------------------------------ | ------------------------------------------------- |
| `app.component.ts`                    | Shell + nav (Ask / Board / Setup / Recordings)             |
| `app.config.ts`                       | **Zoneless** change detection, router, HttpClient          |
| `app.routes.ts`                       | Routes: `/ask`, `/board`, `/setup`, `/recordings`, `/videos` |
| `pages/attendee.component.ts`         | Submit a question; shows new-vs-merged result              |
| `pages/moderator.component.ts`        | Live board; draft button; **citation links**               |
| `pages/admin.component.ts`            | **Setup**: upload report + question bank                   |
| `pages/videos.component.ts`           | Recordings library + segment inspector (lazy-loaded)       |
| `pages/video-admin.component.ts`      | Upload / manage recordings (lazy-loaded)                   |
| `components/video-player.component.ts`| **hls.js player**: quality, speed, seek preview, PiP, stats |
| `services/api.service.ts`             | All REST calls + `parseCitation()` link builder            |
| `services/board.service.ts`           | STOMP/WebSocket board subscription (signals)               |
| `services/video.service.ts`           | Video API client + upload progress stream                  |

### backend (`backend/src/main/java/com/agmsentinel`)

| Class                                  | Job                                                    |
| -------------------------------------- | ------------------------------------------------------ |
| `controller/AuthController`            | Issue demo JWT (`/api/auth/login`)                     |
| `controller/QuestionController`        | Attendee submits (`POST /api/questions/submit-question`)               |
| `controller/ClusterController`         | Board + draft (`/api/clusters/…`)                       |
| `controller/AdminController`           | Upload report + question bank (`/api/admin…`)          |
| `controller/SourceController`          | Serve source PDFs publicly (`/api/source/{file}`)      |
| `service/QuestionService`              | Orchestrates ingest → cluster → broadcast; bulk ingest |
| `service/AiClient`                     | HTTP client to the Python service                      |
| `service/BoardRefreshScheduler`        | Periodic board re-broadcast + keep-warm                |
| `config/WebSocketConfig`               | STOMP broker (`/topic`, endpoint `/ws`)                |
| `config/SecurityConfig` + `security/*` | JWT auth + role rules                                  |
| `model/Question` + `repository/*`      | Persistence                                            |

**Video library** (see [VIDEO_LIBRARY.md](VIDEO_LIBRARY.md) for the full design):

| Class                              | Job                                                             |
| ---------------------------------- | --------------------------------------------------------------- |
| `controller/VideoAdminController`  | Upload + manage recordings (`/api/admin/videos/…`)               |
| `controller/VideoController`       | Catalogue, segment index, media bytes, **manifest rewriting**, Range |
| `service/VideoLibraryService`      | Upload, lifecycle, the short state-transition transactions       |
| `service/VideoProcessingWorker`    | The `@Async` transcode job (separate bean so the proxy applies)  |
| `service/VideoTranscodeService`    | ffprobe + the HLS ladder + poster + seek filmstrip              |
| `service/VideoStorageService`      | The NAS: path-traversal boundary + bounded range reads          |
| `service/VideoMediaStore`          | Reads/writes media from **either** backend (filesystem or DB)   |
| `service/VideoUrlFactory`          | Builds ticketed media URLs                                      |
| `security/PlaybackTicketService`   | Short-lived, video-scoped playback tickets                      |
| `config/VideoProperties` / `VideoAsyncConfig` | `video.*` config + the transcode pool                |
| `model/Video`, `VideoRendition`, `VideoSegment` | Catalogue + ladder + **segment index**        |

### ai-service (`ai-service/app`)

| Module          | Job                                                        |
| --------------- | ---------------------------------------------------------- |
| `main.py`       | FastAPI endpoints                                          |
| `embeddings.py` | Local sentence-transformer embeddings                      |
| `clustering.py` | **Online nearest-centroid clustering**                     |
| `rag.py`        | FAISS knowledge base + LangChain draft chain + PDF resolve |
| `llm.py`        | LLM provider factory (Groq / Gemini / Azure)               |
| `consumer.py`   | Optional Redis Streams worker (scale path)                 |

---

## Flow 1 — Ask a question → live board

What happens when an attendee submits a question.

```
Attendee (browser)        Backend (8080)                 AI service (8000)
     │  POST /api/questions/submit-question     │                              │
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

- The attendee's POST returns immediately with _their_ cluster assignment.
- Separately, the backend pushes the **whole ranked board** to every moderator over WebSocket.
- Signals in `board.service.ts` make the Angular view update with no zone.js.

---

## Flow 2 — Draft a grounded answer (RAG) + citations

What happens when a moderator clicks **Draft answer** (or a cluster auto-drafts when it gets hot).

```
Moderator            Backend                    AI service (rag.py)
   │ POST /api/clusters/draft-answer │                    │
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
- **Limitation:** browsers can jump to a _page_ (`#page=N`) but can't highlight an exact span;
  the snippet is shown as a tooltip so you know what to look for.

---

## Flow 4 — Upload the annual report

Setup page → the report becomes the RAG knowledge base at runtime (no restart).

```
Moderator (Setup)     Backend                       AI service (rag.py)
   │ POST /api/admin/upload-annual-report (multipart PDF) +JWT │
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
   │ POST /api/admin/upload-question-bank (.txt/.csv) +JWT │
   │───────────────────────────►│  split into lines (skip blanks/header)
   │                            │  for each line:  POST /ingest → cluster it
   │                            │  broadcast board ONCE at the end
   │  ◄── {received, ingested} ─│
```

- One question per line. Near-duplicate lines collapse into the same cluster automatically.
- The board is pushed once (not per line) to avoid a flood of WebSocket updates.

---

## Flow 6 — Upload a recording → watch it on demand

Video library page → the recording is stored on the NAS and cut into short segments so members can
stream it without downloading it. Full design in **[VIDEO_LIBRARY.md](VIDEO_LIBRARY.md)**.

```
Moderator (/videos)        Backend                              NAS         Postgres
   │ POST /api/admin/videos/upload-video (multipart, up to 2 GB) +JWT
   │────────────────────────►│ validate extension + size
   │                         │ save row, stream bytes ─────────► source.mp4
   │                         │ status = PROCESSING ───────────────────────► videos
   │ ◄── 200 {PROCESSING} ───│   (returns immediately — a transcode takes minutes)
   │                         │ publishEvent ─── after commit ──┐
   │                         │                                 ▼
   │                         │            VideoProcessingWorker (@Async pool)
   │                         │              ffprobe → duration, w×h, fps ──► videos
   │                         │              ffmpeg  → hls/{720p,480p,360p}/seg_*.ts
   │  POST /api/admin/videos/video-details  (poll)      progress 0…100  ──────────► videos
   │ ◄── {PROCESSING, 45%} ──│              poster + filmstrip
   │                         │              read playlists → segment index ─► video_renditions
   │ ◄── {READY, 100%} ──────│                                              └► video_segments

Member (/recordings)
   │ POST /api/videos/list-library ───────►│ catalogue + a signed playback ticket per video
   │ GET …/master.m3u8?t= ──►│ variant list, URIs rewritten to carry the ticket
   │ GET …/r/720p/index.m3u8?t= ► segment list, ticket appended to each segment URI
   │ GET …/r/720p/seg_00007.ts?t= ► ONE ~6s slice   ← repeated as playback advances
```

Why this shape:

- **The POST doesn't wait for the transcode.** Holding the request open for minutes would time out;
  the UI polls for `progressPercent` instead.
- **The worker starts after commit**, so it can't read a row its own connection can't see yet.
- **The worker is a separate bean.** `@Async`/`@Transactional` are proxy-based — a service calling
  its own annotated method would get neither, and the "async" transcode would run inline on the HTTP
  thread.
- **Manifests are rewritten on the way out.** Relative playlist URIs are resolved without the query
  string, so without the rewrite the player would drop the ticket and the next request would 403.
- **Media URLs use a playback ticket, not the session JWT** — the browser's media stack (`<video>`,
  hls.js, `<img>`) cannot set an `Authorization` header, and a ticket is scoped to one video and
  short-lived rather than granting the whole API.

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
- `videos(id, title, status, delivery_mode, storage_mode, progress_percent, duration, w×h, …)`
  → `video_renditions(name, resolution, bitrates, playlist_rel)`
  → `video_segments(seq, filename, duration_seconds, **start_seconds**, byte_size)`
- `video_assets(video_id, rel_path, data)` — media bytes, only when `storage_mode = DATABASE`

`start_seconds` is what turns "seek to 21:30" into an indexed lookup for one segment instead of a
scan. Media bytes normally live on the NAS share and the tables hold metadata only; `database`
storage mode puts them in `video_assets` instead, for hosts with no persistent volume.

**In-memory, owned by the ai-service:**

- FAISS index of annual-report chunks (`page_content`, `source = "file.pdf p.N"`).
- `clusters{ id → centroid, representative_question, size, weight_sum, draft, citations }`.

The backend stores the durable _record_ of each question; the ai-service holds the _vector math_
and live cluster state. They're linked by `cluster_id`.

---

## 8. Security model

- **JWT** (stateless) with a `role` claim: `ATTENDEE` or `MODERATOR`.
- Route rules (`SecurityConfig`):
  - `/api/auth/**`, `/api/source/**`, `/ws/**`, health → **public**
  - `/api/questions/**` → attendee or moderator
  - `/api/clusters/**`, `/api/admin/**` → **moderator only**
  - `/api/videos/**` → any signed-in member; the **media** sub-routes (GET only) are permitted at the
    filter chain and authorised in code by a **playback ticket** (see below)
- `/api/source/**` is intentionally public (PDF opens in a new tab without a token).
- **Playback tickets** exist because the browser's media stack can't send headers. A ticket is signed,
  short-lived (6h default) and scoped to **one video id** — unlike the session JWT, which is
  long-lived and grants the whole API. A ticket for video A returns 403 on video B.
- **Path traversal** for media is contained in one place: `VideoStorageService.resolveWithin`
  normalises the client-supplied relative path and rejects anything escaping the video's own folder.
  Segment and rendition names are additionally regex-validated in the controller.
- Input validation on submissions; RAG prompt forbids inventing figures.

---

## 9. API surface (quick reference)

### Backend (browser → backend)

| Method | Path                       | Role         | Purpose                            |
| ------ | -------------------------- | ------------ | ---------------------------------- |
| POST   | `/api/auth/login`          | public       | Get a demo JWT                     |
| POST   | `/api/questions/submit-question`           | attendee/mod | Submit a question                  |
| POST   | `/api/clusters/question-board`            | moderator    | Ranked board (with citations)      |
| POST   | `/api/clusters/draft-answer` | moderator    | Draft a grounded answer            |
| POST   | `/api/admin/knowledge-status`     | moderator    | Knowledge-base status              |
| POST   | `/api/admin/upload-annual-report`     | moderator    | Upload annual report (PDF)         |
| POST   | `/api/admin/upload-question-bank` | moderator    | Upload question bank               |
| GET    | `/api/source/{filename}`   | public       | Serve a source PDF (citation link) |
| WS     | `/ws` → `/topic/board`     | —            | Live board push                    |

**Video library** (full table in [VIDEO_LIBRARY.md](VIDEO_LIBRARY.md#8-api-surface)):

| Method | Path                                   | Role      | Purpose                              |
| ------ | -------------------------------------- | --------- | ------------------------------------ |
| POST   | `/api/videos/list-library`                          | member    | Catalogue + a playback ticket each   |
| POST   | `/api/videos/list-segments`            | member    | The segment index                    |
| POST   | `/api/videos/find-segment-at` | member    | Which slice covers that second       |
| GET    | `/api/videos/{id}/master.m3u8?t=`      | ticket    | Variant list (rewritten)             |
| GET    | `/api/videos/{id}/r/{rung}/*.ts?t=`    | ticket    | One segment                          |
| GET    | `/api/videos/{id}/raw?t=`              | ticket    | Progressive fallback (`Range`-aware) |
| POST   | `/api/admin/videos/storage-status`             | moderator | NAS + ffmpeg health                  |
| POST   | `/api/admin/videos/upload-video`                    | moderator | Upload a recording (multipart)       |
| POST   | `/api/admin/videos/reprocess-video`     | moderator | Rebuild the ladder                   |
| POST   | `/api/admin/videos/delete-video`               | moderator | Remove rows + the NAS folder         |

### AI service (backend → ai-service)

| Method | Path                          | Purpose                       |
| ------ | ----------------------------- | ----------------------------- |
| GET    | `/health`                     | Liveness                      |
| POST   | `/ingest`                     | Embed + cluster one question  |
| POST   | `/draft`                      | RAG answer + citations        |
| GET    | `/clusters`                   | Ranked board                  |
| GET    | `/knowledge/status`           | Indexed sources + chunk count |
| POST   | `/knowledge/upload`           | Index an uploaded PDF         |
| GET    | `/knowledge/files/{filename}` | Serve a source PDF            |

---

_This document reflects the current codebase, including the Setup uploads and citation-link
features. Diagrams are ASCII so they render anywhere (GitHub, editors, PDF exports)._
