"""RAG: draft a grounded, cited answer to a cluster's representative question.

Knowledge base = the company's annual report (PDF) AND the transcripts of meeting recordings,
chunked and embedded. Transcripts matter because the report is published once a year while the call
happened now: indexing them lets an answer cite what was actually said, at the second it was said.
We keep it simple and free: FAISS in-memory index (no external vector DB needed for the KB).
Retrieval feeds a LangChain prompt -> free LLM (Groq/Gemini) -> answer + citations.
"""
from __future__ import annotations
import io
import logging
import os
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader

from .embeddings import get_embeddings
from .llm import get_llm
from .schemas import ChatResponse, Citation, DraftResponse, SearchHit

log = logging.getLogger(__name__)

_KB_DIR = Path(__file__).resolve().parent.parent / "knowledge"

# Roughly a PDF chunk. A transcript cue is one spoken line — too little to embed usefully — so cues
# are grouped up to this size before being indexed.
_TRANSCRIPT_PASSAGE_CHARS = 900

_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You are an VIRTUAL MEETING assistant drafting a concise L1 answer for a company moderator. "
     "Answer ONLY from the provided context. Each excerpt is tagged with its source: a page of "
     "the annual report, or a moment in a meeting recording’s transcript (“Recording: … @ 12:04”). "
     "Both are authoritative company disclosure. Prefer the recording where the two disagree — "
     "it is more recent — and make clear which you relied on. "
     "If the context does not contain the answer, say you cannot find it in the available "
     "sources and recommend escalation. Keep it under 120 words. Do not invent figures."),
    ("human",
     "Shareholder question (representative of a cluster):\n{question}\n\n"
     "Context excerpts:\n{context}\n\nDraft answer:"),
])

# Conversational variant for the shareholder-facing GenAI assistant (the Lounge chatbot).
_CHAT_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You are the VIRTUAL MEETING Sentinel assistant chatting directly with a shareholder. "
     "Answer their question ONLY from the provided excerpts. Each is tagged with its source: a "
     "page of the annual report, or a moment in a meeting recording (“Recording: … @ 12:04”). "
     "When you use a recording, say it was said on the call so they know it came from the "
     "meeting itself. If the excerpts do not cover it, clearly say so and suggest "
     "they raise it as a live question for the board. Be friendly and concise (under 150 words). "
     "Never invent figures or facts."),
    ("human",
     "Shareholder message:\n{question}\n\nContext excerpts:\n{context}\n\nReply:"),
])


class IndexTrace:
    """An ordered record of what an indexing run actually did, for the UI to show.

    Retrieval-augmented generation is the part of this system users are most likely to assume is
    magic, so the pipeline states its work: which library read the PDF, how the text was split, how
    many vectors were produced and by which model. Every step names a real tool and carries its own
    duration, because a step list with no timings cannot distinguish "working" from "hung" — and on
    a free-tier host that has just woken up, the first embed genuinely does take seconds.

    Held on the KnowledgeBase rather than returned from one call, so a run in progress can be polled
    while it happens and the finished trace stays readable afterwards as an explanation of the
    pipeline. Deliberately plain dicts: this crosses two service boundaries to reach the browser.
    """

    def __init__(self, label: str):
        self.label = label
        self.steps: list[dict] = []
        self.note: str | None = None
        self._started = time.perf_counter()
        self._finished: float | None = None

    @contextmanager
    def step(self, name: str, tool: str, detail: str = ""):
        """Time one stage. The yielded dict is mutable so the body can report what it found."""
        entry = {"name": name, "tool": tool, "detail": detail, "status": "running", "ms": None}
        self.steps.append(entry)
        started = time.perf_counter()
        try:
            yield entry
        except Exception as exc:
            entry["status"] = "failed"
            entry["detail"] = str(exc)[:200]
            entry["ms"] = round((time.perf_counter() - started) * 1000)
            self.note = f"Failed during “{name}”."
            self._finished = time.perf_counter()
            raise
        entry["status"] = "done"
        entry["ms"] = round((time.perf_counter() - started) * 1000)

    def finish(self, note: str | None = None) -> None:
        self.note = note
        self._finished = time.perf_counter()

    def snapshot(self) -> dict:
        end = self._finished if self._finished is not None else time.perf_counter()
        return {
            "label": self.label,
            "running": self._finished is None,
            "note": self.note,
            "total_ms": round((end - self._started) * 1000),
            "steps": [dict(s) for s in self.steps],
        }


