# VIRTUAL MEETING Sentinel — Interview Guide & Complete Reference

Everything about this project in one place: what it is, the full technology + concepts list,
and a large bank of interview questions with model answers.

> **Elevator pitch (say this first):** "VIRTUAL MEETING Sentinel is a real-time system that manages the
> flood of questions during a virtual Annual General Meeting. When thousands of shareholders
> ask questions at once, ~60–70% are duplicates phrased differently. It uses semantic ML to
> cluster and deduplicate them live, ranks them by importance, and drafts grounded answers with
> RAG over the company's annual report. It's built as polyglot microservices — Angular, Spring
> Boot, and Python/LangChain — and deployed entirely on free infrastructure."

---

## 1. Application Details

### What it does (the flow)

1. **Attendees** submit questions (anonymous, join-by-link).
2. Each question is **embedded** (vector) and **clustered** live — paraphrases merge into one topic.
3. Clusters are **ranked** by `log(size) × (1 + shareholder weight)`.
4. For hot topics, a **RAG** chain drafts a grounded, **cited** answer from the annual report.
5. **Moderators** (authenticated, with MFA) see a live, deduplicated, ranked board over WebSocket.
6. Moderators can **upload** the annual report + a question bank, and generate/publish answers.
7. Afterwards, moderators upload the **meeting recording**; it is transcoded into an adaptive ladder
   of ~6-second segments on a NAS share, and members **stream it on demand** — playback starts
   immediately, seeking anywhere is instant, and quality adapts to the network.

### The three services (polyglot microservices)

| Service        | Tech                              | Responsibility                                            |
| -------------- | --------------------------------- | --------------------------------------------------------- |
| **Frontend**   | Angular 22 (zoneless, signals)    | Attendee + moderator UI, live board, auth screens         |
| **Backend**    | Spring Boot 3 / Java 17           | Auth + MFA, WebSocket gateway, orchestration, persistence |
| **AI service** | Python 3.11 / FastAPI / LangChain | Embeddings, online clustering, RAG drafting               |

### Deployment (100% free, no credit card)

- Frontend → **Vercel**; Backend → **Render**; AI service → **Hugging Face Spaces** (Docker)
- DB → **Neon** (Postgres + pgvector); LLM → **Groq** (free); keep-warm → **UptimeRobot**

---

## 2. Complete Technology List

### Languages

Java 17, TypeScript, Python 3.11, SQL, HTML/CSS

### Frontend

- **Angular 22** — standalone components, **zoneless change detection**, **signals**
- **RxJS**, **@stomp/stompjs + SockJS** (WebSocket/STOMP), **@simplewebauthn/browser** (passkeys)
- **hls.js** — adaptive-bitrate video playback over Media Source Extensions
- Vite/esbuild build (Angular application builder), **lazy-loaded routes** (code splitting)

### Backend

- **Spring Boot 3.4** — Web MVC, **WebSocket (STOMP)**, **Spring Security**, **Spring Data JPA**
- **Spring Security OAuth2 Client** (Google sign-in), **WebFlux WebClient** (calls AI service)
- **JJWT** (JWT), **BCrypt** (password/PIN hashing)
- **dev.samstevens.totp** (TOTP/RFC 6238 + QR), **Yubico webauthn-server-core** (FIDO2/passkeys)
- **Hibernate Validator** (Bean Validation), **Actuator** (health)
- **H2** (local in-memory DB), **PostgreSQL driver** (prod)
- **`@Async` + `@TransactionalEventListener`** (off-request transcoding), **FFmpeg** subprocess
  orchestration, **HTTP Range** streaming, streamed multipart uploads (2 GB)

### AI service

- **FastAPI + Uvicorn**, **Pydantic**
- **LangChain** (langchain-core/community, text-splitters) — provider-agnostic LLM layer
- **ONNX Runtime** (`all-MiniLM-L6-v2`, local embeddings), **FAISS** (vector index)
- **langchain-groq / langchain-google-genai** (free LLMs), **pypdf** (PDF ingest), **NumPy**

### Data & infra

