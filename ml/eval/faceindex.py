"""Turning a labeled dataset into something a threshold sweep can run over.

Indexing five hundred photographs takes minutes; sweeping thirty thresholds over
the result takes milliseconds. So indexing happens once and is cached, and the
sweep can be re-run freely while somebody argues about where the threshold
should sit.

The cache holds embeddings, which are biometric data. It is written under
`eval/cache/` and that directory is gitignored — see the block in the repo's
.gitignore explaining why a git repository is the worst possible place for this.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from faceapp_ml.embeddings import average_embeddings
from faceapp_ml.engine import EnrollmentError, FaceEngine
from faceapp_ml.quality import GateStats, QualityPolicy

from .dataset import LabeledDataset

CACHE_DIR = Path(__file__).resolve().parent / "cache"


@dataclass(slots=True)
class FaceIndex:
    """Every indexed face in the album, flattened.

    Parallel arrays rather than a list of objects: the sweep is entirely
    vectorised and this is the shape it wants.
    """

    photo_index: np.ndarray  # (F,) int   — row into `photo_ids`
    embeddings: np.ndarray  # (F, 512) float32, L2-normalized
    face_px: np.ndarray  # (F,) int
    det_score: np.ndarray  # (F,) float
    yaw: np.ndarray  # (F,) float, NaN where unknown
    blur: np.ndarray  # (F,) float, NaN where not measured
    tier: np.ndarray  # (F,) int8, 1 or 2

    photo_ids: list[str]
    engine_name: str
    gate: GateStats

    # person_id -> (512,) enrollment template
    queries: dict[str, np.ndarray]
    # people we could not enroll at all, with the reason
    enrollment_failures: dict[str, str]

    @property
    def n_faces(self) -> int:
        return int(self.embeddings.shape[0])

    @property
    def n_photos(self) -> int:
        return len(self.photo_ids)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            path,
            photo_index=self.photo_index,
            embeddings=self.embeddings,
            face_px=self.face_px,
            det_score=self.det_score,
            yaw=self.yaw,
            blur=self.blur,
            tier=self.tier,
            meta=np.array(
                json.dumps(
                    {
                        "photo_ids": self.photo_ids,
                        "engine_name": self.engine_name,
                        "gate": {
                            "detected": self.gate.detected,
                            "rejected": self.gate.rejected,
                            "tier1": self.gate.tier1,
                            "tier2": self.gate.tier2,
                        },
                        "enrollment_failures": self.enrollment_failures,
                        "query_ids": sorted(self.queries),
                    }
                )
            ),
            query_matrix=(
                np.stack([self.queries[k] for k in sorted(self.queries)])
                if self.queries
                else np.zeros((0, 512), dtype=np.float32)
            ),
        )

    @classmethod
    def load(cls, path: Path) -> FaceIndex:
        data = np.load(path, allow_pickle=False)
        meta = json.loads(str(data["meta"]))
        query_ids = meta["query_ids"]
        qm = data["query_matrix"]
        return cls(
            photo_index=data["photo_index"],
            embeddings=data["embeddings"],
            face_px=data["face_px"],
            det_score=data["det_score"],
            yaw=data["yaw"],
            blur=data["blur"],
            tier=data["tier"],
            photo_ids=list(meta["photo_ids"]),
            engine_name=str(meta["engine_name"]),
            gate=GateStats(**meta["gate"]),
            queries={pid: qm[i] for i, pid in enumerate(query_ids)},
            enrollment_failures=dict(meta["enrollment_failures"]),
        )


def _load_rgb(path: Path) -> np.ndarray:
    from PIL import Image as PILImage

    with PILImage.open(path) as im:
        return np.asarray(im.convert("RGB"))


def cache_key(dataset: LabeledDataset, engine: FaceEngine, policy: QualityPolicy) -> str:
    """Identity of an index: the dataset, the engine, and the gate that produced it.

    The policy is in the key because changing `min_face_px` changes which faces
    exist in the index. A cache that ignored it would silently serve results from
    the old gate, and the whole point of re-running the sweep after a policy
    change would be lost.
    """
    material = json.dumps(
        {
            "dataset": dataset.dataset_id,
            "engine": engine.name,
            "policy": {
                "min_face_px": policy.min_face_px,
                "min_det_score": policy.min_det_score,
                "good_face_px": policy.good_face_px,
                "good_det_score": policy.good_det_score,
                "max_yaw_deg": policy.max_yaw_deg,
                "min_blur_score": policy.min_blur_score,
            },
            "n_photos": len(dataset.photos),
        },
        sort_keys=True,
    )
    return hashlib.sha256(material.encode()).hexdigest()[:16]


def build_index(
    dataset: LabeledDataset,
    engine: FaceEngine,
    *,
    policy: QualityPolicy | None = None,
    progress: bool = True,
) -> FaceIndex:
    """Run the engine over every photograph and enroll every person."""
    policy = policy or QualityPolicy()

    photo_index: list[int] = []
    embeddings: list[np.ndarray] = []
    face_px: list[int] = []
    det_score: list[float] = []
    yaw: list[float] = []
    blur: list[float] = []
    tier: list[int] = []
    gate = GateStats()

    for i, photo in enumerate(dataset.photos):
        if progress and i % 25 == 0:
            print(f"    indexing {i}/{len(dataset.photos)}", flush=True)
        faces, stats = engine.detect_and_embed(_load_rgb(photo.path), policy=policy)
        gate = gate.merged(stats)
        for face in faces:
            photo_index.append(i)
            embeddings.append(face.embedding)
            face_px.append(face.detection.face_px)
            det_score.append(float(face.detection.det_score))
            yaw.append(float("nan") if face.detection.pose.yaw is None else face.detection.pose.yaw)
            blur.append(
                float("nan") if face.quality.blur_score is None else face.quality.blur_score
            )
            tier.append(face.quality.tier)

    # Enrollment mirrors the production path exactly: average the normalized
    # embeddings of every selfie frame, then renormalize. Evaluating against a
    # single-frame template would measure a system we do not ship.
    queries: dict[str, np.ndarray] = {}
    failures: dict[str, str] = {}
    for person in dataset.people:
        frames: list[np.ndarray] = []
        reasons: list[str] = []
        for path in person.selfie_paths:
            try:
                faces, _ = engine.detect_and_embed(_load_rgb(path), policy=policy)
            except (OSError, ValueError) as exc:
                reasons.append(f"{path.name}: {exc}")
                continue
            if len(faces) != 1:
                reasons.append(f"{path.name}: found {len(faces)} usable faces, expected 1")
                continue
            frames.append(faces[0].embedding)

        if frames:
            queries[person.person_id] = average_embeddings(frames)
            if reasons:
                # Partial enrollment is worth knowing about but is not a failure:
                # production would do the same thing with the frames it got.
                failures[person.person_id + " (partial)"] = "; ".join(reasons)
        else:
            failures[person.person_id] = "; ".join(reasons) or "no usable selfie"

    if not queries:
        raise EnrollmentError(
            "no person could be enrolled from their selfies; "
            f"reasons: {failures}"
        )

    return FaceIndex(
        photo_index=np.asarray(photo_index, dtype=np.int32),
        embeddings=(
            np.stack(embeddings).astype(np.float32)
            if embeddings
            else np.zeros((0, 512), dtype=np.float32)
        ),
        face_px=np.asarray(face_px, dtype=np.int32),
        det_score=np.asarray(det_score, dtype=np.float32),
        yaw=np.asarray(yaw, dtype=np.float32),
        blur=np.asarray(blur, dtype=np.float32),
        tier=np.asarray(tier, dtype=np.int8),
        photo_ids=dataset.photo_ids,
        engine_name=engine.name,
        gate=gate,
        queries=queries,
        enrollment_failures=failures,
    )


def build_or_load_index(
    dataset: LabeledDataset,
    engine: FaceEngine,
    *,
    policy: QualityPolicy | None = None,
    use_cache: bool = True,
    progress: bool = True,
) -> tuple[FaceIndex, bool]:
    """Returns (index, came_from_cache)."""
    policy = policy or QualityPolicy()
    path = CACHE_DIR / f"{dataset.dataset_id}-{cache_key(dataset, engine, policy)}.npz"

    if use_cache and path.exists():
        return FaceIndex.load(path), True

    index = build_index(dataset, engine, policy=policy, progress=progress)
    if use_cache:
        index.save(path)
    return index, False
