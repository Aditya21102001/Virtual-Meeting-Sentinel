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

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from fastapi.responses import FileResponse

from .clustering import get_clusterer
from .config import get_settings
from .embeddings import get_embeddings
from .rag import get_kb, knowledge_file_path
from .transcribe import TranscriptionUnavailable, transcribe_to_vtt
from .schemas import (
    ChatRequest, ChatResponse, ClusterView, DraftRequest, DraftResponse,
    IngestRequest, IngestResponse, TranscriptIndexRequest,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm the heavy singletons at startup so the first request isn't slow.
    get_embeddings()
    get_kb()
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
    result = get_clusterer().assign(req.text, embedding, weight=req.weight)
    return IngestResponse(
        question_id=req.question_id,
        cluster_id=result.cluster.cluster_id,
        is_new_cluster=result.is_new,
        similarity=round(result.similarity, 4),
        cluster_size=result.cluster.size,
    )


@app.post("/draft", response_model=DraftResponse)
def draft(req: DraftRequest) -> DraftResponse:
    result = get_kb().draft(req.cluster_id, req.representative_question)
    # Cache the draft + its citations on the cluster so they ride along on the board push.
    cluster = get_clusterer().get(req.cluster_id)
    if cluster is not None:
        cluster.draft = result.answer
        cluster.citations = [c.model_dump() for c in result.citations]
    return result


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    """Shareholder-facing GenAI assistant — RAG-grounded answer over the annual report."""
    return get_kb().chat(req.message)


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
async def knowledge_upload(file: UploadFile = File(...)) -> dict:
    """Ingest an uploaded annual-report PDF into the RAG knowledge base at runtime."""
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")
    data = await file.read()
    chunks = get_kb().add_pdf(file.filename, data)
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
    passages = kb.add_transcript(req.video_id, req.title, req.vtt)
    if passages == 0:
        raise HTTPException(
            status_code=422,
            detail="No caption cues were found. A transcript needs timestamp lines like "
                   "\"00:01:02.500 --> 00:01:05.000\".",
        )
    return {"video_id": req.video_id, "passages_indexed": passages, **kb.status()}


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
        vtt = transcribe_to_vtt(file.filename or "audio.mp3", audio)
    except TranscriptionUnavailable as ex:
        # 503, not 500: nothing is broken, the capability simply is not configured here.
        raise HTTPException(status_code=503, detail=str(ex)) from ex
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"Transcription failed: {ex}") from ex
    return {"vtt": vtt, "characters": len(vtt)}


@app.get("/clusters", response_model=list[ClusterView])
def clusters(limit: int = 20) -> list[ClusterView]:
    return [
        ClusterView(
            cluster_id=c.cluster_id,
            representative_question=c.representative_question,
            size=c.size,
            priority_score=round(c.priority_score, 4),
            draft=c.draft,
            citations=c.citations or [],
        )
        for c in get_clusterer().top(limit)
    ]
