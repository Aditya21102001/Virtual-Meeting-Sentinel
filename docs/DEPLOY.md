# Deploy VIRTUAL MEETING Sentinel for ₹0 (no credit card)

End-to-end guide. Total cost: **nothing**. No card needed on any service below.
Do it in this order — each step produces a URL/secret the next step needs.

---

## 0. One-time free accounts (email/GitHub only)

- **GitHub** (host the code) — push this repo.
- **Groq** → https://console.groq.com → API Keys → create key. _(free, no card)_
- **Neon** → https://neon.tech _(free Postgres, no card)_
- **Hugging Face** → https://huggingface.co _(free Docker Spaces, no card)_
- **Koyeb** → https://koyeb.com _(free web service, no card)_
- **Vercel** → https://vercel.com _(free static hosting, no card)_
- **UptimeRobot** → https://uptimerobot.com _(free keep-warm pings, no card)_

---

## 1. Database — Neon (Postgres + pgvector)

1. Create a project → a database is created for you.
2. Open the **SQL Editor**, paste the contents of [`ai-service/db/init.sql`](../ai-service/db/init.sql), run it.
3. Copy two connection strings from **Connection Details**:
   - **psql/URI** form for Python: `postgresql://user:pass@host/db?sslmode=require`
   - **JDBC** form for Spring: `jdbc:postgresql://host/db?sslmode=require` (+ user/pass separately)

---

## 2. AI service — Hugging Face Spaces

1. **New Space** → Owner = you, SDK = **Docker**, name = `agm-sentinel-ai`, visibility Public.
2. Push the `ai-service/` folder into the Space repo (it has the `Dockerfile`):
   ```bash
   git clone https://huggingface.co/spaces/<you>/agm-sentinel-ai
   cp -r ai-service/* agm-sentinel-ai/
   cd agm-sentinel-ai && git add . && git commit -m "AI service" && git push
   ```
3. Space **Settings → Variables and secrets**:
   - `LLM_PROVIDER` = `groq`
   - `GROQ_API_KEY` = _(secret)_ your Groq key
   - `PORT` = `7860`
   - _(optional)_ `DATABASE_URL` = your Neon URI, `VECTOR_STORE` = `pgvector`
4. Wait for the build. Note the URL: `https://<you>-agm-sentinel-ai.hf.space`.
5. Test: open `https://<you>-agm-sentinel-ai.hf.space/health` → `{"status":"ok"}`.
6. _(optional)_ Drop an annual-report PDF into `knowledge/` before pushing for real RAG answers.

---

## 3. Backend — Koyeb (Spring Boot)

1. Koyeb → **Create Web Service** → **GitHub** → select this repo.
2. **Work directory** = `/backend`, **Builder** = Dockerfile.
3. Environment variables:
   | Key | Value |
   |---|---|
   | `SPRING_DATASOURCE_URL` | your Neon **JDBC** URL |
   | `SPRING_DATASOURCE_USERNAME` | Neon user |
   | `SPRING_DATASOURCE_PASSWORD` | Neon password |
   | `AI_SERVICE_URL` | `https://<you>-agm-sentinel-ai.hf.space` |
   | `JWT_SECRET` | a long random string |
   | `APP_FRONTEND_URL` | your Vercel URL, e.g. `https://<app>.vercel.app` (for the Google redirect back) |
   | `PORT` | `8080` |
4. Expose port `8080`, health check path `/actuator/health`. Deploy.
5. Note the URL: `https://<app>-<you>.koyeb.app`.

### 3b. Video library — storage and FFmpeg

The video library needs two things a free PaaS container doesn't give you: **persistent storage** and
**FFmpeg**. Add these env vars:

| Key | Value |
|---|---|
| `VIDEO_STORAGE_MODE` | `filesystem` (needs a volume) or `database` (no volume needed) |
| `VIDEO_NAS_PATH` | mount path of the volume / NAS share, e.g. `/mnt/nas/videos`. In `database` mode this is only scratch space and may be ephemeral |
| `VIDEO_REQUIRE_NAS` | `true` with `filesystem` in production — fail loudly rather than writing to ephemeral disk |
| `FFMPEG_PATH` / `FFPROBE_PATH` | only if not on `PATH` in the image |
| `VIDEO_WORKERS` | `1` on a 1-vCPU instance |
| `VIDEO_MAX_UPLOAD_BYTES` | lower than 2 GiB if your host caps request size |

Two caveats specific to free tiers:

