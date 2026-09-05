# Live captions — design

**Status: designed, not built.** This document exists so the decisions are on record before any code
is written, because the naive version of this feature is expensive in a way that is not obvious until
it is already running.

Recorded captions are a different feature and already work — see
[VIDEO_LIBRARY.md](VIDEO_LIBRARY.md) section 10a and `ai-service/app/transcribe.py`. This is about
captions appearing **while somebody is speaking**.

---

## 1. What does not exist yet

Worth stating plainly, because "add live captions" sounds like a setting.

The application has **no live audio or video anywhere**. There is no `getUserMedia`, no
`MediaRecorder`, no ingest endpoint. Every recording is a file an admin uploaded and the pipeline
transcoded after the fact. The meeting itself happens on whatever conferencing tool the company
already uses; this application carries the questions, the board, the ballot and the recordings around
it.

So live captions are not a caption feature at all. **They are a live-audio feature**, and the
captioning is the easy half.

## 2. What does exist, and is worth building on

| Piece | Status |
|---|---|
| STOMP WebSocket broker (`/ws`, `/topic`, `/app`) | **built** — carries chat, board state, voting |
| Per-user and broadcast destinations | **built** — see `ChatSocketController` |
| WebSocket authentication | **built** — `WebSocketAuthInterceptor` |
| Speech-to-text via Groq Whisper | **built** — `transcribe.py`, one file per call |
| Caption rendering in the player | **built** — a cue overlay with its own timing |
| Audio capture in the browser | **missing** |
| Chunked upload of live audio | **missing** |
| Streaming or near-streaming STT | **missing** — the current call is one file, one response |
| Live cue fan-out | **transport built, no producer** |

The transport is the part people expect to be hard, and it is already solved. Reuse it.

---

## 3. Shape of the pipeline

```
Presenter's browser                  Backend                    AI service
---------------------                -------                    ----------
getUserMedia (microphone)
  |
MediaRecorder, ~3s chunks
  |  POST /api/captions/chunk
  |--------------------------------> LiveCaptionService
                                       |  accumulate + overlap
                                       |  POST /transcribe -----> Whisper
                                       |  <----------------------  text
                                       |
                                       |  STOMP: /topic/captions
                                       |--------------> every viewer's browser
                                                          |
                                                        live caption bar
```

### Why chunked HTTP rather than streaming audio over the WebSocket

The STOMP broker here is `enableSimpleBroker` — in-memory, in-process, chosen because it needs no
external dependency. It is sized for small JSON messages at human frequency: a question, a vote, a
board update. Pushing continuous binary audio through it would put megabytes per minute per presenter
through a broker that also carries every other realtime feature, on a container that has already been
OOM-killed transcoding a short video.

Chunks over ordinary HTTP keep the audio path away from the broker entirely, and leave the broker
doing what it is good at: fanning small messages out to many subscribers.

### Why roughly 3-second chunks

The trade is latency against accuracy, and Whisper is not a streaming model — it transcribes a window.

- Shorter windows cut words in half at the boundary and lose the context that makes Whisper accurate.
- Longer windows are more accurate and feel unresponsive; past about five seconds captions stop
  reading as live.

Three seconds with a roughly 0.5s overlap between windows, so a word spanning a boundary appears in
both and can be de-duplicated, is the usual compromise. Expect to tune it against real speech rather
than to trust the number.

---

## 4. The costs to decide before building

### API calls

One transcription per chunk per presenter. At 3s chunks that is **20 calls per minute**, 1200 per
hour. Batch captioning of a whole recording is a handful of calls; this is three orders of magnitude
more. Check the provider's rate limit against the length of a real meeting before committing — a free
tier is likely to be exhausted mid-AGM, and it will fail exactly when the room is fullest.

### Backend load

Each chunk is an upload, an outbound HTTP call, and a broadcast, sustained for the length of the
meeting. This is the same class of problem as `VIDEO_WATCH_TRACKING` — a cost that scales with
attendance rather than with deliberate actions — and that feature is off by default for the reason
recorded in VIDEO_LIBRARY.md section 10a. Live captions are heavier still.

### Whose audio

A meeting has many speakers. Capturing one presenter's microphone captions **that microphone**, not
the meeting. Deciding whose audio is the source is a product decision, not a technical one, and it
changes the design:

- **One nominated presenter** — simplest, and captions only them.
- **Every participant** — multiplies the API cost by the number of speakers, and needs speaker
  attribution before it is readable.
- **A feed from the conferencing tool** — most accurate, and depends entirely on what that tool
  exposes.

### Accuracy in public

A caption that mishears a figure in an AGM is worse than no caption. Board meetings discuss numbers,
names and resolutions — precisely what speech-to-text gets wrong. Live captions should be labelled
unverified on screen, and the transcript produced afterwards treated as the record.

---

## 5. Proposed contract

Recorded here so the shape is agreed before any code exists.

### Backend, HTTP

```
POST /api/captions/start     { meetingId }            -> { sessionId }
POST /api/captions/chunk     multipart: sessionId, audio
POST /api/captions/stop      { sessionId }
```

`start` and `stop` bound the session, so a presenter who closes their laptop does not leave a session
consuming quota. `chunk` returns **204** — the caller has no decision to make on the result, and a
body would only invite it to wait for one.

### Backend, STOMP

```
/topic/captions/{meetingId}
  { sessionId, seq, startMs, endMs, text, final }
```

`seq` lets a client drop a late chunk rather than render it out of order. `final` distinguishes a
settled cue from a provisional one, so the UI can show interim text greyed and firm it up — which is
what makes live captions feel responsive rather than laggy.

### Feature flag

`LIVE_CAPTIONS`, **off by default**, gated at the query the way `VIDEO_CHAPTERS` is: with the flag off
the endpoints do not exist and nothing polls.

---

## 6. Recommended first slice

Not the whole pipeline. In order:

1. **The `LIVE_CAPTIONS` flag, off.** Nothing else ships without a switch.
2. **`start` / `stop` / `chunk`** with session bookkeeping and a hard per-session cap on chunk count,
   so a runaway session cannot drain the quota.
3. **Chunk into the existing `/transcribe`.** Reuse the batch call before reaching for a streaming
   provider — 3s windows through the existing path is enough to learn whether the latency is
   acceptable.
4. **Broadcast, and a caption bar** for viewers, behind the flag.
5. **Only then** overlap de-duplication, interim cues, and speaker attribution.

Steps 1 to 4 are a working feature for a single nominated presenter. Step 5 is where most of the
remaining effort lives, and it is worth knowing whether 1 to 4 feel good before paying for it.

---

## 7. When not to build this at all

If the conferencing tool the meeting already runs on offers captions, use those. It has the audio at
source, it adds no network hop, and its accuracy is not this project's problem to own.

Building this is worth it when the requirement is captions **inside this application**, for viewers who
are not in the conferencing tool — which is a real requirement for a shareholder watching a broadcast,
and not one for a board member sitting in the call.
