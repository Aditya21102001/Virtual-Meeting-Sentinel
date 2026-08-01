# VIRTUAL MEETING Sentinel — Project Documentation

**Live Crowd-Question Intelligence for Virtual Annual General Meetings**

|                |                                                                  |
| -------------- | ---------------------------------------------------------------- |
| **Author**     | Aditya Yadav                                                     |
| **Type**       | Full-Stack + Generative AI · Polyglot Microservices              |
| **Stack**      | Angular · Spring Boot (Java) · Python (FastAPI + LangChain)      |
| **Status**     | Built & verified locally; deployable on 100% free infrastructure |
| **Repository** | `agm-sentinel` (Angular / Spring Boot / Python monorepo)         |

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

VIRTUAL MEETING Sentinel is a real-time, AI-powered system that manages the flood of questions asked
during a large virtual **Annual General Meeting (VIRTUAL MEETING)**, town-hall, or webinar. When
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
real-time question stream. VIRTUAL MEETING Sentinel solves this specific, high-value problem.

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
- **Video library**: moderators upload the meeting recording to a NAS share; it is transcoded into
  an adaptive HLS ladder of ~6-second segments and indexed per segment, so members stream it on
  demand in a full-control player without downloading the file.
- Free-tier cloud deployment.

**Out of scope (future work)**

- Full shareholder identity federation (OAuth2/MFA) — stubbed via demo JWT.
- Horizontal auto-scaling and Kafka-grade throughput (Redis Streams path included as the
  production-scale option).
- Pixel-exact in-PDF highlighting of a cited chunk (native PDF viewers jump to a page only).
- Multi-tenant company onboarding UI.

---

## 5. Technology Stack

| Layer         | Technology                                                               | Rationale                                                  |
| ------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Frontend      | **Angular 22** (standalone, **zoneless**, signals), STOMP/SockJS         | Real-time board UI; current best-practice change detection |
| Core API      | **Spring Boot 3 / Java 17**                                              | Enterprise auth, WebSocket fan-out, transactional store    |
| AI Service    | **Python 3.11 · FastAPI · LangChain**                                    | The entire LLM/embeddings ecosystem lives in Python        |
| Embeddings    | **sentence-transformers** `all-MiniLM-L6-v2` (local)                     | Runs in-process; zero API cost                             |
| LLM           | **Groq (Llama 3.3 70B)** / **Google Gemini** — swappable to Azure OpenAI | Free inference; LangChain abstracts the provider           |
| Vector search | **FAISS** (knowledge base) + **pgvector** (persistence)                  | Fast similarity search without a paid vector DB            |
| Database      | **PostgreSQL + pgvector** (Neon free tier)                               | Relational + vector in one store                           |
| Messaging     | **Redis Streams** (Upstash free tier) — optional                         | Backpressure for high-volume ingest                        |
| Auth          | **JWT (JJWT)**                                                           | Stateless role separation                                  |
| Video storage | **NAS share** (SMB/UNC or mounted path), or PostgreSQL `bytea`           | Filesystem by default; database mode for hosts with no persistent volume |
| Video transcode | **FFmpeg** → HLS (H.264/AAC, MPEG-TS segments)                        | Adaptive-bitrate segmentation; the industry-standard tool   |
| Video playback | **hls.js** over Media Source Extensions                                 | HLS in every browser, plus a manual quality menu and metrics |

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

| File                           | Responsibility                                                  |
| ------------------------------ | --------------------------------------------------------------- |
| `app.config.ts`                | **Zoneless** change detection, router, HttpClient providers     |
| `pages/attendee.component.ts`  | Question submission; shows new-topic vs. merged result          |
| `pages/moderator.component.ts` | Live ranked board; draft generation; **citation links**         |
| `pages/admin.component.ts`     | **Setup**: upload annual report + question bank                 |
| `services/api.service.ts`      | REST calls + `parseCitation()` (builds page-anchored PDF links) |
| `services/board.service.ts`    | STOMP/SockJS subscription to `/topic/board` (signals)           |
| `pages/videos.component.ts`    | Recordings library + segment inspector (lazy-loaded route)      |
| `pages/video-admin.component.ts` | Upload / manage recordings, with live transcode progress       |
| `components/video-player.component.ts` | **hls.js player**: quality menu, speed, filmstrip seek preview, PiP, keyboard, stats |
| `services/video.service.ts`    | Video API client + upload-progress stream                       |

