"""A `FaceEngine` that returns exactly what you tell it to.

This exists so the parts of the pipeline that are *policy* — the tier table, the
order in which the gate and the embedder run, multi-frame enrollment — can be
tested exhaustively and in milliseconds, without downloading 300MB of weights
and without depending on what a particular model happens to think of a
particular JPEG.

It is not a fake face recogniser. It makes no claim about matching. Tests that
need real recognition behaviour need real images and a real engine, and those
live behind a marker so CI can run without them.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from ..embeddings import l2_normalize
from ..types import Detection, Embedding, Image
from .base import FaceEngine


@dataclass(frozen=True)
class ScriptedFace:
    detection: Detection
    embedding: Embedding


@dataclass
class ScriptedEngine(FaceEngine):
    """Plays back one scripted frame per `detect()` call, in order."""

    frames: Sequence[Sequence[ScriptedFace]]
    name: str = "scripted"
    _cursor: int = field(default=0, init=False)
    _current: list[ScriptedFace] = field(default_factory=list, init=False)

    detect_calls: int = field(default=0, init=False)
    embed_calls: int = field(default=0, init=False)
    pose_calls: int = field(default=0, init=False)

    def detect(self, image: Image) -> list[Detection]:
        del image
        if self._cursor >= len(self.frames):
            raise AssertionError(
                f"detect() called {self._cursor + 1} times but only "
                f"{len(self.frames)} frames were scripted"
            )
        self._current = list(self.frames[self._cursor])
        self._cursor += 1
        self.detect_calls += 1
        return [f.detection for f in self._current]

    def estimate_pose(self, image: Image, detection: Detection) -> Detection:
        self.pose_calls += 1
        return super().estimate_pose(image, detection)

    def embed(self, image: Image, detection: Detection) -> Embedding:
        del image
        self.embed_calls += 1
        # Matched on the box rather than on object identity: by the time this is
        # called the detection has been through pose estimation and is a
        # different object.
        key = (detection.bbox.x, detection.bbox.y, detection.bbox.w, detection.bbox.h)
        for face in self._current:
            b = face.detection.bbox
            if (b.x, b.y, b.w, b.h) == key:
                return face.embedding
        raise AssertionError(f"embed() called for an unscripted detection at {key}")

    def reset(self) -> None:
        self._cursor = 0
        self.detect_calls = self.embed_calls = self.pose_calls = 0


def deterministic_embedding(seed: int, dim: int = 512) -> Embedding:
    """A stable unit vector for a given seed. Same seed, same vector, always."""
    rng = np.random.default_rng(seed)
    return l2_normalize(rng.normal(size=dim).astype(np.float32))