- **PostgreSQL + pgvector**, **Redis Streams** (optional, backpressure), **Docker / docker-compose**
- **NAS share** for media bytes (metadata-only in the DB) with a **PostgreSQL `bytea` fallback** for
  hosts with no persistent volume, **FFmpeg/FFprobe** for transcoding
- **Ollama** — local open-source LLM inference (no key, no account, nothing leaves the machine)
- **Neon, Vercel, Render, Hugging Face Spaces, Groq, UptimeRobot** (all free tier)
- **Licensing:** MIT project; every dependency audited open source
  ([THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)), including FFmpeg's GPL-vs-LGPL distinction
  and the fact that invoking it as a subprocess propagates no obligation

---

## 3. Complete Concepts List

**System design:** microservices, polyglot architecture, event-driven ingest, backpressure,
online (streaming) clustering, RAG (retrieval-augmented generation), vector search / ANN,
CQRS-style read model (board projection), stateless services, horizontal scale considerations,
cold-start mitigation, pluggable provider abstraction (LLM + OTP delivery), **asynchronous job
processing** (upload returns; work continues off-request), **graceful degradation** (missing FFmpeg
falls back to progressive delivery instead of failing).

**Media streaming:** **HLS / adaptive bitrate (ABR)**, **segmentation** (~6s slices, keyframe-aligned
GOP), bitrate ladders, **manifest/playlist rewriting**, **Media Source Extensions**, **HTTP Range**
requests + `206 Partial Content`, **bounded forward buffering**, **segment indexing for O(log n)
seek**, immutable-content caching, sprite-sheet seek previews.

**Security / auth:** stateless **JWT**, **role-based access control**, **BCrypt** hashing,
**Multi-Factor Authentication** (staged login), **PIN**, **TOTP/OTP** (RFC 6238),
**WebAuthn/FIDO2 passkeys** (biometric), **passwordless email/SMS OTP**, **OAuth2/OIDC**
(Google), CORS, input validation, prompt-injection hardening, **capability tokens / signed URLs**
(short-lived, single-resource playback tickets), **path-traversal containment**, upload allow-lists.

**AI/ML:** sentence embeddings, cosine similarity, nearest-centroid clustering, incremental
centroid update, semantic dedup, chunking, top-k retrieval, grounded generation with citations.

**Frontend:** SPA, **reactive signals**, **zoneless change detection**, WebSocket/STOMP live
updates, route guards, JWT session handling, standalone components.

**Backend/patterns:** dependency injection, filter chain, exception handling advice, DTOs,
repository pattern, WebClient/HTTP integration, scheduled tasks, running-mean aggregation.

**DevOps:** Docker multi-stage builds, CI/CD via Git push, environment-based config,
free-tier deployment, health checks + keep-warm.

---

## 4. Interview Questions & Answers

### 4.1 Project overview

**Q: Walk me through your project.**
A: Use the elevator pitch, then the flow (§1). Emphasize the _unique problem_ (live semantic
dedup of a question flood) and the _polyglot_ design rationale.

**Q: Why did you build it as three separate services instead of one app?**
A: Each language is best at its job — Java for transactional, secure, high-concurrency business
logic; Python for the ML/LLM ecosystem (embeddings, vector stores, LangChain); Angular for the
reactive UI. Splitting them lets each **scale and deploy independently** and matches how
AI-enabled enterprises actually structure systems. The tradeoff is added network/ops complexity,
which I justified because the AI workload has a very different scaling profile than the API.