### 7.2 Backend (Spring Boot) — `backend/`

| Class                                             | Responsibility                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `QuestionService`                                 | Orchestrates persist → AI cluster → broadcast; bulk ingest           |
| `AiClient`                                        | WebClient over the Python service (ingest, draft, upload, fetch PDF) |
| `controller/AdminController`                      | Upload annual report + question bank (moderator)                     |
| `controller/SourceController`                     | Serve source PDFs publicly (citation-link target)                    |
| `WebSocketConfig`                                 | STOMP broker on `/topic`, endpoint `/ws`                             |
| `BoardRefreshScheduler`                           | Periodic board re-broadcast + keep-warm ping                         |
| `SecurityConfig` / `JwtService` / `JwtAuthFilter` | JWT auth + role rules                                                |
| `Question` / `QuestionRepository`                 | JPA persistence                                                      |
| `VideoLibraryService`                             | Video upload, lifecycle, short state-transition transactions          |
| `VideoProcessingWorker`                           | The `@Async` transcode job (separate bean, so the proxy applies)      |
| `VideoTranscodeService`                           | ffprobe + HLS ladder + poster + seek filmstrip                        |
| `VideoStorageService`                             | The NAS: path-traversal boundary + bounded ranged reads               |
| `PlaybackTicketService` / `VideoUrlFactory`        | Video-scoped playback tickets + ticketed URL construction             |
| `controller/VideoController`                      | Catalogue, segment index, media bytes, manifest rewriting, HTTP Range |
| `controller/VideoAdminController`                 | Upload + manage recordings (moderator)                                |
| `Video` / `VideoRendition` / `VideoSegment`        | Catalogue, ladder rungs, and the segment index                        |

### 7.3 AI Service (Python) — `ai-service/`

| Module          | Responsibility                                                          |
| --------------- | ----------------------------------------------------------------------- |
| `main.py`       | FastAPI endpoints (ingest, draft, clusters, knowledge upload/serve)     |
| `embeddings.py` | Local sentence-transformer embeddings (LangChain-compatible)            |
| `clustering.py` | **Online nearest-centroid clustering** (core algorithm)                 |
| `rag.py`        | FAISS knowledge base + LangChain draft chain + runtime PDF ingest/serve |
| `llm.py`        | Provider factory — Groq / Gemini / Azure, one-line swap                 |
| `consumer.py`   | Optional Redis Streams worker (production-scale ingest)                 |

---

## 8. Core Algorithm — Online Semantic Clustering

Batch clustering (e.g., k-means) needs all points up front and a fixed number of clusters `k`.
A live question stream has neither — questions arrive one at a time and the number of distinct
topics is unknown. VIRTUAL MEETING Sentinel therefore uses **incremental nearest-centroid clustering**:

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
   This happens at **startup** (from `ai-service/knowledge/`) _and_ at **runtime** when a
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

### Video library tables

`videos ──1:N──► video_renditions ──1:N──► video_segments`

**`videos`** — the catalogue row
| Column | Type | Notes |
|---|---|---|
| id | UUID (PK) | also names the folder on the NAS |
| title / description | TEXT | |
| original_filename / content_type / size_bytes | | as uploaded |
| storage_dir | TEXT | folder under the NAS root |
| source_rel / master_playlist_rel / poster_rel / sprite_rel | TEXT | paths **relative** to `storage_dir` |
| duration_seconds / width / height / frame_rate / has_audio | | from ffprobe |
| status | VARCHAR | UPLOADED → PROCESSING → READY / FAILED |
| delivery_mode | VARCHAR | HLS, or PROGRESSIVE when FFmpeg is absent |
| progress_percent / error_message | | drives the admin UI |

**`video_renditions`** — one row per ladder rung
| Column | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| video_id | UUID (FK, cascade) | |
| name | VARCHAR | `720p` — also the folder name |
| width / height / video_bitrate_kbps / audio_bitrate_kbps | INT | drives the quality menu |
| playlist_rel | TEXT | `hls/720p/index.m3u8` |

