"""InsightFace `buffalo_l` implementation.

Detection is SCRFD `det_10g`, recognition is ArcFace `w600k_r50` producing
512-d templates, pose comes from the `1k3d68` 3D landmark model. CPU-only via
onnxruntime.

Measured per stage on one shared vCPU, 1280x886, six faces:

    detect       129ms   once per photograph
    pose          37ms   per surviving face
    embed        105ms   per surviving face
    blur           0.6ms per surviving face

So a photograph costs roughly `130ms + 145ms x (faces that survive the gate)`.
A two-face shot is around 400ms; a crowded six-face one is around 1.3s. Worth
knowing when sizing ingestion: the spec's cost model assumes 250ms per
photograph, which holds for portraits and is optimistic for festival crowds.

It also means the tier-0 gate is the single biggest performance lever as well as
the compliance one. Rejecting a face before embedding it saves 145ms; on an
album where 60% of detections are background faces, that is most of the
ingestion budget. The ordering in `FaceEngine.detect_and_embed` is doing both
jobs at once.

Two deliberate choices worth not undoing:

**The `genderage` model is not loaded.** It ships in the buffalo_l pack and
`FaceAnalysis` will happily run it on every face. We have no use for estimated
gender or age, and inferring demographic attributes about several thousand
people who never asked us to is exactly the kind of processing that turns a
photo tool into something a regulator has questions about. `allowed_modules`
keeps it off disk-to-memory and off the code path.

**Nothing here escapes into the rest of the package.** The BGR channel order,
the `Face` dict, the (N, 5) bbox-with-score array — all of that is a detail of
this file. Callers get `Detection` and `Embedding`.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..embeddings import l2_normalize
from ..types import BBox, Detection, Embedding, Image, Pose
from .base import FaceEngine

# Everything the buffalo_l pack contains, minus genderage. landmark_2d_106 is
# also left out: the 3D model already gives us pose, and 106 2D points is more
# facial geometry than we have any use for.
ALLOWED_MODULES = ("detection", "recognition", "landmark_3d_68")


class InsightFaceEngine(FaceEngine):
    name = "insightface/buffalo_l"

    def __init__(
        self,
        *,
        model_name: str = "buffalo_l",
        det_size: tuple[int, int] = (640, 640),
        # Below the quality policy's `min_det_score`, on purpose: the detector
        # should hand us everything it saw and let our gate make the decision.
        # If the library filtered at 0.5 too, the rejection statistics the
        # operator dashboard reports would be missing everything the detector
        # had already dropped, and the album would look cleaner than it is.
        det_thresh: float = 0.35,
        ctx_id: int = -1,  # -1 = CPU
        root: str | None = None,
    ) -> None:
        try:
            from insightface.app import FaceAnalysis
        except ImportError as exc:  # pragma: no cover - exercised by install, not tests
            raise ImportError(
                "InsightFaceEngine needs the model extras: pip install '.[insightface]'"
            ) from exc

        kwargs: dict[str, Any] = {
            "name": model_name,
            "allowed_modules": list(ALLOWED_MODULES),
            "providers": ["CPUExecutionProvider"] if ctx_id < 0 else None,
        }
        if root is not None:
            kwargs["root"] = root
        kwargs = {k: v for k, v in kwargs.items() if v is not None}

        self._app = FaceAnalysis(**kwargs)
        self._app.prepare(ctx_id=ctx_id, det_size=det_size, det_thresh=det_thresh)

        self._detector = self._app.models["detection"]
        self._recognizer = self._app.models["recognition"]
        self._landmarker = self._app.models.get("landmark_3d_68")

        self.model_name = model_name
        self.det_thresh = det_thresh

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _to_bgr(image: Image) -> np.ndarray:
        """RGB in, BGR out. InsightFace inherits OpenCV's channel order.

        This is called once for detection and twice per surviving face. Caching
        it was tried and removed: thirteen full-frame swaps of a 1280x886 array
        measure under a millisecond in total, against a pipeline that spends
        over a second in ONNX, and the cache needed an `id()`-keyed entry to be
        worth anything. Not a trade worth making.
        """
        arr = np.asarray(image)
        if arr.ndim != 3 or arr.shape[2] < 3:
            raise ValueError(f"expected an RGB image, got shape {arr.shape}")
        return np.ascontiguousarray(arr[:, :, ::-1])

    def _as_library_face(self, detection: Detection) -> Any:
        from insightface.app.common import Face as _LibFace

        b = detection.bbox
        face = _LibFace(
            bbox=np.array([b.x, b.y, b.x + b.w, b.y + b.h], dtype=np.float32),
            det_score=float(detection.det_score),
        )
        if detection.landmarks is not None:
            face.kps = np.asarray(detection.landmarks, dtype=np.float32)
        return face

    # -- FaceEngine --------------------------------------------------------

    def detect(self, image: Image) -> list[Detection]:
        bgr = self._to_bgr(image)
        boxes, keypoints = self._detector.detect(bgr, max_num=0, metric="default")
        if boxes is None or len(boxes) == 0:
            return []

        out: list[Detection] = []
        for i, row in enumerate(boxes):
            x1, y1, x2, y2, score = (float(v) for v in row[:5])
            kps = (
                np.asarray(keypoints[i], dtype=np.float32)
                if keypoints is not None and len(keypoints) > i
                else None
            )
            out.append(
                Detection(
                    bbox=BBox(x1, y1, max(x2 - x1, 1e-6), max(y2 - y1, 1e-6)),
                    det_score=score,
                    landmarks=kps,
                )
            )
        return out

    def estimate_pose(self, image: Image, detection: Detection) -> Detection:
        """Real pose from the 3D landmark model, when it is loaded.

        The model returns (pitch, yaw, roll) in degrees. Falls back to the
        five-point approximation in the base class if the model is unavailable —
        which is a real possibility, since `allowed_modules` is configurable.
        """
        if self._landmarker is None:
            return super().estimate_pose(image, detection)

        bgr = self._to_bgr(image)
        face = self._as_library_face(detection)
        self._landmarker.get(bgr, face)

        raw = face.get("pose")
        if raw is None:
            return super().estimate_pose(image, detection)

        pitch, yaw, roll = (float(v) for v in np.asarray(raw).reshape(-1)[:3])
        return Detection(
            bbox=detection.bbox,
            det_score=detection.det_score,
            landmarks=detection.landmarks,
            pose=Pose(yaw=yaw, pitch=pitch, roll=roll),
        )

    def embed(self, image: Image, detection: Detection) -> Embedding:
        if detection.landmarks is None:
            raise ValueError(
                "cannot embed without landmarks: ArcFace needs them to align the crop, "
                "and an unaligned crop scores badly enough to look like a different person"
            )
        bgr = self._to_bgr(image)
        face = self._as_library_face(detection)
        raw = self._recognizer.get(bgr, face)
        return l2_normalize(np.asarray(raw, dtype=np.float32))
