"""Quality gating.

The spec budgets 30% of the effort on this and 20% on detection and search, and
that ratio is right. Off-the-shelf face recognition is superhuman on clean
images; what decides whether this product works is what you refuse to index.

Three tiers:

    0   rejected. Never embedded, never stored. This is what stops a 25-pixel
        face in the background of a crowd shot from generating a false match
        against somebody's selfie.
    1   weak. Indexed, but only searched in the secondary "maybe" pass, never
        auto-included in a download and never auto-sent.
    2   good. The confident result set.

Constants live in `config/quality.toml`, not here.
"""

from __future__ import annotations

import math
import tomllib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .types import BBox, Detection, Image, Pose, QualityAssessment

DEFAULT_QUALITY_CONFIG = Path(__file__).resolve().parent.parent / "config" / "quality.toml"


@dataclass(frozen=True, slots=True)
class QualityPolicy:
    """The tier table, as data.

    Boundary handling follows the spec literally: rejection is `<`, promotion to
    tier 2 is `>`. A face at exactly 70px, or with a detection score of exactly
    0.70, is tier 1 — the spec's tier-1 band is "40–70" inclusive and its tier-2
    band is "> 70", so the boundary belongs to the weaker tier. That is also the
    safe direction to resolve the ambiguity: a borderline face lands in the
    "maybe" bucket rather than in a set that gets auto-delivered.
    """

    # Tier 0 — rejection
    min_face_px: int = 40
    min_det_score: float = 0.5

    # Tier 2 — promotion
    good_face_px: int = 70
    good_det_score: float = 0.7
    max_yaw_deg: float = 40.0

    # Blur demotes tier 2 to tier 1; it never rejects. See blur_score() for what
    # the number means and why this default is provisional.
    min_blur_score: float | None = 45.0

    # Only used when the engine cannot supply a real pose. See estimate_pose().
    yaw_from_landmarks_scale_deg: float = 90.0

    @classmethod
    def load(cls, path: Path | str | None = None) -> QualityPolicy:
        path = Path(path) if path is not None else DEFAULT_QUALITY_CONFIG
        with path.open("rb") as fh:
            data = tomllib.load(fh)
        section = data.get("quality", data)
        known = {f for f in cls.__slots__}
        unknown = set(section) - known
        if unknown:
            raise ValueError(f"unknown quality settings in {path}: {sorted(unknown)}")
        return cls(**section)


# ---------------------------------------------------------------------------
# Blur
# ---------------------------------------------------------------------------


def _to_grayscale(image: Image) -> np.ndarray:
    arr = np.asarray(image)
    if arr.ndim == 2:
        return arr.astype(np.float32)
    if arr.ndim == 3 and arr.shape[2] >= 3:
        # Rec. 601 luma.
        return (
            0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
        ).astype(np.float32)
    raise ValueError(f"unsupported image shape {arr.shape}")


def _resize_bilinear(gray: np.ndarray, size: int) -> np.ndarray:
    """Bilinear resample to `size` x `size`.

    Implemented on numpy rather than pulling in OpenCV: the core package has to
    stay installable without the model extras, so that CI can test the tier
    table without downloading 300MB of weights.
    """
    h, w = gray.shape
    if h == size and w == size:
        return gray

    ys = np.linspace(0, h - 1, size, dtype=np.float32)
    xs = np.linspace(0, w - 1, size, dtype=np.float32)

    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    y1 = np.minimum(y0 + 1, h - 1)
    x1 = np.minimum(x0 + 1, w - 1)
    wy = (ys - y0)[:, None]
    wx = (xs - x0)[None, :]

    top = gray[np.ix_(y0, x0)] * (1 - wx) + gray[np.ix_(y0, x1)] * wx
    bottom = gray[np.ix_(y1, x0)] * (1 - wx) + gray[np.ix_(y1, x1)] * wx
    return top * (1 - wy) + bottom * wy


def blur_score(image: Image, bbox: BBox, *, crop_size: int = 112) -> float:
    """Variance of the Laplacian over the face crop. Higher is sharper.

    The crop is resampled to a fixed 112x112 first, which matters more than it
    looks: Laplacian variance scales with resolution, so without normalisation a
    large sharp face and a small sharp face would score an order of magnitude
    apart and a single threshold could not separate sharp from blurred at both
    sizes.

    The absolute scale is still arbitrary — it depends on the camera, the
    lighting and the JPEG quality of a particular photographer's album. Treat
    `min_blur_score` as provisional until the eval harness has reported metrics
    sliced by blur on a real album. It is deliberately wired so that getting it
    wrong costs recall in the confident set rather than admitting false
    positives: blur can only demote tier 2 to tier 1, never reject.
    """
    arr = np.asarray(image)
    h, w = arr.shape[:2]
    b = bbox.clipped_to(w, h)

    y0, y1 = int(b.y), max(int(b.y + b.h), int(b.y) + 1)
    x0, x1 = int(b.x), max(int(b.x + b.w), int(b.x) + 1)
    crop = arr[y0:y1, x0:x1]
    if crop.size == 0:
        return 0.0

    gray = _resize_bilinear(_to_grayscale(crop), crop_size)

    # 4-neighbour Laplacian, interior only.
    lap = (
        gray[:-2, 1:-1]
        + gray[2:, 1:-1]
        + gray[1:-1, :-2]
        + gray[1:-1, 2:]
        - 4.0 * gray[1:-1, 1:-1]
    )
    return float(lap.var())