- **Container filesystems are ephemeral.** With no volume attached the backend falls back to
  `./var/videos` inside the container, and every recording disappears on redeploy.
  `VIDEO_REQUIRE_NAS=true` turns that silent data loss into a startup failure. You then have two
  ways out:
  1. attach a volume, or point `VIDEO_NAS_PATH` at a mounted NAS/SMB share; or
  2. set **`VIDEO_STORAGE_MODE=database`** — segments are stored in Postgres instead of on disk, so
     recordings survive a redeploy with no volume at all. Mind the size: a 40-minute recording at
     three rungs is roughly 1.5 GB, well over Neon's 0.5 GB free allowance, so this suits a small
     library or a Postgres you control. See
     [VIDEO_LIBRARY.md §4](VIDEO_LIBRARY.md#4-storage-modes).
- **Transcoding is CPU-bound** and will saturate a 1-vCPU free instance for the length of the job,
  which makes the rest of the API sluggish while it runs. It will not, however, run the instance out
  of memory or disk on a long recording: segments are moved into storage as FFmpeg produces them, so
  a three-hour upload costs the same resident memory as a three-minute one and simply takes longer
  ([VIDEO_LIBRARY.md §4a](VIDEO_LIBRARY.md#4a-why-the-drain-exists)). The realistic production shape
  is still a separate transcode worker, which is what `VideoProcessingWorker` and its dedicated pool
  are already factored for.

If FFmpeg isn't available in the image, uploads still play — progressively over HTTP Range instead of
as an adaptive ladder. See [VIDEO_LIBRARY.md §7](VIDEO_LIBRARY.md#7-the-progressive-fallback-no-ffmpeg).

### 3a. (Optional) Enable "Sign in with Google" + real Email/SMS OTP

**Google login** — create an OAuth client at https://console.cloud.google.com (free, no card):

- OAuth consent screen → _External_; Credentials → _OAuth client ID_ → _Web application_.
- Authorized redirect URI: `https://<app>-<you>.koyeb.app/login/oauth2/code/google`
- Add these backend env vars:

  | Key                                                               | Value                |
  | ----------------------------------------------------------------- | -------------------- |
  | `SPRING_SECURITY_OAUTH2_CLIENT_REGISTRATION_GOOGLE_CLIENT_ID`     | your OAuth client id |
  | `SPRING_SECURITY_OAUTH2_CLIENT_REGISTRATION_GOOGLE_CLIENT_SECRET` | your OAuth secret    |

  With these unset, Google login is simply hidden and the app runs normally.

**OTP delivery** — by default OTP runs in **demo mode** (code shown on screen; free, no
provider). To send **real mobile SMS**, set these backend env vars:

| Key                | Value                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| `OTP_DEMO_MODE`    | `false`                                                                |
| `OTP_SMS_PROVIDER` | `textbelt` (global, 1 free SMS/day) or `fast2sms` (India, free signup) |
| `OTP_SMS_API_KEY`  | `textbelt` for the free shared key, or your Fast2SMS API key           |

With these unset, mobile OTP falls back to demo (code shown). Email OTP has no wired provider,
so it always shows the code. No SMS gateway is unlimited-free without a card — TextBelt (1/day)
and Fast2SMS (India, UPI top-up) are the closest.

---

## 4. Frontend — Vercel (Angular)

1. Edit [`frontend/src/environments/environment.prod.ts`](../frontend/src/environments/environment.prod.ts):
   ```ts
   apiBase: 'https://<app>-<you>.koyeb.app',
   wsUrl:   'https://<app>-<you>.koyeb.app/ws',
   ```
   Commit + push.
2. Vercel → **Import Project** → this repo → **Root directory = `frontend`** → Deploy.
3. Live at `https://<project>.vercel.app`. Open `/ask` and `/board` in two tabs.

---

## 5. Keep-warm — UptimeRobot (beat cold starts)

Free backends sleep after ~15 min idle. Add HTTP monitors, interval 5–10 min:

- `https://<you>-agm-sentinel-ai.hf.space/health`
- `https://<app>-<you>.koyeb.app/actuator/health`

Now the services stay awake during demos and interviews.

---

## Demo script (what to show a recruiter)

1. Open `/board` (moderator) on one screen.
2. On `/ask`, submit 4–5 phrasings of the _same_ question ("dividend date?", "when is the
   dividend paid?", "payout schedule for dividends?"). Watch them **collapse into one cluster**
   whose count climbs — live, over WebSocket.
3. Submit a genuinely different question → a **new topic** appears.
4. Hit **Draft answer** on the hot cluster → a grounded, cited answer from the annual report.
5. Talk through the architecture diagram in the root [README](../README.md): three languages,
   async decoupling, RAG, all on free infra.

---

## Free-tier limits (know them before the interview)

| Service   | Limit                      | Impact                                     |
| --------- | -------------------------- | ------------------------------------------ |
| Groq      | generous req/min free      | fine for demo; back off if rate-limited    |
| Neon      | 0.5 GB, autosuspend        | plenty; wakes on connect                   |
| HF Spaces | 2 vCPU/16GB, idle sleep    | cold start ~20–40s (model is prebaked)     |
| Koyeb     | 1 free service, idle sleep | cold start ~30s (mitigated by UptimeRobot) |
| Vercel    | 100 GB bandwidth/mo        | irrelevant for a portfolio                 |
| Video storage | no free persistent volume | needs a volume/NAS, **or** `VIDEO_STORAGE_MODE=database` — see §3b; without either, recordings are lost on redeploy |
| Video transcode | 1 vCPU                 | segmenting saturates the instance while it runs; use short clips for a demo |

Everything here is swappable to paid tiers (or Azure OpenAI) with config changes only —
which is itself a talking point: **the design didn't change, only the deployment target.**

---

## Controlling how much gets logged

Both services take a single environment variable that decides log volume. Nothing in the
code branches on it — every class logs unconditionally through its logging framework, and
the threshold decides what actually reaches the output. Turning logging down therefore costs
nothing at runtime, and turning it up to diagnose something needs no code change and no
rebuild, only a restart.

**Backend** (Spring Boot):

| Key             | Value                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `APP_LOG_LEVEL` | `DEBUG` \| `INFO` (default) \| `WARN` \| `OFF`                           |

Only the `com.agmsentinel` package is bound to it, so raising it to `DEBUG` shows this
application's own reasoning without burying it under Spring, Hibernate and Netty chatter.

**AI service** (FastAPI):

| Key            | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| `AI_LOG_LEVEL` | `DEBUG` \| `INFO` (default) \| `WARNING` \| `ERROR`          |

### What you lose by turning it down

`WARN`/`WARNING` keeps problems and drops the **audit trail**, which is logged at `INFO`:
role and duty changes (who granted whom which authority, and what it replaced), password
changes, meeting activation, passkey registration, and feature-gate refusals. On a system
that holds a governance record, that trail is usually the thing you most want to still have
after something goes wrong — so prefer `INFO` in production and reach for `WARN` only if log
volume is genuinely costing you.

`DEBUG` adds expired-token and per-request detail. Useful while chasing a specific problem,
poor as a steady state: free-tier hosts charge for log volume, and the signal drowns.

---

## Frontend hosting: why a deploy used to break open tabs

Every page is loaded on demand and each build gives those files new hashed names. Three settings in
`frontend/vercel.json` and `frontend/angular.json` make that safe; getting any of them wrong
produces a menu that silently stops working after a deploy, with no error on screen.

**1. The SPA rewrite must not swallow asset requests.** It was `/(.*)`, which matched everything
including JavaScript. A rewrite applies only when no static file matches, so a browser asking for
the *previous* build's chunk got `index.html` back, 200 OK, as `text/html`. The browser refused it —
*"Expected a JavaScript-or-Wasm module script"* — Angular abandoned the navigation, and clicking
Voting or Recordings did nothing whatsoever. The pattern now excludes any path with a file
extension, so a missing chunk returns an honest 404.

**2. `index.html` must never be cached.** It is the file that names every other file. Cached, a
plain refresh reuses it, asks for the same missing chunks and fails identically — which is why only
`Ctrl+Shift+R` recovered it. It is now `max-age=0, must-revalidate` (still cheap: unchanged content
gets a 304), while hashed assets are `immutable` for a year, since a given filename's contents can
never change.

**3. The application recovers by itself anyway.** `AppComponent` watches for `NavigationError`,
recognises a stale-chunk failure, and reloads once — recorded in `sessionStorage` so a genuinely
broken deploy cannot cause an endless refresh loop.

### Source maps

Production builds emit source maps (`sourceMap` in `angular.json`), so a stack trace from a real
user names the file and line rather than `main-VZRWARQA.js:4`. The trade is that readable source is
published alongside the bundle. That is a deliberate choice for this application — there is no
secret in the frontend, and the secrets that matter live on the server — but it is a choice, and
worth revisiting for a codebase where it is not true. Set `"hidden": true` to keep the maps out of
the browser while still producing them for an error tracker.
