"""The tier table, pinned.

These are boundary tests rather than example tests, because the interesting
failures in a gate like this are all off-by-one: `>=` where the spec says `>`,
a rejection that should have been a demotion, blur measured on a face that was
already thrown away.
"""

from __future__ import annotations

import numpy as np
import pytest

from faceapp_ml.quality import (
    GateStats,
    QualityPolicy,
    assess,
    blur_score,
    estimate_pose_from_landmarks,
)
from faceapp_ml.types import BBox, Detection, Pose, QualityAssessment

POLICY = QualityPolicy()


def det(*, px: float = 100, score: float = 0.9, yaw: float | None = 0.0) -> Detection:
    return Detection(
        bbox=BBox(0, 0, px, px),
        det_score=score,
        pose=Pose(yaw=yaw),
    )


# ---------------------------------------------------------------------------
# Tier 0 — rejection
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("px", "expected"),
    [(39, 0), (40, 1), (41, 1)],
)
def test_face_size_rejection_boundary(px: int, expected: int) -> None:
    """`face_px < 40` rejects. 40 exactly is kept."""
    assert assess(det(px=px, score=0.6), policy=POLICY).tier == expected


@pytest.mark.parametrize(
    ("score", "expected"),
    [(0.49, 0), (0.50, 1), (0.51, 1)],
)
def test_det_score_rejection_boundary(score: float, expected: int) -> None:
    """`det_score < 0.5` rejects. 0.50 exactly is kept."""
    assert assess(det(px=50, score=score), policy=POLICY).tier == expected


def test_rejection_records_every_reason() -> None:
    a = assess(det(px=20, score=0.2), policy=POLICY)
    assert a.tier == 0
    assert a.rejected
    assert len(a.reasons) == 2, a.reasons
    assert any("face_px" in r for r in a.reasons)
    assert any("det_score" in r for r in a.reasons)


def test_rejected_faces_are_not_blur_analysed() -> None:
    """No point measuring a crop we have already discarded.

    On a 100k-photo album most detections are rejected, so this is also where a
    meaningful amount of ingestion work does not happen.
    """
    image = np.zeros((200, 200, 3), dtype=np.uint8)
    a = assess(det(px=20, score=0.2), policy=POLICY, image=image)
    assert a.tier == 0
    assert a.blur_score is None


# ---------------------------------------------------------------------------
# Tier 2 — promotion
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("px", "expected"),
    [(70, 1), (71, 2)],
)
def test_face_size_promotion_boundary(px: int, expected: int) -> None:
    """`face_px > 70` promotes, so 70 exactly stays weak.

    The spec's bands are "40-70" for tier 1 and "> 70" for tier 2, which leaves
    70 ambiguous. It is resolved downward on purpose: a borderline face belongs
    in the bucket a person looks at, not the one that gets delivered.
    """
    assert assess(det(px=px, score=0.9), policy=POLICY).tier == expected


@pytest.mark.parametrize(
    ("score", "expected"),
    [(0.70, 1), (0.71, 2)],
)
def test_det_score_promotion_boundary(score: float, expected: int) -> None:
    assert assess(det(px=100, score=score), policy=POLICY).tier == expected


@pytest.mark.parametrize(
    ("yaw", "expected"),
    [(39.9, 2), (40.0, 1), (40.1, 1), (-39.9, 2), (-40.0, 1)],
)
def test_yaw_boundary_is_symmetric(yaw: float, expected: int) -> None:
    assert assess(det(yaw=yaw), policy=POLICY).tier == expected


def test_unknown_yaw_does_not_demote() -> None:
    """An engine that cannot supply pose must not silently halve the confident set."""
    assert assess(det(yaw=None), policy=POLICY).tier == 2


def test_tier2_needs_every_condition() -> None:
    assert assess(det(px=100, score=0.9, yaw=0), policy=POLICY).tier == 2
    assert assess(det(px=60, score=0.9, yaw=0), policy=POLICY).tier == 1
    assert assess(det(px=100, score=0.6, yaw=0), policy=POLICY).tier == 1
    assert assess(det(px=100, score=0.9, yaw=55), policy=POLICY).tier == 1


# ---------------------------------------------------------------------------
# Blur
# ---------------------------------------------------------------------------


def test_blur_demotes_but_never_rejects() -> None:
    """Getting the blur threshold wrong must cost recall, not precision.

    It is the one quality constant with no principled default, so it is wired to
    fail in the safe direction.
    """
    sharp = assess(det(), policy=POLICY, blur=500.0)
    blurred = assess(det(), policy=POLICY, blur=1.0)
    assert sharp.tier == 2
    assert blurred.tier == 1
    assert not blurred.rejected


def test_blur_criterion_can_be_switched_off() -> None:
    policy = QualityPolicy(min_blur_score=None)
    assert assess(det(), policy=policy, blur=0.0).tier == 2


