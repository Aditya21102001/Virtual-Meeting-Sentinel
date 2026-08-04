# Video Module — Implementation Specification

A portable specification for the on-demand video feature: segmented adaptive playback, a
resource-bounded transcode pipeline, two interchangeable storage backends, and the engagement layer
around it.

Written to be implementable **outside this codebase**. Where something is Spring- or Angular-specific
the equivalent concept is named, so the design survives the translation.

The runnable extract of everything described here is in [`video-module/`](../video-module/) — see
[§14](#14-the-extracted-module).

---

## Table of contents

1. [What the module does](#1-what-the-module-does)
2. [Requirements](#2-requirements)
3. [Tools and technology](#3-tools-and-technology)
4. [Architecture](#4-architecture)
5. [Data model](#5-data-model)
6. [The transcode pipeline](#6-the-transcode-pipeline)
7. [Storage backends](#7-storage-backends)
8. [Playback](#8-playback)
9. [Authorisation](#9-authorisation)
10. [Engagement, transcripts, download, share](#10-engagement-transcripts-download-share)
11. [API surface](#11-api-surface)
12. [Configuration](#12-configuration)
13. [Operating within a small container](#13-operating-within-a-small-container)
14. [The extracted module](#14-the-extracted-module)
15. [Porting notes](#15-porting-notes)
16. [Diagrams](#16-diagrams)

---

## 1. What the module does

A moderator uploads a recording. The server cuts it into short segments at several bitrates. A member
watches it on demand, and the browser fetches **only the seconds it is about to play**.

The single most important property, and the reason for nearly every design decision below:

> A 45-minute recording is never downloaded. Playback starts after one ~6-second segment, seeking
> anywhere costs one segment, and when throughput drops the player steps down to a lower bitrate at
> the next segment boundary instead of stalling.

That is HLS (HTTP Live Streaming). The cost is a transcode at upload time and a **segment index** to
track the slices — which is what most of this module is.

---

## 2. Requirements

### Functional

| # | Requirement |
|---|---|
| F1 | A moderator uploads a video file; the response returns before transcoding completes |
| F2 | The upload is transcoded into an adaptive ladder (multiple resolutions), segmented into ~6 s slices |
| F3 | Transcode progress is observable (0–100) while it runs |
| F4 | A member browses a catalogue of ready recordings, with thumbnails and durations |
| F5 | Playback adapts to available bandwidth without stalling; the viewer may also pin a quality |
| F6 | Seeking to any point costs one segment request, not a prefix of the file |
| F7 | Playback resumes where the viewer left off, without a wasted segment fetch |
| F8 | Recordings can be downloaded — in any available quality |
| F9 | Members can like and comment; comments may point at a timestamp |
| F10 | Captions can be attached (`.vtt`/`.srt`) and searched; every line is a seek target |
| F11 | A recording can be shared by link, optionally at a moment |
| F12 | A failed transcode can be re-processed from the stored original |
| F13 | Deleting a recording removes every trace of it |

### Non-functional

| # | Requirement | How it is met |
|---|---|---|
| N1 | **Transcode cost must not scale with recording length** | Segments drain to storage as FFmpeg produces them ([§6.3](#63-the-drain)) |
| N2 | **The API stays responsive during a transcode** | FFmpeg runs `nice`d, thread-capped, on a dedicated pool ([§13](#13-operating-within-a-small-container)) |
| N3 | **Media survives a host with no persistent disk** | Database storage mode ([§7](#7-storage-backends)) |
| N4 | Serving a segment costs the size of the segment | Streamed / range-read, never buffered whole ([§7.3](#73-reading)) |
| N5 | A client may only reach media inside its own recording | Single path-traversal boundary ([§9.2](#92-path-traversal)) |
| N6 | Media URLs work in `<video>`, `<img>` and native HLS | Ticket in the URL, not a header ([§9.1](#91-playback-tickets)) |
| N7 | A crash mid-transcode must not strand a recording forever | Boot-time recovery ([§6.5](#65-failure-recovery)) |
| N8 | Rendering a catalogue page is O(1) queries, not O(n) | Batched engagement counts ([§10.1](#101-likes-and-comments)) |

---

## 3. Tools and technology

| Layer | Choice | Why this one |
|---|---|---|
| Transcoding | **FFmpeg / FFprobe** (subprocess) | The only realistic option. Invoked as a process, so the module has no native bindings and degrades cleanly when absent |
| Streaming format | **HLS**, MPEG-TS segments | Plain HTTP, cacheable, works behind any CDN or proxy. MPEG-TS segments also **concatenate** into a valid file, which the download feature relies on |
| Browser playback | **hls.js** (Apache-2.0) via Media Source Extensions | Only Safari plays HLS natively. hls.js also exposes the level list, bandwidth estimate and segment events the UI shows |
| Captions | **WebVTT** | The only format `<track>` accepts; SRT is converted on upload |
| Backend | Spring Boot 3 (Java 21) | Concepts used: DI, declarative transactions, async execution, transactional events |
| Persistence | JPA/Hibernate + **PostgreSQL** | `BYTEA` for database storage mode; SQL `substring` for binary range reads |
| Frontend | Angular (standalone, **signals**, zoneless) | Media events don't trigger change detection without zones, so every piece of UI state is a signal |
| Auth | JWT bearer + short-lived **playback tickets** | See [§9](#9-authorisation) |

**Hard dependencies:** FFmpeg + FFprobe on `PATH`; PostgreSQL (or any RDBMS with a binary column and
binary `substring`); a writable directory for transcode scratch space — even in database mode.

---

## 4. Architecture

### 4.1 Layers

```
┌──────────────────────────────────────────────────────────────┐
│ Web        VideoController          VideoAdminController      │
│            (catalogue, media,       (upload, manage,          │
│             engagement, download)    transcripts)             │
├──────────────────────────────────────────────────────────────┤
│ Domain     VideoLibraryService   VideoEngagementService       │
│            VideoUrlFactory       PlaybackTicketService        │
├──────────────────────────────────────────────────────────────┤
│ Processing VideoProcessingWorker  ← @Async, off-request       │
│            VideoTranscodeService  ← drives FFmpeg             │
│            VideoSegmentDrainer    ← disk → storage, mid-run   │
│            SubtitleConverter                                  │
├──────────────────────────────────────────────────────────────┤
│ Storage    VideoMediaStore    ← (video, relative path) façade │
│            VideoStorageService ← filesystem + traversal guard │
├──────────────────────────────────────────────────────────────┤
│            PostgreSQL          NAS volume        FFmpeg       │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 The three rules that shape it

**1. The upload response does not wait for the transcode.** A 45-minute recording takes minutes to
segment. The POST returns as soon as bytes are stored, with `status=PROCESSING`; the UI polls for
progress. Holding the connection open would time out.

**2. The worker is a separate bean.** `@Async` and `@Transactional` are proxy-based, so a service
calling *its own* annotated method gets neither — the "async" transcode would run inline on the HTTP
thread and each "transaction" would silently join the caller's. Crossing a bean boundary is what
makes both real.

> **Porting:** any framework using proxies/decorators for async and transactions has this trap.
> Without one, run the transcode on an explicit worker queue and keep each state transition in its
> own short transaction.

**3. Every state transition is its own short transaction.** One transaction spanning the FFmpeg run
would pin a database connection for minutes and make progress invisible until the end.

### 4.3 The storage façade

Every caller addresses media as `(video, relative path)` — `hls/720p/seg_00042.ts`, `poster.jpg` —
and `VideoMediaStore` answers from either the filesystem or the database according to the video's
**own** `storage_mode`. Nothing upstream branches on the backend.

Because the mode is per video, flipping the server default cannot strand existing recordings.

---

## 5. Data model

Full DDL: [`video-module/db/schema.sql`](../video-module/db/schema.sql). ER diagram: `er` in
[`diagrams.puml`](../video-module/docs/diagrams.puml).

| Table | Holds | Why it exists |
|---|---|---|
| `videos` | catalogue row, status, geometry, storage mode | one per recording |
| `video_renditions` | one row per ladder rung | bitrate/resolution per quality |
| `video_segments` | **the segment index** — seq, filename, duration, start, size | turns "seek to 21:30" into "fetch segment 215" |
| `video_assets` | media bytes (`BYTEA`) | database storage mode only |
| `video_likes` | one row per member per video | a counter cannot answer "have *I* liked this" |
| `video_comments` | flat comments, optional timestamp | |

### Two deliberate separations

**Segment index vs. segment bytes.** `video_assets` is a separate table rather than a `data` column
on `video_segments`. A seek lookup or a playlist listing must never drag megabytes of payload with
it.

**Blob rows hold a plain `video_id`, not a relation.** Loading one asset must not pull an entire
`Video` graph. Deletion is therefore explicit in code, with `ON DELETE CASCADE` as a database-level
backstop.

### Cascade behaviour on delete

| What | Mechanism |
|---|---|
| renditions → segments | JPA cascade **and** FK `ON DELETE CASCADE` |
| assets, likes, comments | explicit deletion in code + FK cascade as backstop |
| files on the NAS | explicit directory removal — **cannot roll back** |

Not reachable by deletion: already-issued playback tickets (stateless, expire on their own — the
media is gone so they 404), and client-side resume points in `localStorage`.

---

## 6. The transcode pipeline

### 6.1 Probe

FFprobe yields duration, dimensions, frame rate and audio presence. Two details matter:

- **Cover art** is stored as a video stream; a real track is distinguished by not being `mjpeg`.
- **Rotation metadata**: a phone records landscape and marks it 90°. The dimensions are swapped so
  the ladder is built on the **displayed** shape. FFmpeg auto-rotates on decode, so the frames match.

### 6.2 The ladder

Configured heights, capped to the source — a 480p source never produces a 1080p rung, because
upscaling costs CPU and gains nothing. Each rung gets bitrate targets interpolated from standard VOD
values.

**Keyframe alignment is what makes the whole thing work.** The GOP is forced to the segment length
(`-force_key_frames expr:gte(t,n_forced*N)`), so every segment begins on an IDR frame. That is what
makes a segment independently decodable — and therefore what lets a player switch rungs or seek at
any boundary.

### 6.3 The drain

> **This is the design decision that matters most.**

The obvious implementation transcodes everything, then walks the output and stores it. That works for
a two-minute clip and fails for a long recording:

| | short clip | hour-long recording |
|---|---|---|
| Files produced | ~60 | ~2,400 (4 rungs × 6 s) |
| Held in memory at commit | ~50 MB | **~2 GB** — every file as a managed blob entity, doubled by dirty-check snapshots |
| Peak disk | source + ladder | source + ladder, simultaneously |

`VideoSegmentDrainer` instead sweeps the output directories every few seconds **while FFmpeg is still
encoding**, moves each finished segment into storage in its own transaction, and deletes it from
disk:

- **Peak memory is one segment.** It no longer grows with duration.
- **Peak disk is the segments produced since the last sweep.**
- **Work already done survives a crash** — each segment is committed independently.
- **The storage budget is enforced continuously**, aborting the encode within a sweep rather than
  after another hour of work that cannot be stored.

Two independent guarantees prevent storing a half-written segment: `-hls_flags temp_file` makes
FFmpeg rename each segment into place only once closed, and mid-run the drain also holds back the
highest-numbered file per rung. The final sweep, after FFmpeg exits, takes everything.

Because drained segments are deleted from disk, the playlist reader can no longer `stat` them for
size — so the drain records what it stored and feeds those sizes back into the index.

### 6.4 Sequential vs. one-pass encoding

| | one pass | one rung at a time (**default**) |
|---|---|---|
| Decodes | 1 | N |
| Encoders alive | N | 1 |
| Peak memory | **sum of the ladder** | largest single rung |
| When peak arrives | seconds in, at encoder init | same, but N× smaller |

One pass is faster. It is not the default because its failure mode is the container being killed
seconds into the job regardless of how short the video is. The sequential path writes the master
playlist by hand, since `-master_pl_name` only applies to a multi-variant run.

### 6.5 Failure recovery

Nothing survives a container restart: the async pool and the FFmpeg subprocess go with it, leaving a
row stuck in `PROCESSING` that nothing will ever move again.

At boot, stranded rows are marked `FAILED` — **not re-queued**. The likeliest reason a transcode died
with the container is that it exhausted the host, and restarting it automatically would loop the
crash. Re-processing stays a deliberate action. Partial ladders are cleared at the same time; the
segment index is written last, so nothing can be referencing them.

A second boot check flags recordings whose media has vanished — the signature of a host with no
persistent volume, where rows survive in an external database while the container filesystem is
wiped.

---

## 7. Storage backends

### 7.1 The two modes

| | `filesystem` | `database` |
|---|---|---|
| Bytes live in | a volume / NAS share | `video_assets` rows |
| Use when | durable disk exists | **the host has no persistent volume** |
| Serving | streamed from disk | read from `BYTEA` |
| Cost | none | database size; not bulk storage |

Database mode exists because a container filesystem is ephemeral: on a free PaaS tier everything
written to disk is destroyed on redeploy, silently losing every recording.

### 7.2 Processing is always on disk

FFmpeg reads and writes real files, so processing happens in a filesystem working directory
regardless of mode. In database mode that directory is **scratch space**: its contents are persisted
and it is then deleted, so the host's disk is free to be ephemeral.

### 7.3 Reading

Both backends read only what is asked for:

- **Whole file** — `FileSystemResource` (streamed) or the stored bytes.
- **Byte range** — a seeked channel read, or SQL `substring(data from :start+1 for :len)`.
- **Bulk copy** — 1 MB windows, so streaming a download costs a chunk of memory rather than a copy of
  the recording.

The cost of a range is the size of the range, not the size of the file. That is what makes
progressive `Range` playback work without buffering a 2 GB file into memory.

### 7.4 Budgets (database mode)

Per-upload ceiling, per-asset ceiling and a total budget, checked up front as an estimate and
re-checked against the real total during the drain. Failing during the drain aborts the encode.

---

## 8. Playback

### 8.1 Manifest rewriting — the subtle part

FFmpeg writes variant URIs like `720p/index.m3u8`. Those are resolved by the player **relative to the
master playlist, without the query string** — so the ticket would be lost and the very next request
would 403.

Manifests are therefore rewritten on the way out: each variant URI is replaced with this
controller's route carrying the ticket, and each segment URI in a media playlist gets the ticket
appended.

Two traps worth naming:

- Variant URIs are matched against the video's **stored rendition paths**, not parsed as paths.
  FFmpeg writes the platform separator, so on Windows the master contains `720p\index.m3u8` —
  splitting on `/` alone silently produces a rung named `720p\index.m3u8` and every variant 404s.
- Manifests embed an expiring ticket, so they are served `no-store`. Segments are immutable and get a
  one-year immutable cache.

### 8.2 Progressive fallback

With no FFmpeg the original is served over HTTP `Range` in bounded (4 MiB) chunks. Playback and
seeking still work; there is simply no ladder to switch between. Only browser-decodable containers
actually play, and the UI says so plainly rather than reporting "no quality switching" for a file
that will not play at all.

### 8.3 Client behaviour

- **Bounded buffer** (`maxBufferLength: 30`) is what keeps playback from becoming a download.
- **Resume** resolves the position *before* anything loads and hands it to `startLoad(seconds)`, so
  the first fetch is the right segment. Setting `currentTime` after the manifest parses instead
  fetches fragment 0, throws it away, and stalls — precisely the buffering a resume should avoid.
  Native HLS and progressive playback expose no such hook and must eat that wasted fetch.
- **Captions are parsed in JavaScript**, not handed to `<track>`. A cross-origin `<track>` requires
  `crossorigin="anonymous"` on the `<video>`, which also changes how the media and poster are
  fetched — letting a secondary feature break playback.
- **Rotation** is a CSS transform (viewer-side, zero server cost). Rotating permanently would mean
  re-encoding the ladder, because MPEG-TS carries no rotation flag.

---

## 9. Authorisation

### 9.1 Playback tickets

Media requests come from the browser's own media stack — `<video src>`, `<img src>`, native HLS,
`<track>` — which **cannot attach an `Authorization` header**. So each media URL carries a
short-lived, signed ticket scoped to **one video**, distinguished from a session token by a `typ`
claim so it can never be used as a login.

Consequences to keep in mind when porting:

- Media routes must be `GET` and permitted at the framework's security layer, then authorised inside
  the handler by the ticket.
- Tickets cannot be revoked (they are stateless). One issued just before deletion stays valid until
  it expires — harmless, because the media is gone.

### 9.2 Path traversal

Every client-supplied relative path goes through **one** resolver, which folds separators, normalises,
and rejects anything escaping the video's own folder. Nothing else in the module is allowed to build
a media path. Segment requests additionally supply only a bare filename, validated against a pattern,
and the directory is derived from the rendition's stored playlist path — so a request can only ever
name a file inside its own rung.

### 9.3 Ownership

Comment deletion is decided in the service, not the controller: own comment, or the caller moderates.
Authors come from the authenticated principal, never the request body.

---

## 10. Engagement, transcripts, download, share

### 10.1 Likes and comments

Likes are **rows, not a counter**. A counter cannot answer "have I liked this" — the half the button
needs — and two simultaneous likes race on an increment. A unique constraint on `(video_id, user)`
makes double-liking impossible at the database.

Counts are **batched**: like counts, comment counts and "which did I like" for a whole catalogue page
resolve in **three queries regardless of page size**. Resolved naively that is 60 queries for a
20-card page.

### 10.2 Transcripts

Uploaded, not generated. Producing one means speech-to-text, which on a host that already struggles
to transcode would reintroduce the exact resource exhaustion the pipeline was designed to avoid.

SRT is normalised to WebVTT on upload — handling BOM, CRLF, cue numbers and 1–3 digit milliseconds,
each of which silently breaks a strict parser.

### 10.3 Download

Storing the original is **not** what makes a download possible: every rung is a complete copy of the
recording at that quality, so each is its own download option. Discarding the original costs
*formats*, not the feature.

Rebuilding a rung is plain concatenation — HLS segments are MPEG-TS, self-contained sequences of
188-byte packets — so it needs **no remux and no FFmpeg process**. The cost is the container: `.ts`
rather than `.mp4`.

### 10.4 Share

A deep link into the app carrying the video id and an optional start time, **not** a public URL:
playback is authorised per viewer, so a link bypassing sign-in would bypass that too. The recipient
signs in and gets their own ticket — which also means a shared link stops working for someone who has
left.

The guard must carry the attempted URL through the login redirect, or the link is lost precisely in
the case it exists for. Accept **only app-relative** return paths — an absolute or protocol-relative
(`//host`) value turns the login page into an open redirect.

---

## 11. API surface

Every data endpoint is a named `POST` with identifiers in the body. Media is `GET`, because the
browser issues those requests itself.

### Member

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/videos/list-library` | catalogue + a ticket per video |
| POST | `/api/videos/video-details` | one entry |
| POST | `/api/videos/list-segments` | the segment index for a rung |
| POST | `/api/videos/find-segment-at` | which slice covers second N, + position and byte offset |
| POST | `/api/videos/toggle-like` | like / un-like, returns counts |
| POST | `/api/videos/list-comments` · `add-comment` · `delete-comment` | comments |
| POST | `/api/videos/download-options` | every quality available to download |

### Media — `GET`, ticket in the URL

| Path | Serves |
|---|---|
| `/{id}/master.m3u8?t=` | variant list, URIs rewritten |
| `/{id}/r/{rung}/index.m3u8?t=` | media playlist, ticket appended per segment |
| `/{id}/r/{rung}/seg_NNNNN.ts?t=` | one segment; cached 1 year, immutable |
| `/{id}/raw?t=` | progressive fallback, `Range`-aware |
| `/{id}/poster.jpg?t=` · `/{id}/sprite.jpg?t=` | thumbnail · seek filmstrip |
| `/{id}/transcript.vtt?t=` | WebVTT captions |
| `/{id}/download?t=[&rendition=]` | save to disk |

### Moderator

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/videos/storage-status` | storage + FFmpeg health |
| POST | `/api/admin/videos/list-all-videos` | all videos, including PROCESSING/FAILED |
| POST | `/api/admin/videos/upload-video` | multipart upload |
| POST | `/api/admin/videos/update-video-details` · `reprocess-video` · `delete-video` | manage |
| POST | `/api/admin/videos/upload-transcript` · `delete-transcript` | captions |

---

## 12. Configuration

Full annotated reference: [`video-module/config/application-video.yml`](../video-module/config/application-video.yml).

| Setting | Default | Meaning |
|---|---|---|
| `storage-mode` | `filesystem` | `filesystem` or `database` |
| `nas-path` / `fallback-path` | `./var/...` | media root; fallback when the share is unreachable |
| `max-upload-bytes` | 2 GiB | per-upload ceiling |
| `hls.segment-seconds` | `6` | segment length — the HLS VOD sweet spot |
| `hls.ladder` | `1080,720,480,360` | rungs, capped to the source |
| `hls.preset` | `veryfast` | x264 speed/size trade-off |
| `hls.parallel-rungs` | `false` | **true = all rungs in one pass** (faster, sums memory) |
| `hls.thumbnail-interval-seconds` | `10` | `0` disables the sprite — and its extra full decode |
| `tools.enabled` | `true` | `false` forces progressive delivery |
| `tools.threads` | `1` | FFmpeg parallelism |
| `tools.niceness` | `15` | scheduling priority (Linux) |
| `tools.workers` | `1` | concurrent transcodes |
| `database.max-total-bytes` | 2 GiB | total budget for database mode |
| `database.keep-source` | `false` | retain originals (roughly doubles usage) |
| `database.drain-segments` | `true` | store segments as FFmpeg produces them |
| `playback.ticket-ttl-seconds` | 6 h | media ticket lifetime |

---

## 13. Operating within a small container

A 512 MB instance hosting both a JVM and FFmpeg is the hardest environment this module targets, and
several decisions exist only because of it. If you are deploying somewhere comfortable, treat this
section as background.

**The JVM is bigger than its heap.** `MaxRAMPercentage` bounds the heap; metaspace, code cache,
thread stacks and direct buffers sit outside it and are unbounded by default. Cap them, or "35% heap"
can still mean a resident process far past 35% — and every megabyte is one FFmpeg cannot have.

**Request threads are memory.** A default server pool of 200 threads reserves 200 stacks. An
application serving a meeting needs a small fraction of that.

**FFmpeg must lose the CPU fight.** Capping threads limits how much work it does at once; `nice`
limits how much it does *at the application's expense*. On a fractional-CPU instance that is the
difference between the health check being answered during a transcode and the platform restarting the
container because it went unanswered.

**Spawning matters.** On Linux the default process-launch mechanism forks, briefly duplicating the
parent's address space. The pages are copy-on-write but the kernel still accounts for the
reservation, so a JVM holding a few hundred MB can trip the cgroup limit *at the moment it starts
FFmpeg* — a container that dies at 0% of every transcode regardless of video size. Use `posix_spawn`.

**x264 holds frames.** Its resident memory is dominated by the lookahead queue and reference list,
each a full decoded frame. Cutting `rc-lookahead` and `ref` costs a little compression and saves tens
of megabytes.

**The tail is expensive.** Poster and sprite generation are additional FFmpeg processes *after* the
encode, and the sprite decodes the entire video a second time. On a container at its ceiling, that is
a plausible failure point at ~99% progress. Disabling the sprite removes a whole decode pass.

**Log the effective budget.** The heap ceiling can come from the command line, `JAVA_TOOL_OPTIONS` or
`_JAVA_OPTIONS`, and the JVM logs only that it *read* the environment variable, never which value
won. Print the resolved number at startup; diagnosing this from flags alone invites confident wrong
answers.

**A delete can cost as much as a write.** Spring Data's derived `deleteBy…` methods are not `delete`
statements — they select the matching entities and remove them one at a time. On a table whose rows
*are* media, that loads every payload into heap, doubled by Hibernate's dirty-check snapshots and
again by the driver's buffered result set, so removing a single fifty-megabyte recording was enough
to exhaust the heap and kill the process mid-request. Blob tables need bulk `@Modifying @Query`
deletes, and the test for one has to assert on Hibernate's entity-load count: "the rows are gone"
passes either way, so it cannot tell the two apart.

**The 502/CORS confusion.** When the kernel kills the container, the platform's proxy returns 502 —
and that error page carries no CORS headers, so the browser reports a CORS failure. The CORS message
is a symptom, never the cause. Say so in the UI, or every such incident gets misdiagnosed.

---

## 14. The extracted module

```
video-module/
├── backend/
│   ├── config/       VideoProperties, VideoAsyncConfig
│   ├── controller/   VideoController, VideoAdminController
│   ├── dto/          VideoDtos
│   ├── model/        Video, VideoRendition, VideoSegment, VideoAsset,
│   │                 VideoLike, VideoComment, VideoStatus, VideoStorageMode
│   ├── repository/   6 Spring Data interfaces
│   ├── security/     PlaybackTicketService
│   └── service/      VideoLibraryService, VideoProcessingWorker,
│                     VideoTranscodeService, VideoSegmentDrainer,
│                     VideoMediaStore, VideoStorageService,
│                     VideoUrlFactory, VideoEngagementService,
│                     SubtitleConverter
├── frontend/
│   ├── components/   video-player.component.ts
│   ├── pages/        videos.component.ts, video-admin.component.ts
│   └── services/     video.service.ts, playback-progress.service.ts
├── config/           application-video.yml       (database mode — no durable disk)
│                     application-video-nas.yml   (NAS mode — the normal shape)
├── db/               schema.sql                  (standalone DDL, both modes)
│                     schema-nas.sql              (without video_assets)
└── docs/             NAS-DEPLOYMENT.md           (mounting, capacity, backup, tuning)
                      diagrams.puml               (11 diagrams)
```

**Deploying with a volume or a NAS?** Read
[`video-module/docs/NAS-DEPLOYMENT.md`](../video-module/docs/NAS-DEPLOYMENT.md) and use the two `-nas`
files. That is the simpler deployment: no drain, no storage budget, no `video_assets`. The
database-mode files target a host with *no* durable disk — a harder and less common problem, and the
reason several designs in this document look more defensive than they otherwise would.

Every file is copied verbatim, including its comments — which carry the reasoning behind the
non-obvious decisions and are the most useful part to read first.

---

## 15. Porting notes

### What is genuinely portable

The pipeline shape, the segment index, the drain, the ticket scheme, the manifest rewriting, the
storage façade, and every constraint in [§13](#13-operating-within-a-small-container). None of it
depends on Spring or Angular.

### What to replace

| This module uses | Replace with |
|---|---|
| `@Async` + `@TransactionalEventListener(AFTER_COMMIT)` | any job queue, enqueued **after** the upload transaction commits |
| `@Transactional` per state transition | explicit short transactions — never one spanning the FFmpeg run |
| Spring Data repositories | any data access; the queries are ordinary SQL |
| `StreamingResponseBody` | your framework's streaming response |
| JWT tickets | any signed, expiring, single-resource token |
| Angular signals | any reactive state; the constraint is that media events must not be assumed to trigger re-render |

### Order to build it in

1. **Entities + schema**, then upload → store → `PROCESSING`.
2. **Probe + single-rung transcode**, playlists read back into the segment index.
3. **Playback**: ticket issuing, manifest rewriting, segment serving. *Verify a video plays before
   adding anything else.*
4. **The ladder** and rung selection.
5. **The drain** — required before any recording longer than a few minutes.
6. Poster, sprite, progressive fallback, re-process, boot recovery.
7. Engagement, transcripts, download, share.

### Traps that cost real time

- Manifest URIs lose the query string on relative resolution — rewrite them.
- FFmpeg writes platform path separators into the master playlist.
- `-var_stream_map` uses `name:720p`, **not** `name=720p`; the wrong one aborts after the first frame.
- FFmpeg will not create the `%v` output directories — pre-create them.
- Draining segments means the playlist reader can no longer `stat` them for size.
- Replacing a card object to update a like count will restart playback if the player's effect tracks
  the whole object rather than the identity that justifies a reload.

---

## 16. Diagrams

All in [`video-module/docs/diagrams.puml`](../video-module/docs/diagrams.puml) — render with
`plantuml diagrams.puml`, or paste a block into <https://www.plantuml.com/plantuml>.

| Block | Shows |
|---|---|
| `system-context` | actors, browser, server, FFmpeg, storage |
| `component` | backend layering and dependencies |
| `er` | the data model |
| `class-core` | entities + services and the relationships that matter |
| `seq-upload` | upload → transcode → READY, including the drain |
| `seq-playback` | adaptive playback and manifest rewriting |
| `seq-resume` | resume without a wasted fetch |
| `state-video` | recording lifecycle, including boot recovery |
| `flow-storage` | the filesystem/database decision |
| `seq-download` | download with quality options |
