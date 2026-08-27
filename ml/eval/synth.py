"""A synthetic album, for testing the harness rather than the model.

**This does not tell you where to set a threshold.** It generates embeddings
from a statistical model of what ArcFace embeddings look like — identity
directions, quality-dependent scatter around them, a shared component so that
different people are not perfectly orthogonal. It knows nothing about backlight,
motion blur, sunglasses, face paint or a face turned 60 degrees away, which is
where the real numbers come from and where the product is actually decided.

What it is good for:

  * proving the sweep arithmetic is right, against ground truth we constructed
    and therefore know exactly;
  * letting CI run the whole pipeline on every commit without shipping a real
    event album into a git repository;
  * exercising the failure paths — a threshold that never reaches target
    precision, an unreachable appearance, a person who cannot be enrolled.

`faceapp_ml.config.load_thresholds` refuses thresholds whose provenance says
`dataset_kind = "synthetic"`, and that refusal is the point of the distinction.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from faceapp_ml.embeddings import average_embeddings, l2_normalize
from faceapp_ml.quality import GateStats

from .dataset import LabeledDataset, PersonSpec, PhotoSpec
from .faceindex import FaceIndex


@dataclass(frozen=True, slots=True)
class SynthConfig:
    n_photos: int = 400
    n_identities: int = 60
    n_query_people: int = 20
    n_selfie_frames: int = 3
    seed: int = 20260827

    # Faces per photograph. Skewed low, with a tail for crowd shots.
    min_faces: int = 1
    max_faces: int = 9

    # How much of every face embedding is a component shared by all faces. Real
    # ArcFace embeddings of different people sit around 0.0–0.2 cosine rather
    # than at the ~0.00 you would get from random 512-d unit vectors; this
    # reproduces that.
    common_component: float = 0.22

    # A handful of identity pairs made deliberately similar — siblings, or just
    # people who look alike. Without them precision is 1.000 at every threshold
    # and the selection logic never has to do anything.
    n_lookalike_pairs: int = 6
    lookalike_similarity: float = 0.62

    # Similarity between a face embedding and its identity direction, as a
    # function of simulated capture quality (0 = worst indexed, 1 = studio).
    fidelity_floor: float = 0.38
    fidelity_range: float = 0.55

    # Selfies are captured deliberately, so they sit close to the identity.
    selfie_fidelity: float = 0.90

    # Fraction of appearances where the face is too poor to be indexed at all:
    # rejected by the gate, or never detected. Sets the recall ceiling.
    unindexable_rate: float = 0.12


def _perturb(rng: np.random.Generator, identity: np.ndarray, fidelity: float) -> np.ndarray:
    """A vector at exactly `fidelity` cosine from `identity`.

    Built as `f * identity + sqrt(1 - f^2) * orthogonal_noise`, so the resulting
    cosine is the fidelity by construction rather than approximately.
    """
    noise = rng.normal(size=identity.shape).astype(np.float32)
    noise -= identity * float(np.dot(noise, identity))  # project out the identity direction
    noise = l2_normalize(noise)
    f = float(np.clip(fidelity, -1.0, 1.0))
    return l2_normalize(f * identity + np.sqrt(max(0.0, 1.0 - f * f)) * noise)


def generate(config: SynthConfig | None = None) -> tuple[LabeledDataset, FaceIndex]:
    cfg = config or SynthConfig()
    rng = np.random.default_rng(cfg.seed)
    dim = 512

    # --- identities -------------------------------------------------------
    common = l2_normalize(rng.normal(size=dim).astype(np.float32))
    identities = np.stack(
        [
            l2_normalize(
                cfg.common_component * common
                + (1 - cfg.common_component) * l2_normalize(rng.normal(size=dim).astype(np.float32))
            )
            for _ in range(cfg.n_identities)
        ]
    )

    # Look-alikes: pull the second of each pair toward the first.
    for k in range(min(cfg.n_lookalike_pairs, cfg.n_identities // 2)):
        a, b = 2 * k, 2 * k + 1
        identities[b] = _perturb(rng, identities[a], cfg.lookalike_similarity)

    query_ids = [f"person-{i:02d}" for i in range(cfg.n_query_people)]

    # --- photographs ------------------------------------------------------
    photos: list[PhotoSpec] = []
    truth: dict[str, set[str]] = {p: set() for p in query_ids}

    photo_index: list[int] = []
    embeddings: list[np.ndarray] = []
    face_px: list[int] = []
    det_score: list[float] = []
    yaw: list[float] = []
    blur: list[float] = []
    tier: list[int] = []

    detected = rejected = 0

    for i in range(cfg.n_photos):
        photo_id = f"photo-{i:04d}"
        lighting = str(
            rng.choice(["daylight", "indoor", "backlit", "night"], p=[0.4, 0.3, 0.2, 0.1])
        )
        photos.append(
            PhotoSpec(
                photo_id=photo_id,
                path=Path(f"synthetic/{photo_id}.jpg"),
                lighting=lighting,
            )
        )

        n_faces = int(rng.integers(cfg.min_faces, cfg.max_faces + 1))
        present = rng.choice(cfg.n_identities, size=n_faces, replace=False)

        for identity_idx in present:
            detected += 1

            # Capture quality. Crowd shots are mostly small faces.
            quality = float(np.clip(rng.beta(2.0, 2.2), 0.0, 1.0))
            px = int(20 + quality * 220 + rng.normal(0, 12))
            # Detection confidence is only weakly coupled to size. SCRFD returns
            # 0.88-0.92 for ordinary 95-110px faces, so a model where det_score
            # tracks face size closely makes almost everything tier 1 and
            # produces a confident-set recall far below what the real detector
            # gives. Measured on a six-face 1280x886 photograph.
            score = float(np.clip(0.45 + quality * 0.55 + rng.normal(0, 0.06), 0.0, 1.0))
            face_yaw = float(np.clip(rng.normal(0, 18) * (1.3 - 0.5 * quality), -85, 85))
            face_blur = float(max(0.0, 20 + quality * 160 + rng.normal(0, 25)))

            is_query = identity_idx < cfg.n_query_people
            person_id = f"person-{identity_idx:02d}" if is_query else None

            # Ground truth records that the person was in the photograph. That is
            # true whether or not we manage to index their face — which is
            # exactly what makes the recall ceiling measurable.
            if person_id is not None:
                truth[person_id].add(photo_id)

            # The gate, simulated. Faces below it are never embedded and never
            # reach the index, mirroring detect_and_embed.
            unindexable = px < 40 or score < 0.5 or rng.random() < cfg.unindexable_rate
            if unindexable:
                rejected += 1
                continue

            fidelity = cfg.fidelity_floor + cfg.fidelity_range * quality
            embeddings.append(_perturb(rng, identities[identity_idx], fidelity))
            photo_index.append(i)
            face_px.append(px)
            det_score.append(score)
            yaw.append(face_yaw)
            blur.append(face_blur)
            tier.append(2 if (px > 70 and score > 0.7 and abs(face_yaw) < 40) else 1)

    # --- enrollment -------------------------------------------------------
    people: list[PersonSpec] = []
    queries: dict[str, np.ndarray] = {}
    for idx, person_id in enumerate(query_ids):
        frames = [
            _perturb(rng, identities[idx], cfg.selfie_fidelity + rng.normal(0, 0.02))
            for _ in range(cfg.n_selfie_frames)
        ]
        queries[person_id] = average_embeddings(frames)
        people.append(
            PersonSpec(
                person_id=person_id,
                selfie_paths=tuple(
                    Path(f"synthetic/selfies/{person_id}-{k}.jpg")
                    for k in range(cfg.n_selfie_frames)
                ),
            )
        )

    tier_arr = np.asarray(tier, dtype=np.int8)
    dataset = LabeledDataset(
        dataset_id=f"synthetic-{cfg.seed}",
        kind="synthetic",
        root=Path("synthetic"),
        photos=photos,
        people=people,
        truth={k: v for k, v in truth.items()},
        description="Generated by eval.synth. Proves the harness, not the model.",
    )

    index = FaceIndex(
        photo_index=np.asarray(photo_index, dtype=np.int32),
        embeddings=np.stack(embeddings).astype(np.float32),
        face_px=np.asarray(face_px, dtype=np.int32),
        det_score=np.asarray(det_score, dtype=np.float32),
        yaw=np.asarray(yaw, dtype=np.float32),
        blur=np.asarray(blur, dtype=np.float32),
        tier=tier_arr,
        photo_ids=dataset.photo_ids,
        engine_name="synthetic",
        gate=GateStats(
            detected=detected,
            rejected=rejected,
            tier1=int(np.count_nonzero(tier_arr == 1)),
            tier2=int(np.count_nonzero(tier_arr == 2)),
        ),
        queries=queries,
        enrollment_failures={},
    )

    return dataset, index
