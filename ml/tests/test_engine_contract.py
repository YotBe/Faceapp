"""The ordering guarantees in `FaceEngine.detect_and_embed`.

The sequence — detect, reject cheaply, then pose, then grade, then embed — is a
compliance property, not an optimisation. A face too small or too uncertain to
match must never be turned into a biometric template at all. These tests assert
that by counting calls, because the only way to know a template was not computed
is to check that nothing computed one.
"""

from __future__ import annotations

import numpy as np
import pytest

from faceapp_ml.engine import EnrollmentError, ScriptedEngine, ScriptedFace
from faceapp_ml.engine.scripted import deterministic_embedding
from faceapp_ml.quality import QualityPolicy
from faceapp_ml.types import BBox, Detection, Face, Pose, QualityAssessment

POLICY = QualityPolicy()

# Textured rather than flat. A blank image scores as maximally blurred and every
# face in it is demoted to tier 1 — correct behaviour, but it would mean these
# ordering tests never exercised the tier-2 path at all.
IMAGE = np.random.default_rng(1234).integers(0, 255, size=(480, 640, 3), dtype=np.uint8)


def face(*, px: float, score: float, seed: int, x: float = 0.0, yaw: float = 0.0) -> ScriptedFace:
    return ScriptedFace(
        detection=Detection(
            bbox=BBox(x, 0, px, px), det_score=score, pose=Pose(yaw=yaw)
        ),
        embedding=deterministic_embedding(seed),
    )


def test_a_rejected_face_is_never_embedded() -> None:
    engine = ScriptedEngine(
        frames=[
            [
                face(px=25, score=0.9, seed=1, x=0),  # too small
                face(px=100, score=0.2, seed=2, x=200),  # too uncertain
                face(px=120, score=0.9, seed=3, x=400),  # keeper
            ]
        ]
    )

    faces, stats = engine.detect_and_embed(IMAGE, policy=POLICY)

    assert len(faces) == 1
    assert engine.embed_calls == 1, "a rejected detection reached the embedding model"
    assert stats.detected == 3
    assert stats.rejected == 2
    assert stats.tier2 == 1


def test_pose_is_not_estimated_for_a_rejected_face() -> None:
    """Pose costs a model call per face. Rejection happens before it."""
    engine = ScriptedEngine(
        frames=[[face(px=25, score=0.9, seed=1), face(px=120, score=0.9, seed=2, x=300)]]
    )
    engine.detect_and_embed(IMAGE, policy=POLICY)
    assert engine.pose_calls == 1


def test_gate_statistics_account_for_every_detection() -> None:
    engine = ScriptedEngine(
        frames=[
            [
                face(px=20, score=0.9, seed=1, x=0),
                face(px=50, score=0.6, seed=2, x=100),  # tier 1: small
                face(px=200, score=0.95, seed=3, x=300),  # tier 2
            ]
        ]
    )
    _, stats = engine.detect_and_embed(IMAGE, policy=POLICY)
    assert stats.detected == stats.rejected + stats.tier1 + stats.tier2 == 3


def test_a_photo_with_no_faces_is_not_an_error() -> None:
    engine = ScriptedEngine(frames=[[]])
    faces, stats = engine.detect_and_embed(IMAGE, policy=POLICY)
    assert faces == []
    assert stats.detected == 0


def test_face_type_refuses_to_hold_a_rejected_detection() -> None:
    """Belt and braces with the database CHECK on quality_tier.

    Both places state the same invariant because both are cheap and the
    invariant is the difference between indexing a face and discarding it.
    """
    with pytest.raises(ValueError, match="never be embedded or stored"):
        Face(
            detection=Detection(bbox=BBox(0, 0, 20, 20), det_score=0.2),
            embedding=deterministic_embedding(1),
            quality=QualityAssessment(tier=0, blur_score=None),
        )


def test_face_type_refuses_a_wrong_sized_embedding() -> None:
    with pytest.raises(ValueError, match="512-d embedding"):
        Face(
            detection=Detection(bbox=BBox(0, 0, 100, 100), det_score=0.9),
            embedding=np.zeros(128, dtype=np.float32),
            quality=QualityAssessment(tier=2, blur_score=100.0),
        )


def test_row_payload_carries_no_landmarks_or_crop() -> None:
    """What we persist is the shortest list that supports matching and ranking."""
    f = Face(
        detection=Detection(
            bbox=BBox(1, 2, 100, 110),
            det_score=0.9,
            landmarks=np.zeros((5, 2), dtype=np.float32),
            pose=Pose(yaw=3.0, pitch=1.0, roll=-2.0),
        ),
        embedding=deterministic_embedding(1),
        quality=QualityAssessment(tier=2, blur_score=88.0),
    )
    row = f.to_row(photo_id="p", event_id="e")

    assert set(row) == {
        "photo_id",
        "event_id",
        "embedding",
        "bbox",
        "det_score",
        "face_px",
        "yaw",
        "pitch",
        "roll",
        "blur_score",
        "quality_tier",
    }
    assert "landmarks" not in row
    assert row["face_px"] == 100  # min(w, h), not max


# ---------------------------------------------------------------------------
# Enrollment
# ---------------------------------------------------------------------------


def test_enrollment_averages_every_frame() -> None:
    engine = ScriptedEngine(
        frames=[
            [face(px=200, score=0.95, seed=10)],
            [face(px=200, score=0.95, seed=11)],
            [face(px=200, score=0.95, seed=12)],
        ]
    )
    template = engine.enroll([IMAGE, IMAGE, IMAGE], policy=POLICY)

    assert template.shape == (512,)
    assert np.linalg.norm(template) == pytest.approx(1.0, abs=1e-5)
    assert engine.detect_calls == 3

    from faceapp_ml.embeddings import average_embeddings

    expected = average_embeddings(
        [deterministic_embedding(10), deterministic_embedding(11), deterministic_embedding(12)]
    )
    np.testing.assert_allclose(template, expected, atol=1e-6)


def test_enrollment_rejects_a_frame_with_no_usable_face() -> None:
    """Better to say "move closer" than to run the search and return nothing.

    A silent zero-result search is read by users as the product being broken.
    """
    engine = ScriptedEngine(frames=[[face(px=200, score=0.95, seed=1)], []])
    with pytest.raises(EnrollmentError, match="frame 1: no usable face"):
        engine.enroll([IMAGE, IMAGE], policy=POLICY)


def test_enrollment_rejects_a_frame_with_two_faces() -> None:
    """Picking the largest would occasionally enroll whoever is standing behind."""
    engine = ScriptedEngine(
        frames=[[face(px=200, score=0.95, seed=1, x=0), face(px=180, score=0.95, seed=2, x=300)]]
    )
    with pytest.raises(EnrollmentError, match="2 faces found"):
        engine.enroll([IMAGE], policy=POLICY)


def test_enrollment_rejects_an_empty_capture() -> None:
    with pytest.raises(ValueError, match="no frames"):
        ScriptedEngine(frames=[]).enroll([], policy=POLICY)
