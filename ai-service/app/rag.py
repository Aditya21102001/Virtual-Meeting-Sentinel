"""RAG: draft a grounded, cited answer to a cluster's representative question.

Knowledge base = the company's annual report (PDF), chunked and embedded once at startup.
We keep it simple and free: FAISS in-memory index (no external vector DB needed for the KB).
Retrieval feeds a LangChain prompt -> free LLM (Groq/Gemini) -> answer + citations.
"""
from __future__ import annotations
import os
from pathlib import Path

from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader

from .embeddings import get_embeddings
from .llm import get_llm
from .schemas import ChatResponse, Citation, DraftResponse

_KB_DIR = Path(__file__).resolve().parent.parent / "knowledge"

_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You are an AGM assistant drafting a concise L1 answer for a company moderator. "
     "Answer ONLY from the provided context excerpts of the annual report. "
     "If the context does not contain the answer, say you cannot find it in the report "
     "and recommend escalation. Keep it under 120 words. Do not invent figures."),
    ("human",
     "Shareholder question (representative of a cluster):\n{question}\n\n"
     "Annual-report context:\n{context}\n\nDraft answer:"),
])

# Conversational variant for the shareholder-facing GenAI assistant (the Lounge chatbot).
_CHAT_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You are the AGM Sentinel assistant chatting directly with a shareholder. "
     "Answer their question ONLY from the provided excerpts of the company's annual report. "
     "If the report does not cover it, clearly say it isn't in the annual report and suggest "
     "they raise it as a live question for the board. Be friendly and concise (under 150 words). "
     "Never invent figures or facts."),
    ("human",
     "Shareholder message:\n{question}\n\nAnnual-report context:\n{context}\n\nReply:"),
])


class KnowledgeBase:
    """FAISS index over the annual report. Rebuilt on startup from PDFs in ai-service/knowledge/."""

    def __init__(self):
        self._store: FAISS | None = None
        self._chain = None
        self._chat_chain = None            # lazy conversational chain for the Lounge assistant
        self._sources: set[str] = set()   # filenames currently indexed
        self._chunk_count = 0
        self._placeholder_only = False     # True when only the "no report" fallback is loaded

    def load(self) -> None:
        docs = self._load_documents()
        embeddings = get_embeddings()
        if docs:
            self._store = FAISS.from_documents(docs, embeddings)
            self._chunk_count = len(docs)
            self._placeholder_only = False
        else:
            # Empty KB fallback so the service still boots without a PDF present.
            self._store = FAISS.from_documents(
                [Document(page_content="No annual report loaded.", metadata={"source": "none"})],
                embeddings,
            )
            self._chunk_count = 0
            self._placeholder_only = True
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

    def add_pdf(self, filename: str, data: bytes, persist: bool = True) -> int:
        """Ingest an uploaded annual-report PDF into the live FAISS index at runtime.

        Returns the number of chunks indexed. If the KB currently holds only the empty
        placeholder, we rebuild fresh so the placeholder can't pollute retrieval.
        """
        import io
        reader = PdfReader(io.BytesIO(data))
        docs = self._docs_from_reader(reader, filename)
        if not docs:
            return 0

        embeddings = get_embeddings()
        if self._store is None or self._placeholder_only:
            self._store = FAISS.from_documents(docs, embeddings)
            self._chunk_count = len(docs)
            self._placeholder_only = False
        else:
            self._store.add_documents(docs)
            self._chunk_count += len(docs)

        self._sources.add(filename)
        if persist:
            _KB_DIR.mkdir(parents=True, exist_ok=True)
            (_KB_DIR / filename).write_bytes(data)
        return len(docs)

    def status(self) -> dict:
        return {
            "sources": sorted(self._sources),
            "chunks_indexed": self._chunk_count,
            "ready": bool(self._sources),
        }

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
        citations = [                                                # 4) source + snippet per chunk
            Citation(source=d.metadata.get("source", "unknown"), snippet=d.page_content[:180])
            for d in hits
        ]
        return DraftResponse(cluster_id=cluster_id, answer=answer.strip(), citations=citations)

    def chat(self, message: str, k: int = 4) -> ChatResponse:
        """Shareholder-facing GenAI chat: same RAG retrieve→augment→generate as draft(), but with
        a conversational prompt. Grounded on the annual report, returns answer + citations."""
        assert self._store is not None, "KB not loaded"
        hits = self._store.similarity_search(message, k=k)
        context = "\n\n".join(f"[{d.metadata.get('source')}] {d.page_content}" for d in hits)
        answer = self._get_chat_chain().invoke({"question": message, "context": context})
        citations = [
            Citation(source=d.metadata.get("source", "unknown"), snippet=d.page_content[:180])
            for d in hits
        ]
        return ChatResponse(answer=answer.strip(), citations=citations)


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
