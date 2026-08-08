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
        # Real work done / real work total, for the one stage long enough to need a bar.
        self._done = 0
        self._total = 0
        self._unit = "chunks"

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

    def progress(self, done: int, total: int, unit: str = "chunks") -> None:
        """Report how far through the long stage we are.

        MEASURED, NOT ESTIMATED. The count is the number of chunks actually embedded, which is why
        embedding runs in batches rather than one call — a bar that advances on a timer is a
        decoration, and the moment it disagrees with reality nobody believes the next one either.

        Only the embedding stage reports this. Reading and splitting a PDF are fast and their
        duration is dominated by the file, so a percentage there would be noise dressed as
        information.
        """
        self._done = max(0, done)
        self._total = max(0, total)
        self._unit = unit

    def finish(self, note: str | None = None) -> None:
        self.note = note
        self._finished = time.perf_counter()
        # Snap to complete. A run that ends at 97% because the last batch was short reads as
        # something having gone wrong.
        if self._total:
            self._done = self._total

    def snapshot(self) -> dict:
        end = self._finished if self._finished is not None else time.perf_counter()
        elapsed_ms = round((end - self._started) * 1000)
        percent = round(self._done * 100 / self._total, 1) if self._total else None

        # Time remaining, extrapolated from the rate achieved SO FAR rather than from a guess at
        # what the machine can do. Withheld until a tenth of the work is done: an estimate drawn
        # from the first two chunks of a cold-started process is wildly wrong, and a wrong number
        # is worse than no number.
        eta_ms = None
        if self._total and self._done >= max(1, self._total // 10) and self._done < self._total:
            per_unit = elapsed_ms / self._done
            eta_ms = round(per_unit * (self._total - self._done))

        return {
            "label": self.label,
            "running": self._finished is None,
            "note": self.note,
            "total_ms": elapsed_ms,
            "steps": [dict(s) for s in self.steps],
            # None until there is something real to report — the UI shows steps alone in that case.
            "percent": percent,
            "done": self._done,
            "total": self._total,
            "unit": self._unit,
            "eta_ms": eta_ms,
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

    # ---- per-meeting scoping -------------------------------------------------
    #
    # A document belongs either to ONE meeting or to all of them. "All of them" is the default
    # and is stored as None: the articles of association, a standing policy, last year's report
    # kept for reference — these apply to every meeting, and making somebody re-upload them per
    # meeting would be busywork that also multiplies the index.
    #
    # ONE INDEX, FILTERED AT QUERY TIME, rather than an index per meeting. FAISS accepts a
    # metadata predicate, and this service runs in a small container that has already been
    # OOM-killed once — holding a separate index (with its own copy of every embedding) per
    # meeting is the version of this that falls over.

    def _meeting_filter(self, meeting_id: str | None):
        """Restrict retrieval to global documents plus one meeting's.

        Returns None when no meeting is given, which means "search everything" — the behaviour
        this service had before scoping existed, and what an unscoped deployment still gets.

        The predicate deliberately admits `None`. A document with no meeting is shared, not
        orphaned, so excluding it would hide the annual report from every meeting at once.
        """
        if not meeting_id:
            return None

        wanted = meeting_id.strip()

        def keep(metadata: dict) -> bool:
            owner = metadata.get("meeting_id")
            return owner is None or owner == wanted

        return keep

    def _manifest_path(self) -> Path:
        return _KB_DIR / "_manifest.json"

    def _load_manifest(self) -> dict[str, str | None]:
        """filename -> meeting id (or None for a shared document).

        Kept beside the files rather than inferred from them, because the index is rebuilt from
        disk on every restart and a tag that lived only in memory would silently become "shared"
        the first time the service bounced — quietly widening a document's audience, which is the
        wrong direction for a mistake to go.
        """
        path = self._manifest_path()
        if not path.exists():
            return {}
        try:
            import json
            raw = json.loads(path.read_text(encoding="utf-8"))
            return {str(k): (str(v) if v else None) for k, v in raw.items()}
        except Exception as exc:  # noqa: BLE001 - a corrupt manifest must not stop the KB loading
            log.warning("Could not read the knowledge manifest (%s); treating every document as "
                        "shared.", exc)
            return {}

    def _save_manifest(self, manifest: dict[str, str | None]) -> None:
        try:
            import json
            _KB_DIR.mkdir(parents=True, exist_ok=True)
            self._manifest_path().write_text(
                json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not write the knowledge manifest (%s); this document will be "
                        "treated as shared after the next restart.", exc)

    def _tag_document(self, filename: str, meeting_id: str | None) -> None:
        manifest = self._load_manifest()
        if meeting_id:
            manifest[filename] = meeting_id
        else:
            manifest.pop(filename, None)   # absent means shared; no need to store a null
        self._save_manifest(manifest)

    def _load_documents(self) -> list[Document]:
        docs: list[Document] = []
        if not _KB_DIR.exists():
            return docs
        # Which documents belong to which meeting. Applied here rather than remembered in memory,
        # because this runs on every restart and an untagged rebuild would quietly promote every
        # meeting-specific document to shared.
        manifest = self._load_manifest()
        for pdf in _KB_DIR.glob("*.pdf"):
            reader = PdfReader(str(pdf))
            self._sources.add(pdf.name)
            docs.extend(self._docs_from_reader(reader, pdf.name, manifest.get(pdf.name)))
        # Transcripts persisted by add_transcript. Without this an indexed recording would drop out
        # of the knowledge base on the next restart — the same class of bug as an unsaved draft.
        for vtt_path in _KB_DIR.glob("recording-*.vtt"):
            text = vtt_path.read_text(encoding="utf-8", errors="replace")
            video_id = vtt_path.stem.removeprefix("recording-")
            title = _title_from_note(text) or video_id
            self._sources.add(self._transcript_label(title))
            docs.extend(self._docs_from_vtt(video_id, title, text,
                                            manifest.get(vtt_path.name)))
        return docs

    def _docs_from_reader(self, reader: PdfReader, source_name: str,
                          meeting_id: str | None = None,
                          trace: "IndexTrace | None" = None) -> list[Document]:
        """Split every page of a PDF into embeddable, source-tagged chunks.

        `meeting_id` None means the document is shared with every meeting.

        Reports progress by PAGE when given a trace. For a normal report this stage is over before
        anyone looks, but a thousand-page document spends minutes here — and a step that says
        "running" for minutes with no number is indistinguishable from one that has hung.
        """
        splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)
        docs: list[Document] = []
        total_pages = len(reader.pages)
        if trace is not None:
            trace.progress(0, total_pages, unit="pages")

        for page_no, page in enumerate(reader.pages, start=1):
            if trace is not None and page_no % 10 == 0:
                # Every tenth page: often enough to look alive, rarely enough that the bookkeeping
                # does not become a measurable share of the work.
                trace.progress(page_no, total_pages, unit="pages")
            text = (page.extract_text() or "").strip()
            if not text:
                continue
            for chunk in splitter.split_text(text):
                docs.append(Document(
                    page_content=chunk,
                    metadata={
                        "source": f"{source_name} p.{page_no}",
                        # None = shared. The retrieval filter admits it for every meeting.
                        "meeting_id": meeting_id,
                    },
                ))
        return docs

    # ---- meeting recordings -------------------------------------------------
    #
    # A recording's transcript is company disclosure too, and usually more current than the annual
    # report — the report is published once a year, the call happens now. Indexing it lets a draft
    # answer cite what was actually said, at the second it was said, instead of being limited to
    # what the report happens to cover.

    def add_transcript(self, video_id: str, title: str, vtt: str, persist: bool = True,
                       meeting_id: str | None = None) -> int:
        """Index a recording's WebVTT captions as timestamped, citable passages.

        Returns the number of passages indexed.

        <b>Re-indexing replaces.</b> A corrected transcript is a normal thing to upload, and FAISS
        `add_documents` only ever appends — so a second pass would leave the old passages in the
        index competing with the new ones. When this recording is already indexed, the file is
        rewritten and the whole store is rebuilt from disk instead. That costs re-embedding
        everything, which is why it is not the path taken for a first-time index.
        """
        with self._lock:
            return self._add_transcript_locked(video_id, title, vtt, persist, meeting_id)

    def _add_transcript_locked(self, video_id: str, title: str, vtt: str, persist: bool,
                               meeting_id: str | None = None) -> int:
        docs = self._docs_from_vtt(video_id, title, vtt, meeting_id)
        if not docs:
            return 0

        target = _KB_DIR / self._transcript_filename(video_id)
        reindex = target.exists()

        if persist:
            _KB_DIR.mkdir(parents=True, exist_ok=True)
            # Recorded BEFORE the rebuild below, so a re-index picks the tag up from the manifest
            # rather than rebuilding this transcript as shared.
            self._tag_document(target.name, meeting_id)
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

    def _docs_from_vtt(self, video_id: str, title: str, vtt: str,
                       meeting_id: str | None = None) -> list[Document]:
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
                        # None = shared with every meeting; see _meeting_filter.
                        "meeting_id": meeting_id,
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

    # How many chunks to embed per batch.
    #
    # A trade between accuracy of the progress bar and throughput: smaller batches update more
    # often but pay the per-call overhead more times. 32 puts an update roughly every second on a
    # small host, which is frequent enough to look alive without measurably slowing the run.
    _EMBED_BATCH = 32

    def _index_in_batches(self, docs: list[Document], trace: "IndexTrace | None" = None) -> None:
        """Embed and index in batches, reporting real progress as it goes.

        The whole reason batching exists here. Embedding every chunk in one call is marginally
        faster and gives the caller nothing to look at for the entire wait — which, on a cold host
        with a large report, is the difference between "working" and "hung" from the outside.

        Failure leaves the store holding the batches that succeeded. That is deliberate and
        matches how the rest of this class already behaves: a partially indexed document is
        recoverable by re-uploading it (which replaces), whereas discarding good work on the last
        batch's failure would make a transient error cost the whole run.
        """
        if not docs:
            return

        total = len(docs)
        if trace is not None:
            trace.progress(0, total)

        for start in range(0, total, self._EMBED_BATCH):
            batch = docs[start:start + self._EMBED_BATCH]
            self._index(batch)
            if trace is not None:
                trace.progress(min(start + len(batch), total), total)

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

    def add_pdf(self, filename: str, data: bytes, persist: bool = True,
                meeting_id: str | None = None) -> int:
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
            return self._add_pdf_locked(filename, data, persist, meeting_id)

    def _add_pdf_locked(self, filename: str, data: bytes, persist: bool,
                        meeting_id: str | None = None) -> int:
        name = self._safe_kb_name(filename)
        trace = IndexTrace(f"Indexing {name}")
        self._last_trace = trace

        with trace.step("Read the document", "pypdf") as s:
            reader = PdfReader(io.BytesIO(data))
            s["detail"] = f"{len(reader.pages)} page(s), {len(data) / 1024:.0f} kB"

        with trace.step("Split text into chunks",
                        "RecursiveCharacterTextSplitter (1000 chars, 150 overlap)") as s:
            docs = self._docs_from_reader(reader, name, meeting_id, trace)
            s["detail"] = f"{len(docs)} chunk(s)" + (
                "" if meeting_id is None else " — scoped to one meeting")

        if not docs:
            trace.finish("No extractable text — a scanned PDF needs OCR before it can be indexed.")
            return 0

        replacing = persist and (_KB_DIR / name).exists()

        if persist:
            with trace.step("Store the document", "filesystem") as s:
                _KB_DIR.mkdir(parents=True, exist_ok=True)
                (_KB_DIR / name).write_bytes(data)
                # Recorded BEFORE any rebuild below, so replacing a document re-reads the tag from
                # the manifest instead of silently promoting it to shared.
                self._tag_document(name, meeting_id)
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
                # Batched so the percentage is measured rather than guessed — see
                # _index_in_batches. This is the stage that takes the time, and the only one worth
                # putting a bar against.
                self._index_in_batches(docs, trace)
                self._sources.add(name)
                s["detail"] = f"{len(docs)} vector(s), 384 dimensions each"

        trace.finish()
        return len(docs)

    def remove_source(self, filename: str, active_meeting_id: str | None = None) -> dict:
        """Delete one document and everything derived from it. Returns the resulting status.

        Removal has to reach the vectors, not just the file. Deleting the PDF alone would leave its
        chunks embedded in a live index that no longer has anything to justify them: retrieval would
        keep returning passages from a document the operator believes they deleted, and cite it by
        name. That is the failure worth designing against — a deletion that appears to work.
        """
        with self._lock:
            return self._remove_source_locked(filename, active_meeting_id)

    def _remove_source_locked(self, filename: str, active_meeting_id: str | None = None) -> dict:
        name = self._safe_kb_name(filename)
        target = _KB_DIR / name

        # A document belonging to another meeting cannot be removed from here.
        #
        # Removal is destructive and irreversible — the file, its chunks and its vectors all go —
        # and doing it from a screen showing a different meeting's context means changing what THAT
        # meeting can cite without seeing it. Requiring the meeting to be active first makes the
        # consequence visible before the click.
        #
        # Shared documents (no tag) stay removable from anywhere: they belong to everything, so
        # there is no other context to be looking at.
        owner = self._load_manifest().get(name)
        if owner and owner != (active_meeting_id or ""):
            raise PermissionError(
                f"“{name}” belongs to another meeting. Activate that meeting first, then remove it "
                "— otherwise you would be changing what a meeting can cite without seeing it."
            )
        trace = IndexTrace(f"Removing {name}")
        self._last_trace = trace

        with trace.step("Delete the stored document", "filesystem") as s:
            if not target.exists():
                raise FileNotFoundError(f"“{name}” is not in the knowledge base.")
            target.unlink()
            # Drop the tag too. A manifest entry for a file that no longer exists is harmless
            # today, but it would silently re-scope a future upload that happened to reuse the
            # name — and "why is this document invisible" is a bad puzzle to leave behind.
            self._tag_document(name, None)
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
        manifest = self._load_manifest()
        return {
            "sources": sorted(self._sources),
            # filename -> meeting id, for documents that belong to one meeting. Anything absent
            # is shared with every meeting, which is the default.
            "scoped_documents": manifest,
            "chunks_indexed": self._chunk_count,
            "ready": bool(self._sources),
            # The most recent indexing or removal run, so the UI can show what the pipeline did.
            # Additive: existing callers that only read the three fields above are unaffected.
            "last_index_run": self._last_trace.snapshot() if self._last_trace else None,
        }

    def _retrieval_kwargs(self, k: int, meeting_id: str | None) -> dict:
        """Search arguments, with the meeting filter applied when there is one.

        FAISS applies a metadata predicate AFTER fetching, so a filtered search that fetches only
        `k` candidates can return fewer than `k` results — or none at all — purely because the
        nearest neighbours happened to belong to another meeting. `fetch_k` widens the candidate
        pool so the filter has something to keep.

        The multiplier is a trade: too small and a meeting with few documents returns a thin
        answer, too large and every query pays for scanning the whole index. Four times the
        requested k, floored at 40, keeps small meetings usable without making the common case
        expensive.
        """
        kwargs: dict = {"k": k}
        predicate = self._meeting_filter(meeting_id)
        if predicate is not None:
            kwargs["filter"] = predicate
            kwargs["fetch_k"] = max(40, k * 4)
        return kwargs

    def search(self, query: str, k: int = 8, meeting_id: str | None = None) -> list[SearchHit]:
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
        kwargs = self._retrieval_kwargs(k, meeting_id)
        try:
            scored = self._store.similarity_search_with_relevance_scores(clean, **kwargs)
        except Exception:
            # Relevance scoring depends on the store's distance strategy having a known mapping.
            # Falling back to raw distance keeps search working rather than failing over a number
            # that only decorates the result.
            scored = [(doc, None)
                      for doc, _ in self._store.similarity_search_with_score(clean, **kwargs)]

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

    def draft(self, cluster_id: str, question: str, k: int = 4,
              meeting_id: str | None = None) -> DraftResponse:
        """The RAG step: retrieve → augment → generate a grounded, cited answer.

        1. RETRIEVE the k report chunks most semantically similar to the question (vector search).
        2. AUGMENT: stitch those chunks (with their source tags) into a context block.
        3. GENERATE: the LLM chain answers strictly from that context (see the prompt).
        4. Attach the retrieved chunks as citations so the moderator can verify the source.
        """
        assert self._store is not None, "KB not loaded"
        # Retrieval is confined to this meeting's documents plus the shared ones, so an answer
        # cannot be grounded in a document belonging to a different meeting.
        hits = self._store.similarity_search(
            question, **self._retrieval_kwargs(k, meeting_id))       # 1) top-k nearest chunks
        context = "\n\n".join(f"[{d.metadata.get('source')}] {d.page_content}" for d in hits)  # 2)
        answer = self._get_chain().invoke({"question": question, "context": context})          # 3)
        citations = [_citation(d) for d in hits]                      # 4) source + seek target
        return DraftResponse(cluster_id=cluster_id, answer=answer.strip(), citations=citations)

    def chat(self, message: str, k: int = 4, meeting_id: str | None = None) -> ChatResponse:
        """Shareholder-facing GenAI chat: same RAG retrieve→augment→generate as draft(), but with
        a conversational prompt. Grounded on the annual report, returns answer + citations."""
        assert self._store is not None, "KB not loaded"
        hits = self._store.similarity_search(message, **self._retrieval_kwargs(k, meeting_id))
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
