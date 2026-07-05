# AGM Sentinel — How It Works (Complete Walkthrough)

A code-level walkthrough of the whole system in runtime sequence, followed by deep dives
into the three subsystems that carry the most logic: **online clustering**, **RAG
drafting**, and **MFA / WebAuthn authentication**.

> Companion docs: [README.md](README.md) (pitch + stack), [ARCHITECTURE.md](ARCHITECTURE.md)
> (design), [DEPLOY.md](DEPLOY.md) / [RUN_LOCAL.md](RUN_LOCAL.md) (ops).

---

## The system in one line

Three services talk to each other: **Angular** (browser) → **Spring Boot** (Java API, the
orchestrator) → **Python/FastAPI** (the AI brain). Postgres stores questions; the LLM
(Groq/Gemini) drafts answers. The whole thing turns a flood of live, duplicated shareholder
questions into a ranked, deduplicated, cited board for moderators.

```
Attendee types question
   → POST /api/questions (Spring Boot)
   → save to Postgres
   → POST /ingest (Python): embed → nearest-centroid cluster (dedup at sim ≥ 0.78)
   → save clusterId back to Postgres
   → if cluster size == 3: POST /draft → RAG (FAISS retrieve → LLM → cited answer)
   → GET /clusters (top-20 ranked) → push to /topic/board (STOMP)
   → Angular signal updates → moderator's board re-renders live
   (+ scheduler re-pushes every 10s to catch late drafts & keep AI warm)
```

---

## Phase 0 — Startup (what boots, in what order)

1. **Python AI service** boots (`ai-service/app/main.py:28-33`). The `lifespan` hook eagerly
   warms two heavy singletons so the first real request isn't slow:
   - `get_embeddings()` — loads the local `all-MiniLM-L6-v2` sentence-transformer (384-dim
     vectors, no API).
   - `get_kb()` — reads every PDF in `ai-service/knowledge/`, splits each page into
     ~1000-char chunks, embeds them, and builds an in-memory **FAISS** index
     (`ai-service/app/rag.py:46-60`). If no PDF exists, it loads a harmless placeholder so
     the service still boots.
   - The LLM chain is **not** built yet — it's lazy (`ai-service/app/rag.py:64-67`), so the
     service runs and clusters even with no LLM API key. Only `/draft` needs the key.
2. **Spring Boot** boots, connects to Postgres, and starts an **in-memory STOMP broker** on
   `/topic` (`backend/.../config/WebSocketConfig.java:17-20`).
3. **Angular** loads in the browser; the default route redirects to `/ask` (the attendee
   page) (`frontend/src/app/app.routes.ts:10-11`).

---

## Phase 1 — Authentication (moderators only)

Attendees ask questions without logging in. **Moderators** must authenticate to see the
board (`/board`, `/setup`, `/security` are guarded — `frontend/src/app/app.routes.ts:14-16`).

1. Login (`POST /api/auth/login`) returns either `AUTHENTICATED` (with a JWT) or
   `MFA_REQUIRED` (with a temporary MFA-challenge token).
2. If MFA is required, the user completes a second factor — PIN, TOTP, an **email/SMS OTP**,
   or a **WebAuthn passkey** (Windows Hello / Touch ID — the private key never leaves the
   device, `frontend/src/app/services/auth.service.ts:117-143`). Google OAuth2 is also an
   option.
3. On success the client gets a full JWT, stored in `localStorage` and pushed onto every API
   call (`frontend/src/app/services/auth.service.ts:42-50`).
4. Every protected backend request passes through `JwtAuthFilter`, which verifies the
   signature and **rejects MFA-challenge tokens** so a half-authenticated session can't reach
   real endpoints (`backend/.../security/JwtAuthFilter.java:38-43`).

See the **MFA / WebAuthn deep dive** below for the full ceremony.

---

## Phase 2 — An attendee submits a question (the core flow)

When an attendee types a question and hits submit:

1. **Browser → Backend.** `POST /api/questions` hits `QuestionController`
   (`backend/.../controller/QuestionController.java:19-22`) → `QuestionService.submit()`.
2. **Persist.** The question is saved to Postgres immediately
   (`backend/.../service/QuestionService.java:35`) — durable record before any AI work.
3. **Backend → AI service.** `AiClient.ingest()` makes an HTTP `POST /ingest` to the Python
   service (`backend/.../service/AiClient.java:26-37`), with a 30s timeout to survive
   free-tier cold starts.