**`video_segments`** — the segment index
| Column | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| rendition_id | UUID (FK, cascade) | |
| seq | INT | ordinal, unique per rendition |
| filename | TEXT | `seg_00042.ts` |
| duration_seconds | DOUBLE | |
| **start_seconds** | DOUBLE | offset into the video |
| byte_size | BIGINT | |

**`video_assets`** — media bytes, only for videos with `storage_mode = 'DATABASE'`
| Column | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| video_id | UUID (FK, cascade) | |
| rel_path | TEXT | same relative addressing as the filesystem (`hls/720p/seg_00042.ts`) |
| content_type / byte_size | | |
| data | BYTEA | the bytes |

By default only **metadata** is stored and the media bytes live on the NAS; `database` storage mode
puts them in `video_assets` instead, for hosts with no persistent volume. A composite index on
`(rendition_id, seq)` orders the playlist, and `start_seconds` is what turns "seek to 21:30" into a
single indexed lookup for one segment rather than a scan:

```sql
SELECT * FROM video_segments
 WHERE rendition_id = ? AND start_seconds <= :pos AND :pos < start_seconds + duration_seconds
 ORDER BY start_seconds DESC LIMIT 1;
```

---

## 11. API Reference

### Spring Boot (backend)

| Method | Path                             | Role         | Purpose                                        |
| ------ | -------------------------------- | ------------ | ---------------------------------------------- |
| POST   | `/api/auth/login`                | public       | Issue a demo JWT `{username, role}`            |
| POST   | `/api/questions`                 | attendee/mod | Submit a question → returns cluster assignment |
| GET    | `/api/clusters?limit=N`          | moderator    | Current ranked board (includes citations)      |
| POST   | `/api/clusters/{id}/draft`       | moderator    | Trigger RAG draft for a cluster                |
| GET    | `/api/admin/knowledge`           | moderator    | Knowledge-base status (sources, chunk count)   |
| POST   | `/api/admin/knowledge`           | moderator    | Upload annual-report PDF (indexed into RAG)    |
| POST   | `/api/admin/question-bank`       | moderator    | Upload question bank (bulk-ingested)           |
| GET    | `/api/source/{filename}`         | public       | Serve a source PDF (citation-link target)      |
| WS     | `/ws` → subscribe `/topic/board` | —            | Live board push                                |

**Video library** — `member` = any signed-in user; `ticket` = authorised by a signed, video-scoped
playback ticket in the URL, because the browser's media stack cannot send an `Authorization` header.

| Method | Path                                       | Role      | Purpose                                  |
| ------ | ------------------------------------------ | --------- | ---------------------------------------- |
| GET    | `/api/videos`                              | member    | Catalogue of READY videos + a ticket each |
| GET    | `/api/videos/{id}`                         | member    | One catalogue entry                      |
| GET    | `/api/videos/{id}/segments?rendition=`     | member    | The segment index for a rung             |
| GET    | `/api/videos/{id}/segment-at?seconds=`     | member    | Which segment covers that second         |
| GET    | `/api/videos/{id}/master.m3u8?t=`          | ticket    | Variant list (URIs rewritten)            |
| GET    | `/api/videos/{id}/r/{rung}/index.m3u8?t=`  | ticket    | Media playlist (URIs rewritten)          |
| GET    | `/api/videos/{id}/r/{rung}/seg_NNNNN.ts?t=`| ticket    | One ~6s segment                          |
| GET    | `/api/videos/{id}/raw?t=`                  | ticket    | Progressive fallback, `Range`-aware      |
| GET    | `/api/videos/{id}/poster.jpg?t=`           | ticket    | Catalogue thumbnail                      |
| GET    | `/api/videos/{id}/sprite.jpg?t=`           | ticket    | Seek-preview filmstrip                   |
| GET    | `/api/admin/videos/status`                 | moderator | NAS reachability, free space, FFmpeg     |
| GET    | `/api/admin/videos`                        | moderator | All videos incl. PROCESSING / FAILED     |
| POST   | `/api/admin/videos`                        | moderator | Upload a recording (multipart)           |
| PATCH  | `/api/admin/videos/{id}`                   | moderator | Edit title / description                 |
| POST   | `/api/admin/videos/{id}/reprocess`         | moderator | Rebuild the ladder from the original     |
| DELETE | `/api/admin/videos/{id}`                   | moderator | Delete rows + the NAS folder             |