class KnowledgeBase:
    """FAISS index over the annual report. Rebuilt on startup from PDFs in ai-service/knowledge/."""

    def __init__(self):
        self._store: FAISS | None = None
        self._chain = None
        self._chat_chain = None            # lazy conversational chain for the Lounge assistant
        self._sources: set[str] = set()   # filenames currently indexed
        self._chunk_count = 0
        self._placeholder_only = False     # True when only the "no report" fallback is loaded
        self._last_trace: IndexTrace | None = None
        # Serialises the three operations that mutate the index. Every one of them is a
        # read-modify-write over _store/_sources/_chunk_count, and a rebuild re-embeds the whole
        # knowledge base — seconds of work on a one-core container, not microseconds. Two writers
        # overlapping in that window can interleave a `_sources.clear()` with the other's
        # `_load_documents()` and leave the source list describing neither state.
        #
        # This needs no second human to happen: a moderator uploading a report and the backend
        # indexing a recording's transcript are different callers reaching the same singleton.
        # Reentrant because remove_source → _reload_from_disk → load, and add_pdf's replacing
        # branch, all re-enter while already holding it.
        self._lock = threading.RLock()

    def load(self) -> None:
        docs = self._load_documents()
        embeddings = get_embeddings()
        if docs:
            self._store = FAISS.from_documents(docs, embeddings)
            self._chunk_count = len(docs)
            self._placeholder_only = False
            # Name what was indexed, because every *.pdf in the folder is embedded unconditionally.
            # A file that does not belong there is otherwise invisible: it never announces itself,
            # it just quietly starts turning up in citations, and the first sign of trouble is an
            # answer sourced from a document nobody meant to publish.
            log.info("Knowledge base: %d chunk(s) from %d source(s): %s",
                     self._chunk_count, len(self._sources), ", ".join(sorted(self._sources)))
        else:
            # Empty KB fallback so the service still boots without a PDF present.
            self._store = FAISS.from_documents(
                [Document(page_content="No annual report loaded.", metadata={"source": "none"})],
                embeddings,
            )
            self._chunk_count = 0
            self._placeholder_only = True
            log.warning("Knowledge base is empty — no PDFs or transcripts found in %s. "
                        "/draft will report that the answer is not in the report.", _KB_DIR)
        # Note: the LLM chain is built lazily (see _get_chain) so the service boots and can
        # embed/cluster WITHOUT an LLM API key. Only /draft needs the key.

    def _get_chain(self):
        if self._chain is None:
            self._chain = _PROMPT | get_llm() | StrOutputParser()
        return self._chain

    def _get_chat_chain(self):
        if self._chat_chain is None:
            self._chat_chain = _CHAT_PROMPT | get_llm() | StrOutputParser()
        return self._chat_chain

    def _load_documents(self) -> list[Document]:
        docs: list[Document] = []
        if not _KB_DIR.exists():
            return docs
        for pdf in _KB_DIR.glob("*.pdf"):
            reader = PdfReader(str(pdf))
            self._sources.add(pdf.name)
            docs.extend(self._docs_from_reader(reader, pdf.name))
        # Transcripts persisted by add_transcript. Without this an indexed recording would drop out
        # of the knowledge base on the next restart — the same class of bug as an unsaved draft.
        for vtt_path in _KB_DIR.glob("recording-*.vtt"):
            text = vtt_path.read_text(encoding="utf-8", errors="replace")
            video_id = vtt_path.stem.removeprefix("recording-")
            title = _title_from_note(text) or video_id
            self._sources.add(self._transcript_label(title))
            docs.extend(self._docs_from_vtt(video_id, title, text))
        return docs

    def _docs_from_reader(self, reader: PdfReader, source_name: str) -> list[Document]:
        """Split every page of a PDF into embeddable, source-tagged chunks."""
        splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)
        docs: list[Document] = []
        for page_no, page in enumerate(reader.pages, start=1):
            text = (page.extract_text() or "").strip()
            if not text:
                continue
            for chunk in splitter.split_text(text):
                docs.append(Document(
                    page_content=chunk,
                    metadata={"source": f"{source_name} p.{page_no}"},
                ))
        return docs

    # ---- meeting recordings -------------------------------------------------
    #
    # A recording's transcript is company disclosure too, and usually more current than the annual
    # report — the report is published once a year, the call happens now. Indexing it lets a draft
    # answer cite what was actually said, at the second it was said, instead of being limited to
    # what the report happens to cover.

    def add_transcript(self, video_id: str, title: str, vtt: str, persist: bool = True) -> int:
        """Index a recording's WebVTT captions as timestamped, citable passages.

        Returns the number of passages indexed.

        <b>Re-indexing replaces.</b> A corrected transcript is a normal thing to upload, and FAISS
        `add_documents` only ever appends — so a second pass would leave the old passages in the
        index competing with the new ones. When this recording is already indexed, the file is
        rewritten and the whole store is rebuilt from disk instead. That costs re-embedding
        everything, which is why it is not the path taken for a first-time index.
        """
        with self._lock:
            return self._add_transcript_locked(video_id, title, vtt, persist)

    def _add_transcript_locked(self, video_id: str, title: str, vtt: str, persist: bool) -> int:
        docs = self._docs_from_vtt(video_id, title, vtt)
        if not docs:
            return 0

        target = _KB_DIR / self._transcript_filename(video_id)
        reindex = target.exists()

        if persist:
            _KB_DIR.mkdir(parents=True, exist_ok=True)
            # Kept so the index survives a restart, exactly as uploaded PDFs are. The title rides
            # in a NOTE block because the filename cannot carry it losslessly.
            target.write_text(
                f"WEBVTT\n\nNOTE source-title: {title}\n\n" + _strip_vtt_header(vtt),
                encoding="utf-8",
            )

        if reindex and persist:
            # Rebuild from the persisted files, which now hold the corrected version.
            self._sources.clear()
            self.load()
        else:
            self._index(docs)
            self._sources.add(self._transcript_label(title))
        return len(docs)

    def _docs_from_vtt(self, video_id: str, title: str, vtt: str) -> list[Document]:
        """Group consecutive cues into passages large enough to retrieve on.

        A single cue is one spoken line — far too little context for a useful embedding, and it
        would return a citation pointing at half a sentence. Cues are therefore accumulated up to
        roughly the same size as a PDF chunk, and the passage is stamped with the start time of its
        FIRST cue, so the citation lands where the passage begins rather than where it ends.
        """
        cues = _parse_vtt(vtt)
        if not cues:
            return []

        docs: list[Document] = []
        buffer: list[str] = []
        buffer_start = cues[0][0]
        buffer_len = 0

        def flush() -> None:
            nonlocal buffer, buffer_len
            text = " ".join(buffer).strip()
            if text:
                docs.append(Document(
                    page_content=text,
                    metadata={
                        "source": f"{self._transcript_label(title)} @ {_timecode(buffer_start)}",
                        "video_id": video_id,
                        "at_seconds": buffer_start,
                        "kind": "recording",
                    },
                ))
            buffer = []
            buffer_len = 0

        for start, text in cues:
            if buffer_len == 0:
                buffer_start = start
            buffer.append(text)
            buffer_len += len(text) + 1
            if buffer_len >= _TRANSCRIPT_PASSAGE_CHARS:
                flush()
        flush()
        return docs

    @staticmethod
    def _transcript_label(title: str) -> str:
        return f"Recording: {title}"

    @staticmethod
    def _transcript_filename(video_id: str) -> str:
        # One file per recording, so re-indexing replaces rather than accumulates.
        return f"recording-{os.path.basename(video_id)}.vtt"

    def _index(self, docs: list[Document]) -> None:
        """Add documents to the live index, replacing the empty placeholder if that is all there is."""
        embeddings = get_embeddings()
        if self._store is None or self._placeholder_only:
            self._store = FAISS.from_documents(docs, embeddings)
            self._chunk_count = len(docs)
            self._placeholder_only = False
        else:
            self._store.add_documents(docs)
            self._chunk_count += len(docs)

    def add_pdf(self, filename: str, data: bytes, persist: bool = True) -> int:
        """Ingest an uploaded annual-report PDF into the live FAISS index at runtime.

        Returns the number of chunks indexed. Several PDFs may be indexed side by side — each is
        stored under its own name and tagged with it, so citations always say which document they
        came from.

        <b>Re-uploading the same filename replaces it.</b> Correcting a report by uploading it again
        is a normal thing to do, and {@code FAISS.add_documents} only ever appends — so without this
        the old version's chunks would stay in the index competing with the new ones, while
        {@code _sources} (a set) went on showing a single entry. The only visible symptom would be a
        chunk count that had quietly doubled, which is not a symptom anyone looks for. The same
        reasoning already governs {@code add_transcript}.
        """
        with self._lock:
            return self._add_pdf_locked(filename, data, persist)

    def _add_pdf_locked(self, filename: str, data: bytes, persist: bool) -> int:
        name = self._safe_kb_name(filename)
        trace = IndexTrace(f"Indexing {name}")
        self._last_trace = trace

        with trace.step("Read the document", "pypdf") as s:
            reader = PdfReader(io.BytesIO(data))
            s["detail"] = f"{len(reader.pages)} page(s), {len(data) / 1024:.0f} kB"

        with trace.step("Split text into chunks",
                        "RecursiveCharacterTextSplitter (1000 chars, 150 overlap)") as s:
            docs = self._docs_from_reader(reader, name)
            s["detail"] = f"{len(docs)} chunk(s)"

        if not docs:
            trace.finish("No extractable text — a scanned PDF needs OCR before it can be indexed.")
            return 0

        replacing = persist and (_KB_DIR / name).exists()

        if persist:
            with trace.step("Store the document", "filesystem") as s:
                _KB_DIR.mkdir(parents=True, exist_ok=True)
                (_KB_DIR / name).write_bytes(data)
                s["detail"] = f"saved as {name}" + (" (replacing the previous version)" if replacing else "")

        if replacing:
            # Rebuild so the superseded version's vectors go away instead of competing.
            with trace.step("Re-embed the knowledge base",
                            "all-MiniLM-L6-v2 on ONNX Runtime → FAISS") as s:
                self._reload_from_disk()
                s["detail"] = f"{self._chunk_count} chunk(s) from {len(self._sources)} source(s)"
        else:
            with trace.step("Embed and index the chunks",
                            "all-MiniLM-L6-v2 on ONNX Runtime → FAISS") as s:
                self._index(docs)
                self._sources.add(name)
                s["detail"] = f"{len(docs)} vector(s), 384 dimensions each"

        trace.finish()
        return len(docs)

    def remove_source(self, filename: str) -> dict:
        """Delete one document and everything derived from it. Returns the resulting status.

        Removal has to reach the vectors, not just the file. Deleting the PDF alone would leave its
        chunks embedded in a live index that no longer has anything to justify them: retrieval would
        keep returning passages from a document the operator believes they deleted, and cite it by
        name. That is the failure worth designing against — a deletion that appears to work.
        """
        with self._lock:
            return self._remove_source_locked(filename)

    def _remove_source_locked(self, filename: str) -> dict:
        name = self._safe_kb_name(filename)
        target = _KB_DIR / name
        trace = IndexTrace(f"Removing {name}")
        self._last_trace = trace

        with trace.step("Delete the stored document", "filesystem") as s:
            if not target.exists():
                raise FileNotFoundError(f"“{name}” is not in the knowledge base.")
            target.unlink()
            s["detail"] = f"{name} deleted"

        with trace.step("Rebuild the index from the remaining documents",
                        "all-MiniLM-L6-v2 on ONNX Runtime → FAISS") as s:
            self._reload_from_disk()
            s["detail"] = (
                f"{self._chunk_count} chunk(s) from {len(self._sources)} source(s) re-embedded"
                if self._sources else "the knowledge base is now empty"
            )

        trace.finish()
        return self.status()

    def _reload_from_disk(self) -> None:
        """Discard the whole index and rebuild it from the files that remain.

        This is what makes a removal complete rather than cosmetic. {@code FAISS.add_documents} only
        appends, and this code never keeps the per-document ids that would let one document's vectors
        be subtracted from the existing store — so there is no partial deletion available. Building a
        new store from the surviving files leaves every vector of the removed document unreferenced
        and collected: its chunks, its index entries and its embeddings all go together, which is the
        only version of "deleted" worth telling an operator about.

        The cost is re-embedding everything that is left, which is why the first-time index path does
        not come through here.

        {@code _store} is deliberately NOT cleared first. {@code draft} and {@code chat} assert it is
        not None and then search it, and FastAPI runs those synchronous handlers on a threadpool — so
        a draft arriving mid-rebuild would trip the assertion and return a 500 for a reason nobody
        would connect to an unrelated deletion. {@code load} rebinds the store in a single statement,
        which the GIL makes atomic: a concurrent reader sees the old index or the new one, never
        neither. Only {@code _sources} needs clearing, because {@code _load_documents} appends to it.
        """
        self._sources.clear()
        self.load()

    @staticmethod
    def _safe_kb_name(filename: str) -> str:
        """Reduce a caller-supplied name to a bare filename inside the knowledge folder.

        The name arrives from a browser and crosses two services before it reaches this line, so it
        is treated as hostile. Anything with a path in it is rejected outright rather than quietly
        normalised: {@code ../../app/main.py} is not a document name with a mistake in it, it is an
        attempt to delete something else, and silently trimming it to {@code main.py} would still
        delete the wrong file.
        """
        name = (filename or "").strip()
        if (not name or name in {".", ".."}
                or "/" in name or "\\" in name
                or name != os.path.basename(name)
                or name.startswith(".")):
            raise ValueError("Invalid document name.")
        return name

    def status(self) -> dict:
        return {
            "sources": sorted(self._sources),
            "chunks_indexed": self._chunk_count,
            "ready": bool(self._sources),
            # The most recent indexing or removal run, so the UI can show what the pipeline did.
            # Additive: existing callers that only read the three fields above are unaffected.
            "last_index_run": self._last_trace.snapshot() if self._last_trace else None,
        }

    def search(self, query: str, k: int = 8) -> list[SearchHit]:
        """Semantic search over everything indexed — retrieval with no generation.

        <p>The same vector search that feeds {@code draft}, stopping before the LLM. That makes it
        materially different to use: no API key, no token cost, and an answer in milliseconds rather
        than seconds. "Where was the dividend discussed?" returns the report pages and the moments in
        the recordings, each already carrying the seek target that opens the player there.

        <p>Different from keyword search in the way that matters here: "payout timing" finds a
        passage about "when the dividend will be distributed" because they mean the same thing, which
        is the entire reason this system embeds text in the first place.
        """
        assert self._store is not None, "KB not loaded"
        clean = (query or "").strip()
        if not clean:
            return []
        if self._placeholder_only:
            return []

        k = max(1, min(k, 25))
        try:
            scored = self._store.similarity_search_with_relevance_scores(clean, k=k)
        except Exception:
            # Relevance scoring depends on the store's distance strategy having a known mapping.
            # Falling back to raw distance keeps search working rather than failing over a number
            # that only decorates the result.
            scored = [(doc, None) for doc, _ in self._store.similarity_search_with_score(clean, k=k)]

        hits: list[SearchHit] = []
        for doc, score in scored:
            citation = _citation(doc)
            hits.append(SearchHit(
                source=citation.source,
                snippet=doc.page_content[:400],
                video_id=citation.video_id,
                at_seconds=citation.at_seconds,
                score=round(float(score), 4) if score is not None else None,
            ))
        return hits

    def draft(self, cluster_id: str, question: str, k: int = 4) -> DraftResponse:
        """The RAG step: retrieve → augment → generate a grounded, cited answer.

        1. RETRIEVE the k report chunks most semantically similar to the question (vector search).
        2. AUGMENT: stitch those chunks (with their source tags) into a context block.
        3. GENERATE: the LLM chain answers strictly from that context (see the prompt).
        4. Attach the retrieved chunks as citations so the moderator can verify the source.
        """
        assert self._store is not None, "KB not loaded"
        hits = self._store.similarity_search(question, k=k)          # 1) top-k nearest chunks
        context = "\n\n".join(f"[{d.metadata.get('source')}] {d.page_content}" for d in hits)  # 2)
        answer = self._get_chain().invoke({"question": question, "context": context})          # 3)
        citations = [_citation(d) for d in hits]                      # 4) source + seek target
        return DraftResponse(cluster_id=cluster_id, answer=answer.strip(), citations=citations)

    def chat(self, message: str, k: int = 4) -> ChatResponse:
        """Shareholder-facing GenAI chat: same RAG retrieve→augment→generate as draft(), but with
        a conversational prompt. Grounded on the annual report, returns answer + citations."""
        assert self._store is not None, "KB not loaded"
        hits = self._store.similarity_search(message, k=k)
        context = "\n\n".join(f"[{d.metadata.get('source')}] {d.page_content}" for d in hits)
        answer = self._get_chat_chain().invoke({"question": message, "context": context})
        citations = [_citation(d) for d in hits]
        return ChatResponse(answer=answer.strip(), citations=citations)


