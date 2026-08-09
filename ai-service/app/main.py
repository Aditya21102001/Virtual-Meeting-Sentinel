"""FastAPI entrypoint for the AI service.

Endpoints (called by the Spring Boot backend over HTTP):
  GET  /health          liveness + readiness (used by UptimeRobot keep-warm)
  POST /ingest          embed + cluster one question, return its cluster assignment
  POST /draft           RAG-draft a grounded answer for a cluster
  GET  /clusters        current ranked cluster board

Design note: we expose HTTP so the system works on free tiers *without* a shared Redis.
The Redis Streams path (see consumer.py) is the production-scale ingest; flip QUEUE_MODE
to enable it. Both feed the same OnlineClusterer.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from fastapi.responses import FileResponse

import logging
import os

from starlette.concurrency import run_in_threadpool

from .clustering import get_clusterer
from .config import get_settings
from .embeddings import get_embeddings
from .rag import get_kb, knowledge_file_path
from .transcribe import TranscriptionUnavailable, transcribe_to_vtt
from .schemas import (
    ChatRequest, ChatResponse, ClusterView, DraftRequest, DraftResponse,
    IngestRequest, IngestResponse, KnowledgeRemoveRequest, RetainMeetingRequest,
    SearchHit, SearchRequest,
    TranscriptIndexRequest,
)


# ---------------------------------------------------------------------------
# Logging
#
# basicConfig here is load-bearing, not boilerplate. Under uvicorn the root logger has no
# handler of its own, so module loggers created with getLogger(__name__) emit NOTHING —
# every log call in this service was silently discarded. That is how a crash loop ran for
# hours showing only the process dying, with no line saying which stage it died in.
#
# One env var decides the volume, matching APP_LOG_LEVEL on the backend:
#   AI_LOG_LEVEL=DEBUG   per-chunk indexing and retrieval detail; noisy, for diagnosis
#   AI_LOG_LEVEL=INFO    the default: startup stages, indexing runs, failures
#   AI_LOG_LEVEL=WARNING problems only
#
# force=True because uvicorn may already have configured the root logger by this point;
# without it basicConfig silently does nothing and we are back to no output at all.
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=os.getenv("AI_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-5s %(name)s | %(message)s",
    force=True,
)

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm the heavy singletons at startup so the first request isn't slow.
    #
    # Logged stage by stage because these two calls are where startup actually fails: loading
    # the embedding model needs several hundred MB, and building the knowledge index reads
    # every stored PDF. When this service died on boot, the only way to tell which of the two
    # was responsible was to guess — these lines make the last one printed the answer.
    log.info("Starting up: loading the embedding model…")
    get_embeddings()
    log.info("Embedding model ready. Building the knowledge index…")
    get_kb()
    log.info("Knowledge index ready — the service can now answer requests.")
    # In Kafka mode, start the background consumer that replays the question log to rebuild
    # clusters, then keeps ingesting live (see kafka_stream.py). No-op in inproc/redis mode.
    worker = None
    if get_settings().queue_mode == "kafka":
        from .kafka_stream import get_kafka_worker
        worker = get_kafka_worker()
        worker.start()
    yield
    if worker is not None:
        worker.stop()


app = FastAPI(title="VIRTUAL MEETING Sentinel — AI Service", version="1.0.0", lifespan=lifespan)

# Angular (Vercel) calls the backend, but allow direct CORS for local dev/testing.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root() -> dict:
    """Say what this service is, instead of answering the base URL with a bare 404.

    FastAPI registers no root route, so opening the deployment's own URL returned
    {"detail": "Not Found"} — which is correct, and indistinguishable to anyone checking whether the
    deploy worked from the service being down. Every real endpoint is a named path; this one exists
    only to identify the service and point at the two places worth opening in a browser.
    """
    return {
        "service": app.title,
        "version": app.version,
        "status": "ok",
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/kafka/status")
def kafka_status() -> dict:
    """Ingest-worker telemetry: replay progress + live counts (only meaningful in Kafka mode)."""
    if get_settings().queue_mode != "kafka":
        return {"mode": get_settings().queue_mode, "running": False}
    from .kafka_stream import get_kafka_worker
    return get_kafka_worker().status()


@app.post("/ingest", response_model=IngestResponse)
def ingest(req: IngestRequest) -> IngestResponse:
    embedding = get_embeddings().embed_query(req.text)
    # meeting_id partitions the search: the clusterer only ever compares this question
    # against centroids from the same meeting.
    result = get_clusterer().assign(
        req.text, embedding, weight=req.weight, meeting_id=req.meeting_id
    )
    return IngestResponse(
        question_id=req.question_id,
        cluster_id=result.cluster.cluster_id,
        is_new_cluster=result.is_new,
        similarity=round(result.similarity, 4),
        cluster_size=result.cluster.size,
    )


@app.post("/draft", response_model=DraftResponse)
def draft(req: DraftRequest) -> DraftResponse:
    result = get_kb().draft(req.cluster_id, req.representative_question,
                            meeting_id=req.meeting_id)
    # Cache the draft + its citations on the cluster so they ride along on the board push.
    cluster = get_clusterer().get(req.cluster_id)
    if cluster is not None:
        cluster.draft = result.answer
        cluster.citations = [c.model_dump() for c in result.citations]
    return result


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    """Shareholder-facing GenAI assistant — RAG-grounded answer over the annual report."""
    return get_kb().chat(req.message, meeting_id=req.meeting_id)


@app.get("/knowledge/status")
def knowledge_status() -> dict:
    return get_kb().status()


@app.get("/knowledge/files/{filename}")
def knowledge_file(filename: str) -> FileResponse:
    """Serve an indexed source PDF so the UI can open it (at a page anchor) from a citation."""
    path = knowledge_file_path(filename)
    if path is None:
        raise HTTPException(status_code=404, detail="Source document not found.")
    # inline so the browser's PDF viewer opens it (and honours #page=N) instead of downloading.
    return FileResponse(
        path, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{path.name}"'},
    )


@app.post("/knowledge/upload")
async def knowledge_upload(
    file: UploadFile = File(...),
    # Which meeting this document belongs to. OMITTED MEANS SHARED with every meeting,
    # which is the right default: the articles, a standing policy or a reference report
    # apply to all of them, and requiring a re-upload per meeting would be busywork that
    # also multiplies the index. Scoping is the deliberate choice, not the default.
    meeting_id: str | None = Form(default=None),
) -> dict:
    """Ingest a source PDF (annual report or similar) — several may be indexed side by side."""
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")
    data = await file.read()
    try:
        # Off the event loop. add_pdf re-chunks, re-embeds and rebuilds FAISS — tens of seconds
        # for a real report. Run inline, it blocks the single uvicorn worker for that entire time,
        # so NO route is dispatched at all: /knowledge/status stops answering, and the admin page's
        # progress poll cannot be served until the thing it is watching has already finished.
        #
        # Safe to move: add_pdf takes its own RLock (see rag.py), so it is already written for
        # multi-threaded entry, and status() is deliberately lock-free so it stays readable while
        # this runs — which is what makes live progress possible at all.
        chunks = await run_in_threadpool(
            get_kb().add_pdf, file.filename, data, meeting_id=meeting_id
        )
    except ValueError as ex:
        # A name like "../x.pdf" satisfies the extension check above and is then refused at the
        # filesystem boundary. Without this it would surface as a 500 for what is a bad request.
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    if chunks == 0:
        raise HTTPException(status_code=422, detail="No extractable text found in the PDF.")
    return {"filename": file.filename, "chunks_indexed": chunks, **get_kb().status()}


@app.post("/knowledge/transcript")
def knowledge_transcript(req: TranscriptIndexRequest) -> dict:
    """Index a meeting recording's WebVTT captions into the knowledge base.

    A recording's transcript is company disclosure too, and more current than the annual report —
    published once a year against a call that happened now. Indexing it means an answer can cite
    what was actually said, and the citation carries the second so the UI can open the player there.

    Re-indexing the same video replaces its passages rather than adding a second copy.
    """
    kb = get_kb()
    passages = kb.add_transcript(req.video_id, req.title, req.vtt,
                                 meeting_id=req.meeting_id)
    if passages == 0:
        raise HTTPException(
            status_code=422,
            detail="No caption cues were found. A transcript needs timestamp lines like "
                   "\"00:01:02.500 --> 00:01:05.000\".",
        )
    return {"video_id": req.video_id, "passages_indexed": passages, **kb.status()}


@app.post("/knowledge/remove")
def knowledge_remove(req: KnowledgeRemoveRequest) -> dict:
    """Delete one indexed document and everything derived from it.

    Removal deletes the stored file in ai-service/knowledge/ **and rebuilds the FAISS index from the
    documents that remain**. Both halves are necessary: the index has no per-document delete, so
    without the rebuild the removed document's chunks stay retrievable and citable for the life of
    the process; and without deleting the file the next restart re-indexes it straight back.

    Removing the last document leaves the empty-knowledge-base placeholder in place, so `ready`
    becomes false and /draft reports that it cannot find an answer in the available sources.
    """
    kb = get_kb()
    try:
        status = kb.remove_source(req.filename, active_meeting_id=req.meeting_id)
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except FileNotFoundError as ex:
        raise HTTPException(status_code=404, detail=str(ex)) from ex
    except PermissionError as ex:
        # 409, not 403: the caller is allowed to do this, just not from where they are standing.
        # The message names the way forward — activate the owning meeting first.
        raise HTTPException(status_code=409, detail=str(ex)) from ex
    # remove_source already returned the post-rebuild status; re-reading it would open a window in
    # which another request had mutated the index between the two reads.
    return {"filename": req.filename, "removed": True, **status}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)) -> dict:
    """Turn an uploaded audio track into WebVTT captions.

    Called by the backend, which extracts the audio with FFmpeg — this service has no access to the
    media, and no FFmpeg. Returns the transcript rather than storing it: the backend owns where a
    recording's files live, and it also wants to index the result into the knowledge base.
    """
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="No audio was uploaded.")
    try:
        # Off the event loop for the same reason as the upload above: this is a blocking network
        # call to a speech-to-text provider that can run for minutes, kicked off by a background
        # worker after any video upload. Held inline, it takes every other route down with it while
        # nobody has clicked anything — which is exactly the shape of an outage that looks random.
        vtt = await run_in_threadpool(
            transcribe_to_vtt, file.filename or "audio.mp3", audio
        )
    except TranscriptionUnavailable as ex:
        # 503, not 500: nothing is broken, the capability simply is not configured here.
        raise HTTPException(status_code=503, detail=str(ex)) from ex
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"Transcription failed: {ex}") from ex
    return {"vtt": vtt, "characters": len(vtt)}


@app.post("/search", response_model=list[SearchHit])
def search(req: SearchRequest) -> list[SearchHit]:
    """Semantic search across the annual report and every indexed recording transcript.

    Retrieval only — no LLM, so this needs no API key, costs nothing per call and answers in
    milliseconds. It is the cheap half of what /draft does, exposed on its own because "show me where
    this was discussed" is a different question from "write me an answer".
    """
    return get_kb().search(req.query, req.k, meeting_id=req.meeting_id)


@app.get("/clusters", response_model=list[ClusterView])
def clusters(limit: int = 20, meeting_id: str | None = None) -> list[ClusterView]:
    """The ranked board.

    With `meeting_id`, one meeting's topics. Without it, every meeting merged and re-ranked
    — which is what the backend asks for when per-meeting filtering is switched off, so that
    deployment sees exactly what it saw before clustering was partitioned.

    Note the asymmetry: omitting the parameter means "all meetings", NOT "the meeting-less
    partition". Anything genuinely belonging to no meeting is reachable by asking for it
    explicitly, and appears in the merged view either way.
    """
    board = get_clusterer().top(
        limit, meeting_id=meeting_id, all_meetings=meeting_id is None
    )
    return [
        ClusterView(
            cluster_id=c.cluster_id,
            representative_question=c.representative_question,
            size=c.size,
            priority_score=round(c.priority_score, 4),
            draft=c.draft,
            citations=c.citations or [],
        )
        for c in board
    ]


@app.post("/meetings/retain")
def retain_meeting(req: RetainMeetingRequest) -> dict:
    """Keep one meeting's clustering state and drop every other meeting's.

    Called by the backend when a meeting is activated, so a new meeting starts genuinely
    clean rather than merely filtered.

    Safe to lose: centroids are a cache. Every topic's durable record lives in the backend's
    `cluster_drafts`, and a board whose live ranking is missing falls back to those rows.
    It also bounds memory — this service runs in a small container and holding every past
    meeting's centroids forever is a leak with a slow fuse.
    """
    dropped = get_clusterer().retain_only(req.meeting_id)
    log.info(
        "Meeting %s activated: kept %s clusters, dropped %s clusters across %s other meetings.",
        req.meeting_id,
        dropped["remaining_clusters"],
        dropped["dropped_clusters"],
        dropped["dropped_meetings"],
    )
    return dropped


@app.get("/clusters/stats")
def cluster_stats() -> dict:
    """Per-meeting cluster counts. Diagnostic: the first thing to look at on a memory alert."""
    return get_clusterer().stats()