### Python AI service

| Method | Path                          | Purpose                                              |
| ------ | ----------------------------- | ---------------------------------------------------- |
| GET    | `/health`                     | Liveness / keep-warm                                 |
| POST   | `/ingest`                     | Embed + cluster one question                         |
| POST   | `/draft`                      | RAG draft for a cluster (returns answer + citations) |
| GET    | `/clusters?limit=N`           | Ranked cluster board                                 |
| GET    | `/knowledge/status`           | Indexed sources + chunk count                        |
| POST   | `/knowledge/upload`           | Index an uploaded PDF at runtime                     |
| GET    | `/knowledge/files/{filename}` | Serve a source PDF                                   |

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

**Setup flows (moderator):** 7. **Upload annual report** → backend forwards the PDF to the AI service, which chunks, embeds,
and adds it to the live FAISS index (no restart). 8. **Upload question bank** → backend splits the file into lines and bulk-ingests each through the
clustering pipeline, broadcasting the board once at the end. 9. **Click a citation** → opens `/api/source/{file}#page=N` in a new tab; the backend proxies the
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
- **Playback tickets for media.** `<video src>`, hls.js and `<img>` are fetched by the browser's
  media stack, which cannot attach an `Authorization` header, so those routes are permitted in the
  filter chain (GET only) and authorised in code. The credential is *not* the session JWT — it is a
  signed token scoped to **one video id** and short-lived (6h default), so a leaked media URL grants
  read access to one recording for a bounded time rather than the whole API. A ticket for video A is
  rejected on video B.
- **Media path traversal** is contained in one method, `VideoStorageService.resolveWithin`: it folds
  `\` to `/`, normalises, and rejects anything resolving outside the video's own folder. Rendition and
  segment names are additionally regex-validated in the controller, so only generated filenames are
  ever served.
- **Upload validation** for video: extension allow-list and a per-file byte ceiling
  (`VIDEO_MAX_UPLOAD_BYTES`, 2 GiB default). The multipart ceiling was raised for video, so the
  knowledge-PDF endpoint enforces its own 25 MB limit rather than relying on the shared global one.
- Prompt hardening in RAG: the model is instructed to answer only from retrieved context and
  never fabricate figures — reducing hallucination risk on financial data.

---

## 14. Deployment (Free Tier)

Full step-by-step in `DEPLOY.md`. Summary — **no credit card on any service**:

| Layer            | Free host                        | Notes                                                 |
| ---------------- | -------------------------------- | ----------------------------------------------------- |
| Frontend         | **Vercel**                       | Static hosting, SPA rewrites via `vercel.json`        |
| Backend          | **Koyeb** (or Render)            | Dockerfile build; idle-sleep mitigated by UptimeRobot |
| AI service       | **Hugging Face Spaces** (Docker) | Embedding model pre-baked into image                  |
| LLM              | **Groq / Gemini**                | Free API keys, email login only                       |
| Database         | **Neon**                         | Postgres + pgvector                                   |
| Redis (optional) | **Upstash**                      | Redis Streams                                         |
| Keep-warm        | **UptimeRobot**                  | Prevents free-tier cold sleeps                        |

A `docker-compose.yml` runs the entire system locally with one command (requires Docker).

---

## 15. Build & Verification Results

All three services were built, run, and verified locally end to end:

| Service               | Command                     | Result                                       |
| --------------------- | --------------------------- | -------------------------------------------- |
| Backend (Spring Boot) | `mvn clean package`         | ✅ `backend-1.0.0.jar` (~72 MB) produced     |
| Frontend (Angular 22) | `npm run build`             | ✅ Production bundle ~366 KB (98 KB gzipped) |
| AI service (Python)   | venv install + `py_compile` | ✅ All modules import & compile              |

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

VIRTUAL MEETING Sentinel demonstrates a production-shaped, polyglot microservice system that solves a
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

_Document reflects the current codebase, including the Setup uploads and cited-answer features._