def _citation(doc: Document) -> Citation:
    """Turn a retrieved passage into a citation, carrying a seek target when it has one."""
    at = doc.metadata.get("at_seconds")
    return Citation(
        source=doc.metadata.get("source", "unknown"),
        snippet=doc.page_content[:180],
        video_id=doc.metadata.get("video_id"),
        at_seconds=float(at) if at is not None else None,
    )


def _parse_vtt(vtt: str) -> list[tuple[float, str]]:
    """WebVTT into (start seconds, text) pairs.

    Tolerant on purpose — this text arrives from a human-supplied caption file. A BOM, CRLF line
    endings, cue identifiers, NOTE blocks and inline markup are all things a real .vtt contains and
    none of them should stop it being indexed.
    """
    text = vtt.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    cues: list[tuple[float, str]] = []
    lines = text.split("\n")

    i = 0
    while i < len(lines):
        arrow = lines[i].find("-->")
        if arrow < 0:
            i += 1
            continue
        start = _vtt_seconds(lines[i][:arrow])
        i += 1
        if start is None:
            continue
        spoken: list[str] = []
        while i < len(lines) and lines[i].strip():
            spoken.append(lines[i].strip())
            i += 1
        body = re.sub(r"<[^>]*>", "", " ".join(spoken)).strip()
        if body:
            cues.append((start, body))
    return cues


