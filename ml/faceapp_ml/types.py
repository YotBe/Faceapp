"""Core value types.

These are the boundary between the face-recognition library we happen to be
using and the rest of the system. Nothing from InsightFace, ONNX or any future
vendor may appear beyond this module — the whole point of `FaceEngine` is that
swapping the implementation does not reach the database schema.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray

Embedding = NDArray[np.float32]
"""A 512-dimensional L2-normalized face template."""

Image = NDArray[np.uint8]
"""An RGB image, shape (H, W, 3)."""

EMBEDDING_DIM = 512


@dataclass(frozen=True, slots=True)
class BBox:
    """Axis-aligned face box in pixel coordinates."""

    x: float
    y: float
    w: float
    h: float

    def __post_init__(self) -> None:
        if self.w <= 0 or self.h <= 0:
            raise ValueError(f"degenerate bbox: {self.w}x{self.h}")

    @property
    def min_side(self) -> float:
        """The `face_px` of the schema: how big the face is at its smallest.

        Using the smaller side rather than the larger one, or the diagonal, is
        the conservative choice — a box that is wide but short is a partially
        cropped or heavily rotated face, and should be graded on the dimension
        that actually limits how much of the face was seen.
        """
        return min(self.w, self.h)

    @property
    def area(self) -> float:
        return self.w * self.h

    @property
    def center(self) -> tuple[float, float]:
        return (self.x + self.w / 2.0, self.y + self.h / 2.0)

    def clipped_to(self, width: int, height: int) -> BBox:
        """Clamp to image bounds. Detectors routinely return boxes off the edge."""
        x0 = max(0.0, min(self.x, float(width)))
        y0 = max(0.0, min(self.y, float(height)))
        x1 = max(0.0, min(self.x + self.w, float(width)))
        y1 = max(0.0, min(self.y + self.h, float(height)))
        return BBox(x0, y0, max(x1 - x0, 1e-6), max(y1 - y0, 1e-6))

    def to_json(self) -> dict[str, float]:
        """The `faces.bbox` jsonb payload."""
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


@dataclass(frozen=True, slots=True)
class Pose:
    """Head pose in degrees, or None where the engine cannot supply it.

    `pitch` is None whenever pose was approximated from five landmarks, because
    five points do not determine it. Recording None is better than recording a
    number nobody should trust.
    """

    yaw: float | None = None
    pitch: float | None = None
    roll: float | None = None

    @property
    def abs_yaw(self) -> float | None:
        return None if self.yaw is None else abs(self.yaw)


@dataclass(frozen=True, slots=True)
class Detection:
    """What the detector found, before any decision about whether to embed it.

    Landmarks are carried here so that pose can be approximated and the crop
    aligned, and are then dropped: they are never persisted. See
    docs/COMPLIANCE.md — face geometry we do not need for matching is a
    liability we would have to defend.
    """

    bbox: BBox
    det_score: float
    landmarks: NDArray[np.float32] | None = None  # (5, 2) — eyes, nose, mouth corners
    pose: Pose = Pose()

    @property
    def face_px(self) -> int:
        return round(self.bbox.min_side)


@dataclass(frozen=True, slots=True)
class QualityAssessment:
    """The tier decision, and why.

    `reasons` exists so the ingestion dashboard can tell an operator *why* their
    album graded badly — "3,400 faces below 40px" is actionable, "recall may be
    low" is not.
    """

    tier: int
    blur_score: float | None
    reasons: tuple[str, ...] = ()

    @property
    def rejected(self) -> bool:
        return self.tier == 0


@dataclass(frozen=True, slots=True)
class Face:
    """A detection that passed the gate and was embedded.

    Tier 0 never reaches this type. That is enforced here as well as in the
    database, because the invariant is worth stating in both places.
    """

    detection: Detection
    embedding: Embedding
    quality: QualityAssessment

    def __post_init__(self) -> None:
        if self.quality.tier not in (1, 2):
            raise ValueError(
                f"tier {self.quality.tier} face must never be embedded or stored"
            )
        if self.embedding.shape != (EMBEDDING_DIM,):
            raise ValueError(f"expected a {EMBEDDING_DIM}-d embedding, got {self.embedding.shape}")

    def to_row(self, *, photo_id: str, event_id: str) -> dict[str, Any]:
        """The `faces` insert payload.

        Note what is absent: no crop, no landmarks, no image reference beyond the
        photo id.
        """
        d = self.detection
        return {
            "photo_id": photo_id,
            "event_id": event_id,
            "embedding": self.embedding.tolist(),
            "bbox": d.bbox.to_json(),
            "det_score": float(d.det_score),
            "face_px": d.face_px,
            "yaw": d.pose.yaw,
            "pitch": d.pose.pitch,
            "roll": d.pose.roll,
            "blur_score": self.quality.blur_score,
            "quality_tier": self.quality.tier,
        }
