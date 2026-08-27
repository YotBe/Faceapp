"""Embedding arithmetic.

Small module, but every function in it is on the path that decides whether a
stranger's photographs get returned to somebody, so the edge cases are handled
explicitly rather than left to numpy's defaults.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from .types import EMBEDDING_DIM, Embedding


def l2_normalize(vec: np.ndarray, *, eps: float = 1e-12) -> Embedding:
    """Scale to unit length.

    Cosine similarity is only equal to the dot product for unit vectors, and the
    pgvector index is built with `vector_cosine_ops` on the assumption that
    everything stored is normalized. A vector that slips through un-normalized
    does not error anywhere — it just scores wrongly, quietly, for as long as it
    is in the index. Hence the explicit zero check rather than letting a divide
    by zero produce NaNs.
    """
    arr = np.asarray(vec, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(arr))
    if norm < eps:
        raise ValueError("cannot normalize a zero-length embedding")
    return (arr / norm).astype(np.float32)


def average_embeddings(embeddings: Sequence[np.ndarray]) -> Embedding:
    """Combine several frames of the same person into one enrollment template.

    A single selfie is a weak enrollment: one embedding, one lighting condition,
    one expression, one angle. Averaging the normalized embeddings of three
    frames and renormalizing is the cheapest available improvement — it pulls the
    template toward the centre of that person's cluster instead of leaving it
    wherever one particular frame happened to land.

    Each input is normalized first. Averaging raw embeddings of differing
    magnitude would silently weight the frames by their norms.
    """
    if not embeddings:
        raise ValueError("no frames to average")

    stacked = np.stack([l2_normalize(e) for e in embeddings])
    if stacked.shape[1] != EMBEDDING_DIM:
        raise ValueError(f"expected {EMBEDDING_DIM}-d embeddings, got {stacked.shape[1]}-d")

    return l2_normalize(stacked.mean(axis=0))


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity, computed without assuming the inputs are normalized."""
    return float(np.dot(l2_normalize(a), l2_normalize(b)))


def cosine_similarity_matrix(queries: np.ndarray, gallery: np.ndarray) -> np.ndarray:
    """(Q, D) x (G, D) -> (Q, G) similarities.

    Both sides are renormalized. Doing it here rather than trusting the caller
    costs one pass over the data and removes a whole category of silent scoring
    bug from the eval harness.
    """
    q = np.atleast_2d(np.asarray(queries, dtype=np.float32))
    g = np.atleast_2d(np.asarray(gallery, dtype=np.float32))
    if q.shape[1] != g.shape[1]:
        raise ValueError(f"dimension mismatch: queries are {q.shape[1]}-d, gallery {g.shape[1]}-d")

    qn = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    gn = g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-12)
    return (qn @ gn.T).astype(np.float32)
