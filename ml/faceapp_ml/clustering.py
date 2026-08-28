"""Grouping face embeddings, with no database and no vendor behind it.

This lives in `faceapp_ml` rather than in the worker because two very different
callers need it and only one of them can talk to Postgres:

  * `faceapp_worker.cluster` groups an event's tier-2 faces into centroids so a
    search hits a few thousand of those instead of every face in the album.
  * `eval.label` groups an album's faces to save a human from typing a labelling
    CSV by hand.

The second one runs on a laptop with the `dev` extra installed and nothing else,
so anything it imports must not drag in psycopg.

The two callers choose `eps` for different reasons and neither may borrow the
other's. The worker derives it from the tuned `T_high` — two faces are one
person at the same similarity at which we would tell an attendee "this is you".
The labelling tool has no tuned threshold to derive from (that is the thing it
exists to produce) and passes a deliberately tight provisional value instead.
Keeping the parameter explicit is what stops those two meanings collapsing into
one constant that is wrong for both.
"""

from __future__ import annotations

import numpy as np


def dbscan_cosine(embeddings: np.ndarray, eps: float, min_samples: int) -> np.ndarray:
    """DBSCAN on cosine distance. Returns a label per row, -1 for noise.

    Implemented here rather than pulling in scikit-learn: the worker image
    already carries onnxruntime and a model pack, and this is fifty lines of
    numpy against another 100MB of dependency. The distance matrix is O(n^2),
    which is fine for one event's tier-2 faces and is the reason this runs
    per-event rather than across the whole database.

    DBSCAN and not k-means because we do not know how many people are in the
    album, which is the one thing k-means requires — and because DBSCAN has a
    concept of noise. A face that belongs to no group stays unassigned rather
    than being forced into the nearest one, and forcing it is exactly how a
    stranger ends up in somebody's results.
    """
    n = embeddings.shape[0]
    if n == 0:
        return np.zeros(0, dtype=np.int32)

    # Both sides are normalized, so the dot product is the cosine similarity.
    similarity = embeddings @ embeddings.T
    neighbours = similarity >= (1.0 - eps)

    labels = np.full(n, -1, dtype=np.int32)
    visited = np.zeros(n, dtype=bool)
    cluster = 0

    for start in range(n):
        if visited[start]:
            continue
        visited[start] = True

        seeds = list(np.flatnonzero(neighbours[start]))
        if len(seeds) < min_samples:
            continue  # noise, for now — a later cluster may still absorb it

        labels[start] = cluster
        queue = [s for s in seeds if s != start]
        while queue:
            point = queue.pop()
            if not visited[point]:
                visited[point] = True
                point_neighbours = list(np.flatnonzero(neighbours[point]))
                if len(point_neighbours) >= min_samples:
                    queue.extend(p for p in point_neighbours if labels[p] == -1)
            if labels[point] == -1:
                labels[point] = cluster
        cluster += 1

    return labels