**Q: What was the hardest part?**
A: The **online clustering** — you can't use k-means on a live stream (no fixed k, points arrive
one at a time). I used incremental nearest-centroid clustering with running-mean centroids,
O(#clusters) per question, so it dedupes in real time without knowing the topic count ahead.

### 4.2 System design & scale

**Q: How would this handle 10,000 concurrent users?**
A: (1) The API is **stateless** (JWT) so it scales horizontally behind a load balancer.
(2) Ingest is **decoupled** from AI via a message stream (Redis Streams now, Kafka for
production) so a burst of writers is absorbed as **backpressure** and drained at the AI's pace.
(3) The AI service scales independently via **consumer groups**. (4) The board read model is a
projection that can be cached (Redis). (5) WebSocket fan-out across instances via a shared
pub/sub. I'd add rate limiting and a circuit breaker around the AI calls.

**Q: Where's the bottleneck?**
A: The LLM/embedding throughput. Embeddings are cheap (local model), but LLM drafting is the
slow, rate-limited step — so I only draft **hot** clusters (size ≥ threshold), not every
question, and cache drafts on the cluster.

**Q: Why a message queue? Why Kafka over Redis?**
A: To decouple bursty ingest from bounded AI throughput (backpressure) and to fan out to
multiple consumers. Redis Streams is simpler and enough for a demo; **Kafka** adds durable
partitioned logs, consumer-group rebalancing, replay, and higher throughput — the production
choice. I kept the design pluggable so swapping doesn't change the business logic.

**Q: How do you prevent one popular question from dominating the ranking?**
A: The score is `log(1+size) × (1+weight_sum)` — the **log damps** raw volume so a topic can't
win purely on count; shareholder equity weight balances it.

### 4.3 AI / RAG / clustering

**Q: Explain the clustering algorithm.**
A: Each question is embedded to a 384-dim normalized vector. For each incoming question I find
the existing cluster whose centroid has the highest cosine similarity; if it's ≥ threshold
(0.78) I fold it in and update the centroid as a running mean (then re-normalize), else I start
a new cluster. O(#clusters) per question, no fixed k, real-time.

**Q: What is RAG and why use it?**
A: Retrieval-Augmented Generation. Instead of letting the LLM answer from memory (hallucination
risk, especially on financials), I retrieve the most relevant chunks of the annual report via
vector search and inject them as context, instructing the model to answer **only** from them and
cite sources. Grounded + auditable.

**Q: Why local embeddings instead of an API?**
A: `all-MiniLM-L6-v2` runs in-process — zero API cost, no rate limits, no data leaving the
service, and fast. Good enough quality for short questions.

**Q: FAISS vs pgvector — why both?**
A: FAISS is an in-memory ANN index, perfect for the annual-report knowledge base (rebuilt at
startup). pgvector persists question/cluster embeddings in Postgres so state survives restarts
and one store handles relational + vector. Different lifetimes → different tools.

**Q: How is your LLM layer provider-agnostic?**
A: LangChain abstracts the chat model behind one interface; a factory picks Groq/Gemini/Azure
from config. The RAG chain never imports a vendor SDK — swapping providers is a one-line change.

### 4.4 Authentication & MFA (a big topic here)

**Q: Walk me through your authentication.**
A: Attendees are anonymous (a light JWT). Moderators register (username/email/mobile/password,
BCrypt-hashed). Login is **staged**: a correct password returns either a full access token (no
MFA enrolled) or a short-lived **MFA-challenge token**. The challenge is exchanged for a full
token only after a valid second factor.

**Q: Which MFA factors did you implement?**
A: Four: **PIN** (hashed), **TOTP/OTP** via authenticator apps (RFC 6238, QR enrollment),
**WebAuthn passkeys** (biometric — Windows Hello/Touch ID), and **passwordless email/SMS OTP**.
Plus **Google OAuth2** social login.

**Q: How does the MFA-challenge token prevent bypass?**
A: It carries a `typ=mfa` claim and no role, and the JWT filter refuses to authenticate it for
protected routes — it only authorizes the second-factor endpoint. It's short-lived (5 min).

**Q: How does WebAuthn/passkey login work?**
A: On registration the browser generates a key pair in the device authenticator; the private key

- biometric never leave the device. The server stores the public key. On login the server sends
  a challenge, the device signs it after a local biometric check, and the server verifies the
  signature with the stored public key (Yubico library). A signature counter detects cloned keys.

**Q: Why is TOTP secure? What's the QR code?**
A: TOTP derives a 6-digit code from a shared secret + current 30s time window (HMAC-SHA1). The
QR encodes an `otpauth://` URI so the authenticator app imports the secret. The server recomputes
the expected code to verify — nothing sensitive is transmitted at login.

**Q: How does Google OAuth work across two domains (Vercel frontend, Render backend)?**
A: The whole handshake runs on the backend domain (`/oauth2/authorization/google` → Google →
`/login/oauth2/code/google`). On success a handler mints our own JWT and **redirects to the
frontend with the token in the URL**; the SPA stores it. This avoids cross-domain cookies.

**Q: Why JWT instead of sessions?**
A: Stateless — any instance can validate a token without shared session storage, which is what
lets the API scale horizontally. Tradeoff: revocation is harder (mitigated with short TTLs).

**Q: How do you store passwords and PINs?**
A: BCrypt (adaptive, salted). Never plaintext, never reversible.

**Q: Is showing the OTP on screen secure?**
A: No — that's **demo mode** so the project runs free without an email/SMS provider. In
production you set `OTP_DEMO_MODE=false` and wire a real delivery (Gmail SMTP is free for email);
the code is then only sent, never returned.

### 4.5 Frontend (Angular)

**Q: What is zoneless change detection and why use it?**
A: Angular traditionally uses zone.js to monkey-patch async APIs and trigger change detection.
Zoneless (stable in Angular 20+) removes zone.js; change detection is driven by **signals**, the
async pipe, and template events. Smaller bundle, faster, more predictable. I had to make reactive
state signals — I hit a real bug where a plain field bound to `[(ngModel)]` didn't update a
button's `[disabled]` until I converted it to a signal.

**Q: What are signals?**
A: Reactive primitives (`signal`, `computed`, `effect`) that track dependencies and notify
Angular directly when they change — the idiomatic reactivity model for zoneless apps.

**Q: How does the live board update?**
A: STOMP over WebSocket (SockJS fallback). The backend pushes board updates to `/topic/board`;
a service exposes them as a signal the moderator component renders.

### 4.6 Backend (Spring Boot)

**Q: How does the request pipeline work with security?**
A: A `JwtAuthFilter` runs before the auth filter, parses the Bearer token, and sets the
`SecurityContext` with the role authority. `SecurityConfig` maps URL patterns to roles. A
`@RestControllerAdvice` converts validation errors and thrown status exceptions into clean JSON
messages.

**Q: You hit a 403-instead-of-401 bug — what was it?**
A: A thrown 401 was forwarded internally to `/error`, which Spring Security blocked as an
unauthenticated ERROR dispatch → 403. I permitted the ERROR dispatch type so the real 401
surfaces.

**Q: How does the backend talk to the Python service?**
A: Reactive **WebClient** with timeouts (generous, to tolerate free-tier cold starts) and
best-effort error handling — a failed AI call never breaks an attendee's submission.

### 4.7 Database

**Q: Schema?**
A: `app_users` (credentials + factors), `webauthn_credentials` (public keys), `questions`
(text, weight, cluster_id, embedding vector(384)), `clusters` (representative question, centroid,
size, priority, cached draft). IVFFlat index on centroids for ANN.

**Q: H2 locally, Postgres in prod — why / any risk?**
A: H2 in PostgreSQL-compatibility mode for zero-setup local dev; Neon Postgres + pgvector in
prod. Risk: dialect differences — mitigated by JPA/Hibernate abstracting SQL and keeping vector
ops in the Python service.

### 4.8 Video streaming (the recordings library)

**Q: Why not just store the recording and put it in a `<video>` tag?**
A: One large file means the browser pulls a long prefix before playback starts, seeking to 40:00 is
slow, and any dip in bandwidth stalls playback. Cutting the same recording into ~6-second segments at
several bitrates fixes all three: playback starts after one small segment, a seek costs one segment,
and when throughput drops the player steps down a rung at the next segment boundary instead of
stalling. That's HLS, and it's what "smooth playback" actually consists of. The cost is a transcode
at upload time plus a segment index — which is exactly what the pipeline does.

**Q: Why is the media on a NAS and not in the database?**
A: A 2 GB recording in a BLOB column can't be streamed usefully — you'd pull it through the DB
connection, blow up heap and buffer cache, and lose HTTP Range semantics. Filesystems are already
excellent at ranged reads of large files, and DBs are excellent at indexed lookups over small rows.
So bytes go to the NAS and the DB holds only the catalogue plus the **segment index**. That index is
the interesting half: `start_seconds` per slice turns "seek to 21:30" into one indexed row lookup
naming a single ~2 MB file.

**Q: The upload is a multipart POST that can take minutes. How do you avoid a timeout?**
A: Two phases. The POST only does what must be synchronous — validate, create the row, stream bytes
to the NAS — then returns `PROCESSING`. Transcoding is published as an event and runs on a dedicated
pool; the admin UI polls for `progressPercent`. The bytes stream via `transferTo`, so a 2 GB upload
is never held in the JVM heap, and `file-size-threshold: 0` forces the container to spool to disk.

**Q: You used `@Async` — any traps?**
A: Yes, the one that bites everyone: `@Async` and `@Transactional` are **proxy**-based, so a service
calling *its own* annotated method bypasses the proxy entirely. The "async" transcode would run
inline on the HTTP thread and each "transaction" would silently join the caller's — both annotations
become no-ops, with no error. So the worker is a separate bean. Two related choices: the job is
published as an event consumed with `@TransactionalEventListener(AFTER_COMMIT)`, because a worker
started mid-transaction would look up a row its own connection can't see yet; and each state
transition is its own short transaction, because one transaction spanning ffmpeg would pin a DB
connection for minutes and hide progress until the end.

**Q: How do you authorise media requests when the browser can't send headers?**
A: That's the crux. `<video src>`, hls.js and `<img>` are fetched by the browser's media stack, which
cannot attach an `Authorization` header. Putting the session JWT in the query string would be worse —
long-lived, grants the whole API, and lands in proxy logs. So media URLs carry a **playback ticket**:
signed, short-lived (6h), and scoped to **one video id**. A leaked URL exposes one recording for a
bounded window instead of the account. The routes are `permitAll` in the filter chain (GET only) and
authorised in the controller, which also accepts a normal session so `curl` and tests work.

**Q: What was the subtle bug in that scheme?**
A: Relative URIs in a playlist are resolved **without** the query string. Serving `master.m3u8`
verbatim means the player resolves `720p/index.m3u8`, drops the `?t=`, and 403s on its very next
request. So manifests are rewritten on the way out to carry the ticket onto every child URI — while
passing tag lines through untouched, so the `BANDWIDTH`/`RESOLUTION`/`CODECS` attributes the player
needs to choose a rung survive. A second trap: ffmpeg writes the variant URI with the *platform*
separator, so on Windows the master contains `720p\index.m3u8`; splitting on `/` produced a rung
named `720p\index.m3u8` and every variant 404'd. The rewrite now matches against the stored
renditions instead of parsing the path.

**Q: What if FFmpeg isn't installed?**
A: The upload still succeeds and the video still plays — `deliveryMode=PROGRESSIVE`, served over HTTP
Range, capped at 4 MiB per response so the browser makes a series of small requests as it plays
rather than pulling the whole file. What's lost is adaptive bitrate switching; seeking still works.
The admin screen shows a banner and **Re-process** builds the real ladder once FFmpeg is available.
Degrading a feature beats failing an upload.

**Q: How do you stop playback from becoming a download?**
A: `maxBufferLength: 30` in hls.js — never hold more than ~30s / 60 MB ahead, however long the
recording. Combined with segmentation, a viewer who watches five minutes of a two-hour recording
transfers five minutes of video. The stats panel exposes buffer-ahead and the current segment number
so this is observable rather than asserted.

**Q: Where do the bytes live, and why not in the database?**
A: On a NAS share by default, with only metadata in Postgres. A 2 GB recording in a BLOB column
can't be streamed usefully — you'd pull it through the DB connection, blow up heap and buffer cache,
and lose HTTP Range semantics. Filesystems are already excellent at ranged reads of large files.
**But** there's a second mode (`VIDEO_STORAGE_MODE=database`) that does store segments in Postgres,
because a container with no persistent volume wipes its filesystem on every redeploy — silently
destroying recordings. Segmentation is what makes that viable: the unit stored per row is a ~2 MB
segment, not a 2 GB file, and ranged reads use a SQL binary `substring` so a range still costs the
size of the range. The mode is recorded per video, so changing the default can't strand old ones.

**Q: What broke when you added database storage?**
A: Hibernate renders `@Lob byte[]` as SQL `blob` — and PostgreSQL has no `blob` type. H2 in
PostgreSQL-compatibility mode rejects it too. Schema export failed while the app still started
happily, so the table was simply missing and the first upload discovered it. The fix was declaring
the column `bytea`. Raising the `VARBINARY` length doesn't help — Hibernate promotes anything over
the dialect maximum straight back to `blob`.

**Q: Anything you'd change?**
A: Transcoding is CPU-bound and currently shares the API process; the honest production shape is a
separate worker service consuming a queue — which is why the work is already isolated in
`VideoProcessingWorker` behind its own pool, so that's a deployment change rather than a redesign.
I'd also put segments behind a CDN (they're immutable and already cache-friendly with
`max-age=1y, immutable`), and switch to fMP4/CMAF segments for lower overhead and DRM options.

### 4.9 DevOps / deployment

**Q: How is it deployed for free?**
A: Vercel (frontend), Render (backend Docker), HF Spaces (AI Docker), Neon (DB), Groq (LLM).
Free tiers sleep when idle → UptimeRobot pings keep them warm; the UI shows a "waking up"
message on cold starts.

**Q: A build failed in the cloud but worked locally — why?**
A: The Dockerfile's `mvn dependency:go-offline` eagerly resolved a broken transitive
(a Jackson SNAPSHOT pulled by the WebAuthn lib) that `mvn package` avoids via Spring's dependency
management. Removing the go-offline step fixed it.

### 4.10 Tradeoffs & "what would you improve"

- Add **Kafka** for durable, partitioned ingest + replay (currently Redis Streams/HTTP).
- **Rate limiting + circuit breaker** (Resilience4j) for resilience.
- **Observability**: Prometheus/Grafana metrics + OpenTelemetry tracing.
- **Token revocation** list / refresh tokens.
- **Multi-tenancy** for many concurrent meetings.
- Real email/SMS OTP delivery; horizontal WebSocket fan-out across instances.

---

## 5. Rapid-fire one-liners

- **Backpressure** — absorbing a burst of writers so a slow consumer isn't overwhelmed.
- **Idempotency** — same request twice = same effect once.
- **Embedding** — text → vector capturing meaning.
- **Cosine similarity** — angle between vectors; 1 = identical meaning.
- **RAG** — retrieve relevant context, then generate grounded answers.
- **JWT** — signed, stateless token carrying identity + claims.
- **TOTP** — time-based one-time code from a shared secret.
- **WebAuthn** — public-key auth where the private key + biometric stay on device.
- **Zoneless** — Angular change detection driven by signals, not zone.js.
- **Polyglot microservices** — services in different languages, each fit to its job.
- **HLS** — video as a playlist of short segments fetched over plain HTTP.
- **ABR (adaptive bitrate)** — same video at several qualities; the player switches at a segment
  boundary to match the measured bandwidth.
- **Segment** — a few seconds of video in its own file, starting on a keyframe so it decodes
  independently — which is what makes both seeking and quality switching cheap.
- **Manifest / playlist (`.m3u8`)** — the text index the player reads to know what to fetch next.
- **MSE (Media Source Extensions)** — the browser API that lets JavaScript feed video bytes to the
  player; it's how hls.js works where HLS isn't native.
- **HTTP Range / 206** — "send me bytes X–Y of this file"; how seeking works without segments.
- **Playback ticket** — a signed, short-lived capability URL scoped to one resource, used where the
  client can't send an auth header.
- **Proxy-based annotations** — `@Async`/`@Transactional` only apply across a bean boundary; calling
  your own annotated method silently does nothing.
