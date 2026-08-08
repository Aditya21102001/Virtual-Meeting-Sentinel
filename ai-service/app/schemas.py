"""Request/response models shared with the Spring Boot service."""
from typing import Optional
from pydantic import BaseModel, Field


class IngestRequest(BaseModel):
    question_id: str = Field(..., description="ID assigned by the backend")
    text: str
    attendee_id: str
    # Shareholder equity weight (0..1) — feeds the ranking score. Optional.
    weight: float = 0.0


class IngestResponse(BaseModel):
    question_id: str
    cluster_id: str
    is_new_cluster: bool
    similarity: float
    cluster_size: int


class DraftRequest(BaseModel):
    cluster_id: str
    representative_question: str


class ChatRequest(BaseModel):
    # A shareholder's free-form question to the GenAI assistant.
    message: str


class SearchRequest(BaseModel):
    query: str
    k: int = 8


class SearchHit(BaseModel):
    """One retrieved passage, with where it came from and how to get there.

    Deliberately the same shape as a Citation plus a score: a search result and a citation are the
    same thing seen from different ends, so the UI can render both with one component.
    """
    source: str
    snippet: str
    video_id: str | None = None
    at_seconds: float | None = None
    # 0-1 where the store can supply it, else null. Ordering, not a probability — a low score does
    # not mean "wrong", only "less close than the others in this result set".
    score: float | None = None


class TranscriptIndexRequest(BaseModel):
    """Ask for a recording's captions to be indexed into the knowledge base.

    The VTT text is sent rather than a file path: the backend owns the media (it may be on a NAS
    share or in a database) and this service has no access to either.
    """
    video_id: str
    title: str
    vtt: str


class KnowledgeRemoveRequest(BaseModel):
    """Ask for one indexed document to be deleted, named by its file in ai-service/knowledge/.

    Addressed by filename rather than by the label /knowledge/status displays, because a recording's
    label ("Recording: <title>") carries a human title that cannot be reversed into a filename — the
    title lives inside the file's NOTE block, and two recordings may share one. A PDF's label IS its
    filename, so the sources list is directly usable for the documents this exists to remove.

    Validation deliberately lives in the filesystem layer (KnowledgeBase._safe_kb_name) rather than
    here: one implementation, at the boundary that actually opens the path.
    """
    filename: str


class Citation(BaseModel):
    """Where a retrieved passage came from, and how to take the reader there.

    `source` is the human-readable label. The two optional fields are set only for passages that
    came from a meeting recording's transcript: they let the UI turn the citation into a link that
    opens the player at the exact second, the same way a report citation opens a PDF at a page.
    Explicit fields rather than a parseable `source` string — a recording title can contain any
    punctuation a naming convention might have relied on.
    """
    source: str
    snippet: str
    video_id: str | None = None
    at_seconds: float | None = None


class ChatResponse(BaseModel):
    answer: str
    citations: list["Citation"] = []


class DraftResponse(BaseModel):
    cluster_id: str
    answer: str
    citations: list[Citation]


class ClusterView(BaseModel):
    cluster_id: str
    representative_question: str
    size: int
    priority_score: float
    draft: Optional[str] = None
    citations: list[Citation] = []