def _vtt_seconds(raw: str) -> float | None:
    """`00:12:04.500` or `12:04.500` — the hour is optional in WebVTT."""
    parts = raw.strip().replace(",", ".").split(":")
    try:
        numbers = [float(p) for p in parts]
    except ValueError:
        return None
    if len(numbers) == 3:
        return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    if len(numbers) == 2:
        return numbers[0] * 60 + numbers[1]
    return None


def _timecode(seconds: float) -> str:
    total = int(seconds)
    hours, minutes, secs = total // 3600, (total % 3600) // 60, total % 60
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _strip_vtt_header(vtt: str) -> str:
    """Drop a leading WEBVTT line so it is not duplicated when the file is rewritten."""
    body = vtt.lstrip("﻿").replace("\r\n", "\n").lstrip()
    return body[6:].lstrip("\n") if body.startswith("WEBVTT") else body


def _title_from_note(vtt: str) -> str | None:
    match = re.search(r"^NOTE source-title:\s*(.+)$", vtt, re.MULTILINE)
    return match.group(1).strip() if match else None


def knowledge_file_path(filename: str) -> Path | None:
    """Resolve an indexed PDF by name, guarding against path traversal. None if absent."""
    safe = os.path.basename(filename)          # strip any directory components
    path = _KB_DIR / safe
    return path if path.is_file() else None


_kb: KnowledgeBase | None = None


def get_kb() -> KnowledgeBase:
    global _kb
    if _kb is None:
        _kb = KnowledgeBase()
        _kb.load()
    return _kb
