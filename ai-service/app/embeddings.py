"""Local sentence-transformer embeddings — runs in-process, zero API cost.

The model (~90MB) downloads once on first use and is cached in the container.
Wrapped as a LangChain Embeddings so the RAG chain and clustering share one model.
"""
from functools import lru_cache
import numpy as np
from langchain_core.embeddings import Embeddings
from sentence_transformers import SentenceTransformer

from .config import get_settings


class LocalEmbeddings(Embeddings):
    """LangChain-compatible wrapper around a local SentenceTransformer."""

    def __init__(self, model_name: str):
        self._model = SentenceTransformer(model_name)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        vecs = self._model.encode(
            texts, normalize_embeddings=True, convert_to_numpy=True
        )
        return vecs.tolist()

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]

    @property
    def dim(self) -> int:
        return self._model.get_sentence_embedding_dimension()


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
