# Video Library — segmented, on-demand playback

Moderators upload a meeting recording; members watch it on demand in a full-control player. The
recording is **never downloaded in full** — it is cut into short segments on the server, and the
browser fetches only the segments around the playhead.

Media bytes go to one of two backends, chosen with `VIDEO_STORAGE_MODE`:

| Mode | Bytes live in | Use when |
|---|---|---|
| `filesystem` (default) | a NAS share (`VIDEO_NAS_PATH`) | durable disk exists — the normal case |
| `database` | rows in `video_assets` | the host has **no persistent volume** |

Either way the database holds the catalogue row, one row per quality level, and a **segment index**
with one row per slice. See [§4](#4-storage-modes) for how to choose.

Everything in this feature is open source: FFmpeg for segmenting, hls.js (Apache-2.0) for playback.
See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), including the FFmpeg GPL/LGPL distinction.

---

## Table of contents

1. [Why segmentation, in one paragraph](#1-why-segmentation-in-one-paragraph)
2. [The pipeline](#2-the-pipeline)
3. [On-disk layout](#3-on-disk-layout)
4. [Storage modes](#4-storage-modes)
5. [Data model](#5-data-model)
6. [Playback authorisation (playback tickets)](#6-playback-authorisation-playback-tickets)
7. [Manifest rewriting — the subtle part](#7-manifest-rewriting--the-subtle-part)
8. [The progressive fallback (no FFmpeg)](#8-the-progressive-fallback-no-ffmpeg)
9. [API surface](#9-api-surface)
10. [The player](#10-the-player)
11. [Configuration](#11-configuration)
12. [Setting up storage](#12-setting-up-storage)
13. [Operational notes](#13-operational-notes)
14. [What was verified](#14-what-was-verified)

---

## 1. Why segmentation, in one paragraph

A 45-minute recording is a single large file. Handing that to a `<video>` tag means the browser
pulls a long prefix before playback starts, seeking to 40:00 is slow, and a dip in bandwidth stalls
playback. Splitting the same recording into ~6-second segments at several bitrates changes all
three: playback starts after one small segment, seeking anywhere costs one segment, and when
throughput drops the player quietly steps down to a lower bitrate at the next segment boundary
instead of stalling. That is HLS (HTTP Live Streaming), and it is what the "never buffers" feel
actually consists of.

The cost is a transcode step at upload time and a segment index to keep track of the slices — which
is exactly what the pipeline below does.

---

## 2. The pipeline

```
 Moderator                Backend (Spring)                     NAS            Postgres
 ─────────                ────────────────                     ───            ────────
 POST /api/admin/videos/upload-video
   multipart file  ─────► validate ext + size
                          save row  ───────────────────────────────────────►  videos (UPLOADED)
                          stream bytes ──────────────────────► source.mp4
                          status = PROCESSING ─────────────────────────────►  videos
                   ◄───── 200 {status: PROCESSING}     (returns immediately)
                              │
                              │ publishEvent(VideoQueuedEvent)  ── after commit ──┐
                              ▼                                                   │
                    VideoProcessingWorker  (@Async, video-transcode-N) ◄──────────┘
                              │
                              ├─ ffprobe            → duration, w×h, fps, audio? ►  videos
                              ├─ ffmpeg (one pass)  → hls/{720p,480p,360p}/*.ts
                              │     progress ticks  → progressPercent 0…100     ►  videos
                              ├─ poster frame       → poster.jpg
                              ├─ sprite filmstrip   → sprite.jpg
                              └─ read playlists     → segment index             ►  video_renditions
                                                       status = READY           ►  video_segments

 Member
 ──────
 POST /api/videos/list-library            ─► catalogue + a playback ticket per video
 GET …/master.m3u8?t=…      ─► variant list (URIs rewritten, ticket carried forward)
 GET …/r/720p/index.m3u8?t= ─► segment list (ticket appended to every segment URI)
 GET …/r/720p/seg_00007.ts  ─► one ~6s slice        ← repeated as playback advances
```

Three properties worth calling out:

**The upload response does not wait for the transcode.** A 45-minute recording takes minutes to
segment; holding the HTTP request open for that would time out. The POST returns as soon as the
bytes are safely on the NAS, and the admin UI polls `POST /api/admin/videos/video-details` for
`progressPercent`.

**The job is queued after commit, not during.** `VideoLibraryService.upload` publishes a
`VideoQueuedEvent`; `VideoProcessingWorker` consumes it with
`@TransactionalEventListener(AFTER_COMMIT)`. Starting the worker inside the transaction would let it
look up a row its own connection cannot see yet.

**The worker is a separate bean, deliberately.** `@Async` and `@Transactional` are proxy-based, so a
service calling its own annotated method gets neither — the "async" transcode would run inline on
the HTTP thread and each "transaction" would silently join the caller's. Crossing a bean boundary is
what makes both annotations real. Each state transition (`markProcessing`, `updateProgress`,
`storeResult`, …) is its own short transaction, so a database connection is never pinned for the
length of an ffmpeg run and progress is visible while it runs.

---

## 3. On-disk layout

One folder per video, named by its UUID, under `VIDEO_NAS_PATH`:

```
<VIDEO_NAS_PATH>/
└── 0b4bbc56-55a6-4f86-9a0e-ab064b5c80a4/
    ├── source.mp4              the original upload (kept, so re-processing is possible)
    ├── poster.jpg              catalogue thumbnail
    ├── sprite.jpg              seek-preview filmstrip (one grid image)
    └── hls/
        ├── master.m3u8         variant list: bandwidth + resolution per rung
        ├── 720p/index.m3u8     media playlist
        ├── 720p/seg_00000.ts   …one file per ~6s slice
        ├── 480p/…
        └── 360p/…
```

Nothing outside a video's own folder is ever reachable: every relative path from a client goes
through `VideoStorageService.resolveWithin`, which normalises separators and rejects anything that
escapes the base directory. That is the single path-traversal boundary in the feature.

---

## 4. Storage modes

FFmpeg reads and writes real files, so **processing always happens in a filesystem working
directory** regardless of mode. What differs is where the output ends up afterwards.

```
filesystem mode                          database mode
───────────────                          ─────────────
upload → <NAS>/<id>/source.mp4           upload → <work>/<id>/source.mp4
ffmpeg → <NAS>/<id>/hls/…                ffmpeg → <work>/<id>/hls/…
                                                ↓  ingest (before READY)
served straight from those files         video_assets rows  ← served from here
                                                ↓
                                         working directory deleted
```

### Why database mode exists

A container filesystem is **ephemeral**. On a host with no persistent volume — which is every free
PaaS tier — everything written to disk is destroyed on the next redeploy. In filesystem mode that
silently loses every recording. Database mode makes the database the durable store, so the disk is
free to be scratch space.

### What it costs

| | filesystem | database |
|---|---|---|
| Durability on an ephemeral host | ✗ lost on redeploy | ✓ survives |
| Range reads | file seek | SQL binary `substring` |
| Segment fetch | streamed from disk | one row read (~2 MB) |
| Database size | metadata only (KB) | **+ the whole recording** |
| Original kept for re-processing | yes | only if `keep-source=true` |

The size column is the real trade-off. A 40-minute recording at three rungs is roughly **1.5 GB** of
segments — more than a free-tier Postgres allowance (Neon free is 0.5 GB). Database mode is for
*modest* libraries, or for a Postgres you control. It is not a way to get free unlimited storage.

### Details that matter

- **The mode is recorded per video** (`videos.storage_mode`), not read from config at serve time.
  Changing the server default therefore cannot strand recordings written the other way — an old
  filesystem video keeps being served from the filesystem.
- **Segments are stored as they are produced, not in one pass at the end.**
  `VideoSegmentDrainer` sweeps the rung directories every few seconds while FFmpeg is still
  encoding, moves each finished segment into `video_assets` in its own transaction, and deletes it
  from disk. This is what makes the length of a recording irrelevant to the resources a transcode
  needs — see [§4a](#4a-why-the-drain-exists).
- **Ingestion happens before the video is marked READY.** A client must never be told a recording is
  playable while its bytes still live only in a directory about to be deleted. The playlists, poster
  and sprite are the only things left to ingest at that point; the drain has already taken the rest.
- **The original is dropped by default** (`video.database.keep-source=false`). It is only needed for
  re-processing and is far larger than every segment combined. Re-processing then returns a 409
  explaining exactly that, rather than failing obscurely. Set `keep-source=true` to retain it — at
  roughly double the storage.
- **Re-processing rehydrates.** When the original *is* kept, the worker writes it back out to a
  working directory first, because FFmpeg cannot read from a database.
- **A per-file ceiling** (`video.database.max-asset-bytes`, default 64 MiB) rejects writes that would
  buffer something enormous in heap. Segments are a few MB so it never triggers for HLS output; it
  exists to catch an un-segmented source, which is what you get when FFmpeg is missing.

---

## 4a. Why the drain exists

Database mode originally transcoded the whole ladder, then walked the output directory and read
every file into the database in a single transaction. That works fine until the recording gets long,
and then it fails in a way that looks like the host being flaky rather than a bug:

| | short clip | hour-long recording |
|---|---|---|
| Files produced | ~60 | ~2,400 (4 rungs × 6 s segments) |
| Held in heap at commit | ~50 MB | **~2 GB** of `byte[]`, doubled by Hibernate's dirty-check snapshots |
| Peak disk | source + ladder | source + ladder, all at once |
| Outcome on a 512 MB container | fine | OOM-killed part-way through; row stranded in `PROCESSING` |

Nothing in that failure names the real cause. The container simply dies, the platform restarts it,
and `recoverInterrupted()` marks the video FAILED at boot with a generic message.

Draining fixes the shape of the cost rather than raising a limit:

```
FFmpeg ──writes seg_00042.ts.tmp ──rename──► seg_00042.ts
                                                  │
                        every few seconds         ▼
                    VideoSegmentDrainer ──► video_assets row (own transaction)
                                                  │
                                                  ▼
                                            deleted from disk
```

- **Peak heap is one segment** (a few MB), not the whole ladder. It no longer grows with duration.
- **Peak disk is the handful of segments** produced since the last sweep, on top of the source.
- **Work already done survives a crash.** Each segment is committed on its own, so a container
  restart at 90% no longer discards 90% of the encode.
- **The budget is enforced continuously.** Running out of `video.database.max-total-bytes` now
  aborts the encode within a sweep instead of after another hour of work that could not be stored.

Two independent guarantees stop a half-written segment being stored: `-hls_flags temp_file` makes
FFmpeg rename each segment into place only once it is closed, and mid-run the drain also holds back
the highest-numbered file in each rung. The final sweep, after FFmpeg has exited, takes everything.

Because a failed run now leaves real rows behind, both `VideoProcessingWorker`'s failure path and
`recoverInterrupted()` clear the partial ladder — the segment index is written last, so nothing can
be referencing it, and leaving it would silently eat the storage budget.

Turn it off with `video.database.drain-segments=false` to get the old one-pass behaviour back.

### The other half: surviving the encode itself

Draining bounds what *storing* a recording costs. Producing it is a separate budget, and on a
512 MB / fractional-CPU instance both have to be paid at once. Two things keep that affordable:

- **One rung at a time** (`video.hls.parallel-rungs=false`, the default). Encoding the whole ladder
  in one FFmpeg run decodes the source once, which is genuinely less total work — but it starts
  every x264 encoder simultaneously and they allocate their frame buffers up front. Peak memory is
  therefore the sum of the ladder and it lands *seconds into the job*, which is why the symptom is
  a container killed at 2% no matter how short the video is. Sequential encoding makes the peak the
  cost of the largest single rung, at the price of one decode pass per rung.
- **FFmpeg runs at `nice +15`** (`video.tools.niceness`). Capping `-threads` limits how much work
  the encoder does at once; niceness limits how much it does at the JVM's expense. On a shared
  fraction of a CPU that is what decides whether the platform's health check is still answered
  during a transcode — an unanswered one gets the container restarted, stranding the job.

Both trade wall-clock time for staying up. If the host has real memory and cores, set
`VIDEO_HLS_PARALLEL_RUNGS=true` and `VIDEO_FFMPEG_NICENESS=0` to get the speed back.

> **Heap headroom.** FFmpeg's memory comes out of the container limit but not the JVM heap, so the
> heap cap has to leave room for it. The Dockerfile defaults `JAVA_HEAP_PERCENT=35.0` for that
> reason. Setting it higher in the platform's environment — 50, say — silently overrides the
> Dockerfile and reintroduces exactly the OOM this section is about.

---

## 5. Data model

```
videos ──1:N──► video_renditions ──1:N──► video_segments
```

| Table | Holds | Why it exists |
|---|---|---|
| `videos` | title, description, status, delivery mode, progress, duration, w×h, fps, poster/sprite geometry, `storage_dir` | the catalogue row |
| `video_renditions` | one row per ladder rung: name (`720p`), resolution, bitrates, playlist path | drives the quality menu |
| `video_segments` | `seq`, `filename`, `duration_seconds`, **`start_seconds`**, `byte_size` | the **segment index** |

`start_seconds` is the column that makes seeking a lookup instead of a scan:

```sql
SELECT * FROM video_segments
 WHERE rendition_id = ?
   AND start_seconds <= :position
   AND :position < start_seconds + duration_seconds
 ORDER BY start_seconds DESC LIMIT 1;
```

That is `POST /api/videos/find-segment-at` with `{"seconds": 1290}` — "which slice covers
21:30". The upper bound matters: without it, any position past the end of the video would return the
final segment and a nonsense timestamp would look like a valid seek target.

It answers with the position as well as the slice — `segment 215 of 271`, `248 MB` into the rung —
using one aggregate over `byte_size` for everything before it. [Resume](#resuming-a-recording) calls
it, and displays exactly that.

DDL is in [ai-service/db/init.sql](ai-service/db/init.sql). Hibernate's `ddl-auto=update` also
creates these tables; the explicit DDL exists so a fresh Neon/Postgres database matches exactly.

---

## 6. Playback authorisation (playback tickets)

Media URLs are fetched by the browser's own media stack — `<video src>`, hls.js, `<img>` for the
poster. **None of those can attach an `Authorization` header.** Putting the session JWT in the query
string instead would be worse: it is long-lived, grants full API access, and would end up in proxy
logs and browser history.

So media URLs carry a **playback ticket** (`PlaybackTicketService`): a short-lived signed token
scoped to a single video id.

| | Session JWT | Playback ticket |
|---|---|---|
| Grants | the whole API | GET on one video's media |
| Lifetime | hours (session) | `VIDEO_TICKET_TTL`, default 6h |
| Travels in | `Authorization` header | URL query (`?t=…`) |

`SecurityConfig` permits the media routes (GET only) and `VideoController.authorise` enforces the
ticket in code, accepting a valid session as an alternative so `curl` and tests still work:

```java
private Video authorise(UUID id, String ticket) {
    if (!tickets.isValidFor(ticket, id) && !isAuthenticated()) {
        throw new ResponseStatusException(FORBIDDEN, "A valid playback ticket is required…");
    }
    return library.getPlayable(id);
}
```

A ticket minted for video A returns **403** on video B — verified below.

---

## 7. Manifest rewriting — the subtle part

Relative URIs in a playlist are resolved **without** the query string. So if `master.m3u8` were
served verbatim, the player would resolve `720p/index.m3u8` and drop the `?t=…` — and the very next
request would be a 403. Manifests are therefore rewritten on the way out so the ticket is carried
forward onto every child URI:

```
ffmpeg writes                     the browser receives
─────────────                     ───────────────────
#EXT-X-STREAM-INF:BANDWIDTH=…     #EXT-X-STREAM-INF:BANDWIDTH=…      ← tags pass through untouched
720p/index.m3u8                   r/720p/index.m3u8?t=<ticket>

#EXTINF:6.000000,                 #EXTINF:6.000000,
seg_00000.ts                      seg_00000.ts?t=<ticket>
```

Tag lines are never touched, so the `BANDWIDTH` / `RESOLUTION` / `CODECS` attributes the player
needs to choose a rung survive intact. The rewritten URIs stay **relative**, so the feature keeps
working behind any proxy prefix.

One trap worth recording: ffmpeg writes the variant URI with the **platform** separator, so on
Windows the master playlist contains `720p\index.m3u8`. Splitting that on `/` produced a rung named
`720p\index.m3u8` and every variant 404'd. The rewrite now resolves each URI against the video's
stored renditions instead of parsing it as a path, which is separator-independent.

---

## 8. The progressive fallback (no FFmpeg)

FFmpeg is an external binary and may simply not be installed. Rather than fail the upload, the
recording is kept as-is and served over **HTTP Range** requests:

- `deliveryMode = PROGRESSIVE`, and the video is still `READY` and playable.
- `GET /api/videos/{id}/raw` honours `Range`, capped at **4 MiB per response** — bounded chunks are
  what make a plain MP4 behave a bit like segments: the browser issues a series of small requests as
  it plays, and a seek jumps straight to an offset instead of downloading the prefix.
- The admin screen shows a banner, and **Re-process** builds the real ladder once FFmpeg is
  installed.

What is lost without segmentation is adaptive bitrate switching — there is one quality only. Seeking
and playback still work.

---

## 9. API surface

### Member (any signed-in user)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/videos/list-library` | catalogue of READY videos, each with a ticket + media URLs |
| POST | `/api/videos/video-details` | one entry |
| POST | `/api/videos/list-segments` | the segment index |
| POST | `/api/videos/find-segment-at` | which slice covers that second, + its position and byte offset |
| POST | `/api/videos/prepare-download` | resolve what a download will produce |
| POST | `/api/videos/toggle-like` | like / un-like; returns the resulting counts |
| POST | `/api/videos/list-comments` · `add-comment` · `delete-comment` | comments, optionally pinned to a timestamp |
| GET  | `/api/videos/{id}/transcript.vtt?t=` | WebVTT captions |
| POST | `/api/admin/videos/upload-transcript` · `delete-transcript` | attach / remove captions (moderator) |
| GET  | `/api/videos/{id}/download?t=` | save the original, or `&rendition=` to join a rung's segments |

### Media (ticket in the URL; no auth header possible)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/videos/{id}/master.m3u8?t=` | variant list, rewritten |
| GET | `/api/videos/{id}/r/{rendition}/index.m3u8?t=` | media playlist, rewritten |
| GET | `/api/videos/{id}/r/{rendition}/seg_NNNNN.ts?t=` | one segment; cached 1 year, immutable |
| GET | `/api/videos/{id}/raw?t=` | progressive fallback, `Range`-aware |
| GET | `/api/videos/{id}/poster.jpg?t=` · `/sprite.jpg?t=` | thumbnail · seek filmstrip |

Manifests are `no-store` (they embed an expiring ticket). Segments are immutable content, so they
get `private, max-age=1y, immutable` — re-watching or scrubbing backwards costs nothing.

### Moderator (`/api/admin/**`, MODERATOR or ADMIN)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/videos/storage-status` | NAS reachability, free space, ffmpeg version, ladder, limits |
| POST | `/api/admin/videos/list-all-videos` | all videos, including PROCESSING / FAILED |
| POST | `/api/admin/videos/video-details` | poll transcode progress |
| POST | `/api/admin/videos/upload-video` | multipart upload (`file`, `title?`, `description?`) |
| POST  | `/api/admin/videos/update-video-details` | edit title / description |
| POST | `/api/admin/videos/reprocess-video` | rebuild the ladder from the stored original |
| POST   | `/api/admin/videos/delete-video` | remove rows + the whole NAS folder |

---

## 10. The player

[frontend/src/app/components/video-player.component.ts](frontend/src/app/components/video-player.component.ts)
— hls.js driving a custom control surface.

| | |
|---|---|
| Transport | hls.js via Media Source Extensions; native HLS on Safari; plain `src` for progressive |
| Quality | **Auto** (ABR) or pin any rung; switches at a segment boundary, so no re-buffer |
| Speed | 0.25× – 2× |
| Seeking | scrubber with buffered ranges, **filmstrip preview** on hover, click-or-drag |
| Keyboard | space/K play · ←→ 5s · J/L 10s · ↑↓ volume · M mute · F fullscreen · P PiP · 0–9 jump to % · `,`/`.` frame step |
| Also | fullscreen, picture-in-picture, volume, auto-hiding controls, buffering spinner, error recovery with retry |
| Stats panel | live rung, requested rung, bandwidth estimate, buffer ahead, **current segment number**, segments loaded, dropped frames |

The stats panel exists to make the mechanism visible rather than implied — the segment counter
ticking up as playback advances is the feature working.

Two implementation notes:

- **Bounded buffer.** `maxBufferLength: 30` is the setting that keeps playback from becoming a
  download: never hold more than ~30s / 60 MB ahead, however long the recording.
- **Zoneless change detection.** This app runs without zone.js, so native media events don't trigger
  change detection by themselves. Every piece of UI state is a signal written from the listener. The
  scrubber is driven by `requestAnimationFrame` (`timeupdate` fires only ~4×/s and visibly steps),
  while buffered ranges and stats use a 500 ms timer — a signal write per frame is a
  change-detection pass per frame, and a bandwidth readout doesn't need that.

The two video routes are lazy-loaded, keeping hls.js (~250 kB) out of the initial bundle: initial
transfer stays at ~112 kB for members who never open a recording.

### Resuming a recording

Positions are kept in `localStorage` by
[PlaybackProgressService](frontend/src/app/services/playback-progress.service.ts) — per browser, not
per account. A resume point is a convenience, not something worth a table, a migration and a write on
every `timeupdate`; moving it server-side later means swapping two methods and nothing else.

Rules, so a resume is never surprising: under 15 s in is ignored (resuming someone four seconds in
looks like a bug), within 20 s of the end starts over instead, watching to the end clears the point,
and the store is capped at 50 entries, oldest evicted.

**The part that matters is the ordering.** The obvious implementation restores the position once the
manifest has parsed:

```ts
hls.on(Events.MANIFEST_PARSED, () => { element.currentTime = 1290; });   // ✗ costs two segments
```

By then hls.js has already begun fetching fragment 0. That download is thrown away, the buffer is
flushed, and playback stalls waiting for the fragment it actually needs — which is precisely the
buffering a resume is supposed to avoid. So the resume point is resolved *before* anything loads and
handed to hls.js instead:

```ts
const hls = new Hls({ autoStartLoad: false, /* … */ });
hls.on(Events.MANIFEST_PARSED, () => hls.startLoad(resumeAt ?? -1));
```

One segment fetched, no flush, no stall. Native HLS and the progressive fallback cannot do this —
neither exposes a "start here" hook, so both seek after `loadedmetadata` and eat the wasted fetch.
Controlling the requests is what buys the difference, and hls.js is the only path where we do.

Alongside the resume (never blocking it) the player calls `find-segment-at` and captions the jump
with where it landed in the index: *segment 215 of 271 · 480p · 248 MB into 371 MB*.

### Downloading a recording

Two steps, because the client cannot know what is on offer:

1. `POST /api/videos/download-options` → every option, each with a ticketed URL, highest quality first
2. the browser fetches whichever `GET` URL the viewer picks

**Storing the original is not what makes a download possible.** Every rung of the ladder is a
complete copy of the recording at that quality, so each one is its own download — 720p, 480p, 360p.
Discarding the original (`video.database.keep-source=false`, the default) therefore costs *formats*,
not the feature: the uploaded file simply stops being one of the choices.

| `kind` | What it is |
|---|---|
| `ORIGINAL` | the uploaded file, in its own container — listed only while it is still stored |
| `RENDITION` | one rung, rebuilt by joining its stored segments |

Rebuilding a rung is plain concatenation: HLS segments here are MPEG-TS, a self-contained sequence of
188-byte packets, so writing them back to back yields a valid stream with **no remux and no ffmpeg
process** — which is what makes this affordable on a host that cannot spare a subprocess. The cost is
the container: the result is `.ts`, which VLC and ffmpeg open directly but some tools will not. That
is what `note` explains, and it is the one thing keeping an original around would buy you.

Either way the bytes are streamed a chunk at a time via `VideoMediaStore.copyTo`, so serving a
download costs a megabyte of heap rather than a copy of the recording — the same discipline as
[the drain](#4a-why-the-drain-exists). The transfer is a `GET` because a download is a browser
navigation: it streams to disk, shows the browser's own progress, and can be resumed. It is pointed
at a hidden iframe rather than assigned to `location`, so a failed transfer cannot replace the app
with an error page.

---

## 11. Configuration

All optional — the defaults run locally with no setup.

| Env var | Default | Meaning |
|---|---|---|
| `VIDEO_STORAGE_MODE` | `filesystem` | `filesystem` or `database` — see [§4](#4-storage-modes) |
| `VIDEO_DB_MAX_ASSET_BYTES` | `67108864` (64 MiB) | database mode: per-file ceiling |
| `VIDEO_DB_KEEP_SOURCE` | `false` | database mode: also store the original (doubles usage) |
| `VIDEO_HLS_PARALLEL_RUNGS` | `false` | encode the whole ladder in one FFmpeg run — faster, but peak memory is the sum of every rung |
| `VIDEO_FFMPEG_NICENESS` | `15` | scheduling priority for FFmpeg, 0–19 (Linux only; 0 disables) |
| `VIDEO_DB_DRAIN_SEGMENTS` | `true` | database mode: store segments as FFmpeg produces them — see [§4a](#4a-why-the-drain-exists) |
| `VIDEO_DB_DRAIN_SWEEP_SECONDS` | `5` | database mode: how often the drain sweeps for finished segments |
| `VIDEO_NAS_PATH` | `./var/nas/videos` | **the NAS share** — also the working directory in database mode |
| `VIDEO_REQUIRE_NAS` | `false` | `true` = refuse to serve uploads if the share is unreachable |
| `VIDEO_FALLBACK_PATH` | `./var/videos` | used only when the NAS is unreachable and the above is `false` |
| `VIDEO_MAX_UPLOAD_BYTES` | `2147483648` (2 GiB) | per-file ceiling, enforced in code |
| `VIDEO_SEGMENT_SECONDS` | `6` | segment length; also the GOP length |
| `VIDEO_LADDER` | `1080,720,480,360` | rungs; ones taller than the source are skipped |
| `VIDEO_X264_PRESET` | `veryfast` | encode speed / size trade-off |
| `VIDEO_THUMB_INTERVAL` | `10` | seconds between filmstrip tiles |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | absolute paths if not on `PATH` |
| `VIDEO_WORKERS` | `1` | concurrent transcodes (CPU-bound — raise carefully) |
| `VIDEO_TIMEOUT_MINUTES` | `240` | per-transcode timeout |
| `VIDEO_TICKET_TTL` | `21600` (6h) | playback-ticket lifetime |

The container multipart limit was raised to 2 GB for video. Per-endpoint limits are enforced in
code, so the knowledge-PDF path still caps at 25 MB (`AdminController.MAX_PDF_BYTES`) — raising the
container ceiling did not loosen document uploads.

`server.tomcat.max-swallow-size=-1` matters for rejected large uploads: without it Tomcat resets the
connection and the browser shows a network error instead of the 413 JSON.

---

## 12. Setting up storage

### Filesystem mode (default)

```bash
# Windows UNC share
VIDEO_NAS_PATH=\\nas01\media\virtual-meeting\videos

# Linux mount
VIDEO_NAS_PATH=/mnt/nas/virtual-meeting/videos
VIDEO_REQUIRE_NAS=true
```

### Database mode (no persistent volume)

```bash
VIDEO_STORAGE_MODE=database
VIDEO_NAS_PATH=/tmp/video-work    # scratch only — safe to be ephemeral
VIDEO_DB_KEEP_SOURCE=false        # default; keeps the database roughly half the size
```

Watch the database size: a 40-minute recording at three rungs is roughly 1.5 GB. The admin screen
shows the running total. See [§4](#4-storage-modes) before choosing this.

At startup `VideoStorageService` writes and deletes a probe file to prove the share is actually
writable, and logs which path it settled on. The admin screen shows the result, so a
misconfigured share is visible **before** anyone uploads a recording rather than after.

Install FFmpeg for segmentation:

```bash
# Debian/Ubuntu
sudo apt-get install -y ffmpeg
# Windows
winget install Gyan.FFmpeg
```

Without it everything still works, progressively — see [§8](#8-the-progressive-fallback-no-ffmpeg).

---

## 13. Operational notes

- **Transcoding is CPU-bound.** `VIDEO_WORKERS` defaults to 1 for a reason: one 45-minute recording
  can saturate every core. Jobs beyond the limit queue rather than being dropped.
- **The original is kept.** That is what makes **Re-process** possible after a failure, a ladder
  change, or a late FFmpeg install. It roughly doubles storage per video; delete `source.mp4` by
  hand if that matters more than re-processing.
- **Re-process replaces, never merges.** The old renditions and their segment rows are dropped and
  the `hls/` folder is deleted first — a stale `seq` pointing at a rewritten segment file would
  produce corrupt playback.
- **Failures are visible, not silent.** A failed transcode sets `status=FAILED` with the ffmpeg
  diagnostic in `errorMessage`, shown in the admin list. The error extraction deliberately picks
  diagnostic lines rather than the tail of the output: ffmpeg prints the real cause early and then
  per-encoder bitrate tables on the way out, so a plain tail hides the one line that matters.
- **Deleting a video** removes the row (cascading to renditions and segments) and the whole folder.

---

## 14. What was verified

Exercised against a running backend with real FFmpeg 8.1.2 and a real 720p/25fps, 40-second,
13 MB source video.

| Area | Result |
|---|---|
| Upload → async transcode → READY | progress observed 0 → 12 → 22 → … → 99 → 100 |
| Ladder capped to source | 720p source produced 720p/480p/360p; the 1080p rung was correctly skipped |
| Segmentation | 21 segments across 3 rungs, 7 each: 6 × 6.00s + 1 × 4.00s = 40s |
| Segment index | `start_seconds` 0, 6, 12, 18, 24, 30, 36 with per-segment byte sizes |
| Seek lookup | t=0→#0, 5.9→#0, 6.1→#1, 21.5→#3, 39.9→#6; t=40.0 and t=999 → 404 |
| Manifest rewriting | master → `r/720p/index.m3u8?t=…`; media → `seg_00000.ts?t=…`; tags preserved |
| Full playback chain | master → variant → segment walked with **no** `Authorization` header, ticket only |
| Segment integrity | served segment probes as h264 1280×720 + aac, duration 6.023s |
| Poster / sprite | 200, `image/jpeg`, 19.8 kB / 10.7 kB; filmstrip geometry 160×90, 10 cols, 10s |
| Cross-video ticket | ticket for video A on video B → **403** |
| No ticket | segment fetch without `?t=` → **403** |
| Path traversal | `..%2F..%2F..%2Fsource.mp4` → **400** |
| Bogus rendition | `/r/evil/index.m3u8` → **400** |
| Range: none | 200, `Content-Length: 10485760`, `Accept-Ranges: bytes` |
| Range: `bytes=0-` | 206, `Content-Range: bytes 0-4194303/10485760` — capped at 4 MiB |
| Range: `bytes=1000-1999` | 206, exactly 1000 bytes, **byte-identical to the source** |
| Range: `bytes=-500` | 206, `bytes 10485260-10485759/10485760`, byte-identical tail |
| Range: past EOF | 416 with `Content-Range: bytes */10485760` |
| Extension validation | `.exe` upload → 400 listing the allowed formats |
| PATCH metadata | title and description updated |
| Re-process | rebuilt to READY; segment files 21 → 21 (no duplication), 21 rows re-indexed |
| Delete | 204; 0 files left on the NAS; subsequent GET → 404 |
| No-FFmpeg path | `segmentationAvailable:false` → PROGRESSIVE, READY, playable over Range |

### Database storage mode

Re-run of the whole flow with `VIDEO_STORAGE_MODE=database`, against H2 in PostgreSQL-compatibility
mode (so the SQL is exercised the way PostgreSQL would see it).

| Area | Result |
|---|---|
| Schema | `video_assets` created cleanly, 0 DDL failures |
| Transcode → ingest | READY with 21 segments across 3 rungs, same as filesystem mode |
| Working directory | **0 files left** — everything moved into the database |
| Stored size | 26.1 MB reported by `databaseStoredBytes` (segments + manifests + poster + sprite; source correctly skipped) |
| Manifest rewriting | master and media playlists served from the database, URIs rewritten identically |
| Segment fetch | 200, `video/mp2t`, 2 233 440 bytes; probes as h264 1280×720 + aac, 6.023 s |
| Poster / sprite | 200, `image/jpeg`, served from the database |
| Security | no ticket → 403; traversal → 400; bogus rendition → 400 (unchanged) |
| Re-process without source | 409 naming `video.database.keep-source` as the fix |
| Range: `bytes=0-` | 206, `bytes 0-4194303/10485760` — 4 MiB cap holds |
| Range: `bytes=1000-1999` | 206, **byte-identical** to the source |
| Range: deep offset (9 MB in) | **byte-identical** — the SQL `substring` reads the right window |
| Range: `bytes=-500` | 206, byte-identical tail |
| Range: past EOF | 416 with `Content-Range: bytes */10485760` |
| Delete | 204, `databaseStoredBytes` back to 0 |

One bug found by running it, which compilation could not catch: Hibernate renders `@Lob byte[]` as
SQL `blob`, which **PostgreSQL does not have** and which H2 rejects in PostgreSQL-compatibility mode.
Schema export failed while the application still started, so the table was simply absent and the
first request was what discovered it. Fixed by declaring the column as `bytea`, which PostgreSQL uses
natively and H2 accepts as a `VARBINARY` alias. Raising the declared `VARBINARY` length does *not*
fix it — Hibernate promotes anything over the dialect maximum straight back to `blob`.

Three real bugs were found and fixed by running it, which compilation could not have caught:

1. **`-var_stream_map "…,name=720p"`** — ffmpeg requires a colon (`name:720p`). With `=` it rejected
   the whole map ("Invalid keyval") and aborted after the first frame, so no video ever segmented.
2. **`ResourceRegion` from a `ResponseEntity<?>`** — Spring's region converter refuses to write when
   the handler declares a wildcard body type, making every Range request a 500. Replaced with a
   bounded channel read that sets `Content-Range` / `Content-Length` explicitly.
3. **Windows path separator in the master playlist** — ffmpeg wrote `720p\index.m3u8`, so
   path-splitting on `/` produced a broken rung name and every variant 404'd.

Plus two smaller corrections: `-ac 2` repeated per rung is a global option (ffmpeg warned and applied
only the last), now stream-qualified as `-ac:a:i 2`; and the seek query returned the final segment
for any position past the end of the video.

---

## Files

**Backend** — `backend/src/main/java/com/agmsentinel/`

| File | Role |
|---|---|
| `config/VideoProperties.java` | all `video.*` configuration |
| `config/VideoAsyncConfig.java` | the dedicated, deliberately small transcode pool |
| `model/Video.java`, `VideoRendition.java`, `VideoSegment.java`, `VideoStatus.java` | entities |
| `repository/Video*Repository.java` | queries, including the seek lookup |
| `service/VideoStorageService.java` | the NAS: path resolution boundary + bounded range reads |
| `service/VideoTranscodeService.java` | ffprobe, the HLS ladder, poster, filmstrip |
| `service/VideoLibraryService.java` | upload, lifecycle, state transitions |
| `service/VideoProcessingWorker.java` | the async transcode job |
| `service/VideoUrlFactory.java` | ticketed URL construction |
| `security/PlaybackTicketService.java` | mint / verify playback tickets |
| `controller/VideoController.java` | catalogue, segment index, media, manifest rewriting, Range |
| `controller/VideoAdminController.java` | upload and management |

**Frontend** — `frontend/src/app/`

| File | Role |
|---|---|
| `services/video.service.ts` | API client, wire types, upload progress |
| `components/video-player.component.ts` | the player |
| `pages/videos.component.ts` | member library (`/recordings`) |
| `pages/video-admin.component.ts` | moderator management (`/videos`) |