# ---------------------------------------------------------------------------
# Pose
# ---------------------------------------------------------------------------

_LEFT_EYE, _RIGHT_EYE, _NOSE = 0, 1, 2


def estimate_pose_from_landmarks(
    landmarks: np.ndarray, *, yaw_scale_deg: float = 90.0
) -> Pose:
    """Approximate head pose from five landmarks.

    This is a fallback. `buffalo_l` includes a 3D landmark model that gives a
    properly estimated pose, and `InsightFaceEngine` uses it when present; this
    path exists for engines that only return the five-point set.

    - **roll** is exact enough to trust: it is the angle of the line between the
      eyes.
    - **yaw** is approximated from where the nose sits between the eyes. A
      frontal face puts it halfway; turning the head slides it toward the
      near eye. The mapping from that offset to degrees is linear and calibrated
      by `yaw_scale_deg`, which is a rough constant, not a measurement. It is
      good enough to separate "roughly frontal" from "strong profile", which is
      all the tier table asks of it.
    - **pitch** is not recoverable from five coplanar-ish points and is returned
      as None rather than as a number nobody should rely on.
    """
    pts = np.asarray(landmarks, dtype=np.float32)
    if pts.shape != (5, 2):
        raise ValueError(f"expected 5 landmarks, got shape {pts.shape}")

    left_eye, right_eye, nose = pts[_LEFT_EYE], pts[_RIGHT_EYE], pts[_NOSE]

    dx = float(right_eye[0] - left_eye[0])
    dy = float(right_eye[1] - left_eye[1])
    roll = math.degrees(math.atan2(dy, dx))

    eye_dist = math.hypot(dx, dy)
    if eye_dist < 1e-6:
        return Pose(yaw=None, pitch=None, roll=roll)

    eye_mid_x = (float(left_eye[0]) + float(right_eye[0])) / 2.0
    # -0.5 (nose at the left eye) .. +0.5 (nose at the right eye), 0 when frontal.
    offset = (float(nose[0]) - eye_mid_x) / eye_dist
    yaw = max(-90.0, min(90.0, offset * 2.0 * yaw_scale_deg))

    return Pose(yaw=yaw, pitch=None, roll=roll)


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def assess(
    detection: Detection,
    *,
    policy: QualityPolicy,
    image: Image | None = None,
    blur: float | None = None,
) -> QualityAssessment:
    """Grade one detection.

    Pass `image` to have blur measured, or `blur` if it has already been
    computed. With neither, blur is not considered — a missing measurement must
    not silently demote every face in an album.
    """
    reasons: list[str] = []
    face_px = detection.face_px
    det_score = float(detection.det_score)

    # --- Tier 0: reject -----------------------------------------------------
    if face_px < policy.min_face_px:
        reasons.append(f"face_px {face_px} < {policy.min_face_px}")
    if det_score < policy.min_det_score:
        reasons.append(f"det_score {det_score:.3f} < {policy.min_det_score}")
    if reasons:
        return QualityAssessment(tier=0, blur_score=None, reasons=tuple(reasons))

    # Blur is only measured for faces that survived rejection. There is no point
    # analysing a crop we have already thrown away, and on a 100k-photo album
    # that is a meaningful amount of work not done.
    if blur is None and image is not None:
        blur = blur_score(image, detection.bbox)

    # --- Tier 2: promote ----------------------------------------------------
    if face_px <= policy.good_face_px:
        reasons.append(f"face_px {face_px} not above {policy.good_face_px}")
    if det_score <= policy.good_det_score:
        reasons.append(f"det_score {det_score:.3f} not above {policy.good_det_score}")

    abs_yaw = detection.pose.abs_yaw
    if abs_yaw is not None and abs_yaw >= policy.max_yaw_deg:
        reasons.append(f"|yaw| {abs_yaw:.1f} >= {policy.max_yaw_deg}")

    if blur is not None and policy.min_blur_score is not None and blur < policy.min_blur_score:
        reasons.append(f"blur {blur:.1f} < {policy.min_blur_score}")

    tier = 1 if reasons else 2
    return QualityAssessment(tier=tier, blur_score=blur, reasons=tuple(reasons))


@dataclass(frozen=True, slots=True)
class GateStats:
    """Rejection accounting for one album.

    The spec asks for this by name: if more than 60% of detections are rejected,
    the photographer is shooting wide crowds and the operator has to be warned
    about expected recall before the event rather than after it.
    """

    detected: int = 0
    rejected: int = 0
    tier1: int = 0
    tier2: int = 0

    @property
    def rejection_rate(self) -> float:
        return self.rejected / self.detected if self.detected else 0.0

    def warns(self, *, limit: float = 0.60) -> bool:
        return self.detected > 0 and self.rejection_rate > limit

    def merged(self, other: GateStats) -> GateStats:
        return GateStats(
            detected=self.detected + other.detected,
            rejected=self.rejected + other.rejected,
            tier1=self.tier1 + other.tier1,
            tier2=self.tier2 + other.tier2,
        )

    @classmethod
    def of(cls, assessments: list[QualityAssessment]) -> GateStats:
        return cls(
            detected=len(assessments),
            rejected=sum(1 for a in assessments if a.tier == 0),
            tier1=sum(1 for a in assessments if a.tier == 1),
            tier2=sum(1 for a in assessments if a.tier == 2),
        )
