"""Local embeddings — runs in-process, zero API cost.

The model is `all-MiniLM-L6-v2`, executed through ONNX Runtime rather than PyTorch. Wrapped as a
LangChain Embeddings so the RAG chain and clustering share one model.

Why not sentence-transformers: it is a training framework, and importing it costs roughly 310 MB
resident to run 90 MB of weights for inference only. Measured on this service, the whole process
reached 457 MB resident before serving a single request, against a hard 512 MB instance ceiling —
the container was killed during startup, every time. ONNX Runtime executes the identical weights for
a fraction of that, because inference is all this service has ever needed.

The vectors are unchanged, and that is the point. Same weights, same mean pooling, same L2
normalisation: output agrees with the sentence-transformers implementation to six decimal places,
and vectors come back unit-length, which is what lets `cosine` below reduce to a dot product. A swap
that altered the vectors would silently invalidate every embedding already stored in pgvector and
quietly shift the meaning of the clustering thresholds — a migration that looks clean on the day and
degrades deduplication from then on.
"""
from functools import lru_cache

import numpy as np
from fastembed import TextEmbedding
from langchain_core.embeddings import Embeddings

from .config import get_settings


class LocalEmbeddings(Embeddings):
    """LangChain-compatible wrapper around a local ONNX sentence encoder."""

    def __init__(self, model_name: str):
        self._model = TextEmbedding(model_name=model_name)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        # embed() yields per batch, so the whole corpus is never resident as vectors at once.
        return [vec.tolist() for vec in self._model.embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]

    @property
    def dim(self) -> int:
        return len(self.embed_query("dimension probe"))


@lru_cache
def get_embeddings() -> LocalEmbeddings:
    return LocalEmbeddings(get_settings().embedding_model)


def cosine(a: list[float] | np.ndarray, b: list[float] | np.ndarray) -> float:
    """Cosine similarity. Vectors are already L2-normalized, so this is a dot product,
    but we normalize defensively in case a non-normalized vector is passed."""
    a, b = np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))
