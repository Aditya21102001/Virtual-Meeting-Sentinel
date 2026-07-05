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


class Citation(BaseModel):
    source: str
    snippet: str


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