4. **Embed + cluster (the dedup magic).** In `ai-service/app/main.py:52-62`:
   - The question text is embedded into a 384-dim vector.
   - `OnlineClusterer.assign()` runs **incremental nearest-centroid clustering**
     (`ai-service/app/clustering.py:58-100`): it scans existing cluster centroids, finds the
     most similar one, and —
     - if cosine similarity ≥ **0.78** (`config.py` threshold), it **folds the question into
       that cluster** (semantic dedup), updates the centroid, and bumps `size`/`weight_sum`.
     - otherwise it **starts a brand-new cluster** with this question as the representative.
   - Returns the cluster id, whether it was new, and the new cluster size.
5. **Store the cluster link.** Backend saves the `clusterId` back onto the question row
   (`backend/.../service/QuestionService.java:38-39`).
6. **Auto-draft hot clusters.** When a cluster's size hits exactly **3**
   (`HOT_CLUSTER_THRESHOLD`), the backend fires a best-effort `POST /draft`
   (`backend/.../service/QuestionService.java:42-48`). Drafting failures never break the
   attendee's submission.
7. **Broadcast the board** (see Phase 4).

---

## Phase 3 — Drafting a grounded answer (RAG)

When `/draft` is called for a hot cluster (`ai-service/app/rag.py:128-144`), **Retrieve →
Augment → Generate** runs:

1. **Retrieve** — FAISS vector search pulls the top-4 annual-report chunks most similar to
   the question.
2. **Augment** — those chunks (tagged with source + page number) are stitched into a context
   block.
3. **Generate** — the LangChain prompt + LLM (Groq or Gemini) drafts a **≤120-word answer
   using only that context** — the prompt forbids inventing figures and tells it to recommend
   escalation if the report doesn't cover it (`ai-service/app/rag.py:24-33`).
4. **Cite** — each retrieved chunk becomes a citation (source + snippet). The draft +
   citations are cached onto the cluster object (`ai-service/app/main.py:68-73`) so they ride
   along on the next board push.

See the **RAG deep dive** below.

---

## Phase 4 — The live board reaches moderators (real-time push)

1. After any ingest or draft, `broadcastBoard()` fetches the current top-20 ranked clusters
   from the AI service (`GET /clusters`) and pushes them to the STOMP topic `/topic/board`
   (`backend/.../service/QuestionService.java:79-82`).
2. **Ranking:** clusters are ordered by `priority_score = log(1+size) × (1 + weight_sum)`
   (`ai-service/app/clustering.py:37-40`) — *how many people asked* × *how much equity they
   hold*, with log-damping.
3. The Angular `BoardService` holds a STOMP+SockJS connection subscribed to `/topic/board`;
   each push updates an Angular **signal**, which re-renders the moderator view instantly
   (`frontend/src/app/services/board.service.ts:20-38`). Signals (not RxJS subjects) are used
   because the app is **zoneless**.
4. A **scheduler** re-broadcasts the board every 10 seconds
   (`backend/.../service/BoardRefreshScheduler.java:19-26`) — catches late drafts and
   re-rankings, and doubles as a **keep-warm ping** so the free-tier AI service doesn't sleep.

---

## The two ingest paths (design detail)

Both feed the same `OnlineClusterer`:

- **HTTP `/ingest`** (default, `QUEUE_MODE=inproc`) — direct synchronous call. Simple, works
  on free tiers with no shared Redis.
- **Redis Streams** (`QUEUE_MODE=redis`, production-scale) — the backend publishes questions
  to a Redis stream; a separate `consumer.py` worker drains it at a steady rate
  (`ai-service/app/consumer.py:37-56`). Adds **backpressure**: a spike of 10,000 simultaneous
  writers is absorbed by the stream instead of overwhelming embedding/clustering throughput.

---

# Deep dive 1 — Clustering math

The engine is **incremental nearest-centroid clustering** in `ai-service/app/clustering.py`.
Questions arrive one at a time, the number of distinct topics is unknown, and dedup must
happen in real time — so batch k-means (needs all points + a fixed `k` up front) is useless.

### Step A — Text becomes a vector

`ai-service/app/embeddings.py:20-27` runs the question through `all-MiniLM-L6-v2`, producing
a **384-dimensional vector** with `normalize_embeddings=True`. Normalized = every vector has
length 1, i.e. it lives on the surface of a unit sphere.

### Step B — Similarity = a dot product

Cosine similarity is the cosine of the angle between two vectors:

```
cos(a, b) = (a · b) / (‖a‖ · ‖b‖)
```

Because the vectors are already L2-normalized (`‖a‖ = ‖b‖ = 1`), the denominator is 1, so
**cosine collapses to a plain dot product** — very cheap (`ai-service/app/embeddings.py:39-46`
still normalizes defensively). Result ranges from `-1` (opposite) to `1` (identical);
paraphrases of the same question land around `0.8–0.95`.