def test_blur_score_ranks_sharp_above_smooth() -> None:
    rng = np.random.default_rng(0)
    noisy = rng.integers(0, 255, size=(200, 200, 3), dtype=np.uint8)
    flat = np.full((200, 200, 3), 128, dtype=np.uint8)
    box = BBox(20, 20, 120, 120)
    assert blur_score(noisy, box) > blur_score(flat, box)


def test_blur_score_is_resolution_normalised() -> None:
    """A sharp face at 400px and the same face at 100px should score comparably.

    Laplacian variance scales with resolution, so without the fixed-size
    resample a single threshold could not separate sharp from blurred at both
    ends of an album.
    """
    from PIL import Image as PILImage

    rng = np.random.default_rng(1)
    base = rng.integers(0, 255, size=(64, 64), dtype=np.uint8)
    big = np.asarray(PILImage.fromarray(base).resize((400, 400), PILImage.BICUBIC))
    small = np.asarray(PILImage.fromarray(base).resize((100, 100), PILImage.BICUBIC))

    big_rgb = np.stack([big] * 3, axis=-1)
    small_rgb = np.stack([small] * 3, axis=-1)

    b = blur_score(big_rgb, BBox(0, 0, 400, 400))
    s = blur_score(small_rgb, BBox(0, 0, 100, 100))
    assert 0.4 < b / s < 2.5, f"scores diverged with resolution: {b:.1f} vs {s:.1f}"


def test_blur_score_survives_a_box_off_the_edge() -> None:
    image = np.zeros((100, 100, 3), dtype=np.uint8)
    assert blur_score(image, BBox(90, 90, 200, 200)) >= 0.0


# ---------------------------------------------------------------------------
# Pose approximation
# ---------------------------------------------------------------------------


def _landmarks(nose_x: float, *, tilt: float = 0.0) -> np.ndarray:
    # left eye, right eye, nose, mouth left, mouth right
    return np.array(
        [[40.0, 50.0], [80.0, 50.0 + tilt], [nose_x, 70.0], [50.0, 90.0], [75.0, 90.0]],
        dtype=np.float32,
    )


def test_frontal_face_reads_as_zero_yaw() -> None:
    pose = estimate_pose_from_landmarks(_landmarks(nose_x=60.0))
    assert pose.yaw == pytest.approx(0.0, abs=1e-4)


def test_yaw_sign_follows_the_nose() -> None:
    left = estimate_pose_from_landmarks(_landmarks(nose_x=45.0))
    right = estimate_pose_from_landmarks(_landmarks(nose_x=75.0))
    assert left.yaw is not None and right.yaw is not None
    assert left.yaw < 0 < right.yaw


def test_roll_comes_from_the_eye_line() -> None:
    pose = estimate_pose_from_landmarks(_landmarks(nose_x=60.0, tilt=40.0))
    assert pose.roll == pytest.approx(45.0, abs=1.0)


def test_pitch_is_not_invented_from_five_points() -> None:
    """Five points do not determine pitch. None beats a number nobody should trust."""
    assert estimate_pose_from_landmarks(_landmarks(nose_x=60.0)).pitch is None


def test_landmarks_must_be_five_points() -> None:
    with pytest.raises(ValueError, match="5 landmarks"):
        estimate_pose_from_landmarks(np.zeros((3, 2), dtype=np.float32))


# ---------------------------------------------------------------------------
# Policy loading and gate accounting
# ---------------------------------------------------------------------------


def test_policy_loads_from_the_shipped_config() -> None:
    policy = QualityPolicy.load()
    assert policy.min_face_px == 40
    assert policy.min_det_score == 0.5
    assert policy.good_face_px == 70
    assert policy.max_yaw_deg == 40.0


def test_policy_rejects_a_misspelled_setting(tmp_path) -> None:
    """A typo in the config must not silently leave the gate at its defaults."""
    path = tmp_path / "quality.toml"
    path.write_text("[quality]\nmin_face_pixels = 40\n")
    with pytest.raises(ValueError, match="unknown quality settings"):
        QualityPolicy.load(path)


def test_gate_stats_warn_above_sixty_percent_rejection() -> None:
    assessments = [QualityAssessment(tier=0, blur_score=None)] * 61 + [
        QualityAssessment(tier=2, blur_score=100.0)
    ] * 39
    stats = GateStats.of(assessments)
    assert stats.detected == 100
    assert stats.rejected == 61
    assert stats.warns()

    ok = GateStats.of(
        [QualityAssessment(tier=0, blur_score=None)] * 59
        + [QualityAssessment(tier=2, blur_score=100.0)] * 41
    )
    assert not ok.warns()


def test_gate_stats_of_nothing_does_not_warn() -> None:
    stats = GateStats.of([])
    assert stats.rejection_rate == 0.0
    assert not stats.warns()