### Step C — Assign to a cluster (the dedup decision)

For each incoming vector (`ai-service/app/clustering.py:67-100`):

1. **Linear scan** over all existing centroids, keeping the highest-similarity match
   (`best_sim`). O(#clusters), not O(#questions) — cheap because topics ≪ questions.
2. **Compare to threshold `0.78`**:
   - `best_sim ≥ 0.78` → **fold in** (duplicate topic).
   - `best_sim < 0.78` → **new cluster** (new topic seeds its own centroid).

`0.78` is the master tuning knob: higher = stricter (more, smaller clusters, risk of
splitting one question); lower = unrelated questions merge.

### Step D — Updating the centroid (running mean)

When a question folds in (`ai-service/app/clustering.py:81-85`):

```
new_centroid = (old_centroid × n + new_vec) / (n + 1)
then re-normalize:  centroid /= ‖centroid‖
```

`n` is the current size. This is an **online mean** — the exact average of all member vectors
without storing them. The re-normalize step is essential: after averaging, the centroid is no
longer length-1, and skipping it would silently break the "dot product = cosine" shortcut next
round.

**Worked example.** Cluster has 2 members, centroid `C`. A third vector `v` folds in:
`C_new = (C×2 + v) / 3`, then divide by its length. Now `size = 3`, and `C` sits slightly
closer to `v`. Each new member tugs the centroid less (the `1/(n+1)` weight shrinks) — early
questions define the topic, later ones barely move it.

### Step E — Ranking (priority score)

`ai-service/app/clustering.py:37-40`:

```
priority_score = log(1 + size) × (1 + weight_sum)
```

- **`size`** = how many asked. `log(1+size)` damps it so a cluster of 400 doesn't outrank
  everything 400× — the 5th duplicate matters far more than the 400th.
- **`weight_sum`** = sum of askers' **shareholder weights** (equity held). Boosts questions
  from large shareholders even with fewer askers — right for an AGM where votes are
  share-weighted.

`top(n)` sorts by this score descending and returns the top 20.

### Caveat

All state lives in an in-memory `dict` guarded by a `threading.Lock`
(`ai-service/app/clustering.py:66-67`) — the lock is required because many web requests mutate
shared centroids concurrently. The docstring says centroids are "persisted to Postgres for
durability," but the code as written keeps them **only in memory**, so a restart currently
loses clusters. Worth closing that gap if durability matters.

---

# Deep dive 2 — RAG prompt chain

Given a hot cluster's representative question, draft a factual answer **only** from the
annual report, with citations. Textbook **Retrieve → Augment → Generate** in
`ai-service/app/rag.py`.

### Build phase (once, at startup)

`ai-service/app/rag.py:69-92`: every PDF in `ai-service/knowledge/` is read page by page;
each page's text is split by `RecursiveCharacterTextSplitter(chunk_size=1000,
chunk_overlap=150)`. The overlap keeps a sentence that spans a chunk boundary whole in one
chunk (no fact cut in half). Each chunk is tagged with source **and page number**
(`"report.pdf p.42"`) — the metadata that becomes a clickable citation. All chunks are
embedded (same local model as clustering) into an in-memory **FAISS** index.

### The chain is lazy

`ai-service/app/rag.py:64-67`: `_PROMPT | get_llm() | StrOutputParser()` (prompt → LLM →
extract string). Built **only on first `/draft` call**, so the service boots and can
embed/cluster with **no LLM API key** — the key is needed only to draft.

### Draft phase (per hot cluster) — `ai-service/app/rag.py:128-144`

1. **RETRIEVE** — `similarity_search(question, k=4)` pulls the 4 nearest report chunks.
2. **AUGMENT** — chunks joined into one context block, each prefixed with its `[source p.N]`
   tag.
3. **GENERATE** — the chain fills `{question}` and `{context}` and calls the LLM.
4. **CITE** — each chunk becomes a `Citation(source, snippet[:180])` for click-through
   verification.

### Why it resists hallucination

The system prompt (`ai-service/app/rag.py:24-33`) does the heavy lifting:
- *"Answer ONLY from the provided context excerpts"* — no outside knowledge.
- *"If the context does not contain the answer, say you cannot find it… recommend
  escalation"* — a graceful "I don't know" instead of a confident fabrication.
- *"Keep it under 120 words. Do not invent figures."* — critical for financial data.

Reinforced by `temperature=0.2` (`ai-service/app/llm.py:19`) — deterministic, conservative
output. Every claim is backed by a citation to a real page, so a moderator verifies before it
reaches shareholders. This is L1 drafting — a human still approves.

### LLM-agnostic by design

`ai-service/app/llm.py:13-30` is a factory: `LLM_PROVIDER` in `.env` swaps Groq ↔ Gemini ↔
(future) Azure OpenAI with **no RAG code change**. The rest of the app never imports a vendor
SDK. Vendor imports live *inside* each branch, so you only install the provider you use.

---

# Deep dive 3 — MFA / WebAuthn

Login is **two stages**, orchestrated in `backend/.../service/AuthService.java`, and hinges on
**two token types**.

### The two-token trick (the core idea)

`backend/.../security/JwtService.java` issues two kinds of JWT:

| | Access token | MFA-challenge token |
|---|---|---|
| Claims | `role` + `typ=access` | **no role** + `typ=mfa` |
| TTL | 8 hours (`JwtService.java:22`) | **5 minutes** (`JwtService.java:50`) |
| Grants | real access | **nothing** — only the right to finish step 2 |

The gate is `backend/.../security/JwtAuthFilter.java:38`:
`if (!jwt.isMfaChallenge(claims) && role != null)`. A challenge token has `typ=mfa` and no
role, so it can **never** authenticate a protected request — even though it's a validly-signed
JWT. This is what makes a half-finished login safe.

### Stage 1 — password (`AuthService.java:111-127`)

1. `encoder.matches(password, hash)` — BCrypt re-hashes the input with the stored salt and
   compares in constant time; never decrypts. Generic "Invalid username or password" either
   way, so you can't probe which usernames exist.
2. **No MFA enrolled** → issue a **full access token** immediately.
3. **MFA enrolled** → issue **only** a challenge token + the list of available methods. No
   access yet.

### Stage 2a — PIN / TOTP (`AuthService.java:133-148`)

`requireChallengeUser()` re-derives the user *from the challenge token* — the client can't
name any user; it must present the valid, unexpired `typ=mfa` token from stage 1. Then:
- **PIN** → BCrypt-compare against the stored PIN hash.
- **TOTP** → recompute the expected time-based code from the shared secret and compare. The
  TOTP secret + QR are set up during enrollment (`AuthService.java:158-184`) and only *enabled*
  after the user confirms one working code — so a misconfigured authenticator can't lock them
  out.

On success → full access token.

### Stage 2b — WebAuthn passkey

FIDO2 public-key crypto via the Yubico library (`backend/.../service/WebAuthnService.java`).
Principle: **the private key and the biometric never leave the device.** The server only ever
stores a **public key**.

**Enrollment (registration ceremony)** — once, while logged in:
1. `startRegistration` (`WebAuthnService.java:81-101`) generates creation options (random
   challenge, relying-party id, user handle, allowed algorithms), stashed server-side.
2. Browser's `startRegistration()` (`auth.service.ts:117-127`) → the device authenticator
   (Windows Hello / Touch ID) prompts for a biometric and **generates a key pair on-device**.
3. Only the **public key** returns; `finishRegistration` (`WebAuthnService.java:103-122`)
   verifies the attestation and stores `(credentialId, publicKeyCose, signatureCount)`.

**Login (assertion ceremony)** — as an MFA second factor:
1. `startAssertion` (`WebAuthnService.java:126-136`) issues a fresh challenge.
2. Browser's `startAuthentication()` (`auth.service.ts:135-143`) has the device **sign the
   challenge with the private key** after a local biometric check.
3. `finishAssertion` (`WebAuthnService.java:138-158`) verifies the signature against the
   stored public key. On success → full access token.

Two security details:
- **`rpId`/`origin` binding** (`WebAuthnService.java:66-73`) — the credential is
  cryptographically bound to the frontend domain, so a passkey from your Vercel site can't be
  replayed by a phishing site. WebAuthn's built-in phishing resistance.
- **Signature counter / clone detection** (`WebAuthnService.java:149-151`) — each
  authenticator increments a counter per use; the server persists it. A counter that goes
  *backwards* signals a cloned authenticator.

### Two other entry points

- **Passwordless OTP** (`AuthService.java:58-66`) — email/SMS code, verify → straight to a
  full token (no password).
- **Google OAuth2** (`AuthService.java:69-76`) — find-or-create a user from the verified
  Google identity, auto-generate a unique username, issue a token.

---

## The recurring theme

Across all three subsystems: **do the expensive/risky thing lazily and behind a clear gate** —
lazy LLM chain, lazy clusterer, and a challenge token that grants nothing until the second
factor clears.
