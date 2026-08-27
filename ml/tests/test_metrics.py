"""The sweep arithmetic, checked against numbers worked out by hand.

If this module is wrong, every threshold derived from it is wrong, and the
failure is invisible — the report still prints a plausible table. So the
fixtures here are small enough to verify on paper.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from eval.dataset import LabeledDataset, PersonSpec, PhotoSpec
from eval.faceindex import FaceIndex
from eval.metrics import (
    ThresholdNotReachable,
    default_grid,
    pick_t_high,
    pick_t_low,
    score_pairs,
    sweep,
    unreachable_rate,
)
from faceapp_ml.embeddings import l2_normalize
from faceapp_ml.quality import GateStats

DIM = 512


def unit(i: int) -> np.ndarray:
    """A basis vector, so similarities are exactly the coefficients we choose."""
    v = np.zeros(DIM, dtype=np.float32)
    v[i] = 1.0
    return v


def mixture(base: int, weight: float) -> np.ndarray:
    """A vector whose cosine with `unit(base)` is exactly `weight`."""
    other = np.zeros(DIM, dtype=np.float32)
    other[base] = weight
    other[base + 100] = float(np.sqrt(max(0.0, 1.0 - weight * weight)))
    return l2_normalize(other)


def make_index(
    faces: list[tuple[int, np.ndarray, int]],  # (photo_row, embedding, tier)
    photo_ids: list[str],
    queries: dict[str, np.ndarray],
) -> FaceIndex:
    return FaceIndex(
        photo_index=np.asarray([f[0] for f in faces], dtype=np.int32),
        embeddings=np.stack([f[1] for f in faces]).astype(np.float32),
        face_px=np.asarray([100] * len(faces), dtype=np.int32),
        det_score=np.asarray([0.9] * len(faces), dtype=np.float32),
        yaw=np.asarray([0.0] * len(faces), dtype=np.float32),
        blur=np.asarray([100.0] * len(faces), dtype=np.float32),
        tier=np.asarray([f[2] for f in faces], dtype=np.int8),
        photo_ids=photo_ids,
        engine_name="test",
        gate=GateStats(detected=len(faces), rejected=0, tier1=0, tier2=len(faces)),
        queries=queries,
        enrollment_failures={},
    )


def make_dataset(photo_ids: list[str], truth: dict[str, set[str]]) -> LabeledDataset:
    return LabeledDataset(
        dataset_id="unit",
        kind="synthetic",
        root=Path("."),
        photos=[PhotoSpec(photo_id=p, path=Path(p)) for p in photo_ids],
        people=[PersonSpec(person_id=k, selfie_paths=()) for k in truth],
        truth=truth,
    )


# ---------------------------------------------------------------------------
# Grouping
# ---------------------------------------------------------------------------


def test_a_photo_scores_as_its_best_face() -> None:
    """Grouping is by photograph, not by face.

    The attendee sees a grid of photographs, so one good match in a photo full
    of strangers means that photo is theirs.
    """
    photo_ids = ["p0"]
    faces = [
        (0, mixture(0, 0.20), 2),
        (0, mixture(0, 0.81), 2),
        (0, mixture(0, 0.45), 2),
    ]
    index = make_index(faces, photo_ids, {"alice": unit(0)})
    pairs = score_pairs(index, make_dataset(photo_ids, {"alice": {"p0"}}))

    assert pairs.scores[0, 0] == pytest.approx(0.81, abs=1e-4)
    assert pairs.best_face[0, 0] == 1


def test_a_photo_with_no_qualifying_face_can_never_be_returned() -> None:
    photo_ids = ["p0", "p1"]
    faces = [(0, mixture(0, 0.9), 2)]
    index = make_index(faces, photo_ids, {"alice": unit(0)})
    pairs = score_pairs(index, make_dataset(photo_ids, {"alice": {"p0", "p1"}}))

    assert pairs.scores[0, 1] == -np.inf
    assert pairs.best_face[0, 1] == -1
    assert not (pairs.scores[0, 1] >= 0.0)


def test_tier_filtering_excludes_weak_faces_from_the_confident_set() -> None:
    """`T_high` must be chosen on the population it will actually be applied to."""
    photo_ids = ["p0"]
    faces = [(0, mixture(0, 0.90), 1), (0, mixture(0, 0.50), 2)]
    index = make_index(faces, photo_ids, {"alice": unit(0)})
    dataset = make_dataset(photo_ids, {"alice": {"p0"}})

    assert score_pairs(index, dataset, tiers=(1, 2)).scores[0, 0] == pytest.approx(0.90, abs=1e-4)
    assert score_pairs(index, dataset, tiers=(2,)).scores[0, 0] == pytest.approx(0.50, abs=1e-4)


# ---------------------------------------------------------------------------
# Sweep arithmetic
# ---------------------------------------------------------------------------


def test_sweep_matches_hand_computed_counts() -> None:
    """Four photos, one person. Truth: p0 and p1 are hers.

        p0  0.80  true positive above 0.50
        p1  0.40  hers, but scores low
        p2  0.60  not hers -> false positive above 0.50
        p3  0.10  not hers

    At t = 0.50: predicted {p0, p2}. tp=1, fp=1, fn=1.
        precision 0.5, recall 0.5, F1 0.5
    At t = 0.70: predicted {p0}.     tp=1, fp=0, fn=1.
        precision 1.0, recall 0.5, F1 0.666...
    At t = 0.30: predicted {p0, p1, p2} — p3 at 0.10 is still below.
        tp=2, fp=1, fn=0. precision 2/3, recall 1.0.
    """
    photo_ids = ["p0", "p1", "p2", "p3"]
    faces = [
        (0, mixture(0, 0.80), 2),
        (1, mixture(0, 0.40), 2),
        (2, mixture(0, 0.60), 2),
        (3, mixture(0, 0.10), 2),
    ]
    index = make_index(faces, photo_ids, {"alice": unit(0)})
    dataset = make_dataset(photo_ids, {"alice": {"p0", "p1"}})
    pairs = score_pairs(index, dataset)

    rows = {round(r.threshold, 2): r for r in sweep(pairs, np.array([0.30, 0.50, 0.70]))}

    r50 = rows[0.50]
    assert (r50.n_tp, r50.n_fp, r50.n_fn) == (1, 1, 1)
    assert r50.precision == pytest.approx(0.5)
    assert r50.recall == pytest.approx(0.5)
    assert r50.f1 == pytest.approx(0.5)

    r70 = rows[0.70]
    assert (r70.n_tp, r70.n_fp, r70.n_fn) == (1, 0, 1)
    assert r70.precision == pytest.approx(1.0)
    assert r70.recall == pytest.approx(0.5)
    assert r70.f1 == pytest.approx(2 / 3)

    r30 = rows[0.30]
    assert (r30.n_tp, r30.n_fp, r30.n_fn) == (2, 1, 0)
    assert r30.precision == pytest.approx(2 / 3)
    assert r30.recall == pytest.approx(1.0)


def test_recall_never_increases_with_the_threshold() -> None:
    """A monotonicity check, so a regression in the sweep shows up as nonsense."""
    rng = np.random.default_rng(5)
    photo_ids = [f"p{i}" for i in range(40)]
    faces = [(i, l2_normalize(rng.normal(size=DIM)), 2) for i in range(40)]
    index = make_index(faces, photo_ids, {"alice": l2_normalize(rng.normal(size=DIM))})
    dataset = make_dataset(photo_ids, {"alice": set(photo_ids[:20])})

    rows = sweep(score_pairs(index, dataset), default_grid(0.0, 1.0, 0.05))
    recalls = [r.recall for r in rows]
    assert recalls == sorted(recalls, reverse=True)


def test_precision_of_an_empty_prediction_set_is_one_not_zero() -> None:
    """Predicting nothing is vacuously precise, and must not read as a failure.

    Scoring it as 0 would make `pick_t_high` choose an absurdly low threshold to
    escape a phantom precision collapse at the top of the range.
    """
    photo_ids = ["p0"]
    index = make_index([(0, mixture(0, 0.10), 2)], photo_ids, {"alice": unit(0)})
    rows = sweep(score_pairs(index, make_dataset(photo_ids, {"alice": {"p0"}})), np.array([0.9]))
    assert rows[0].precision == 1.0
    assert rows[0].recall == 0.0


def test_default_grid_is_the_spec_sweep() -> None:
    grid = default_grid()
    assert grid[0] == pytest.approx(0.30)
    assert grid[-1] == pytest.approx(0.60)
    assert len(grid) == 31


# ---------------------------------------------------------------------------
# Recall ceiling
# ---------------------------------------------------------------------------


def test_unreachable_rate_counts_appearances_nothing_scored() -> None:
    """Separates "threshold too strict" from "we never saw the face"."""
    photo_ids = ["p0", "p1", "p2", "p3"]
    faces = [
        (0, mixture(0, 0.80), 2),  # found
        (1, mixture(0, 0.42), 2),  # indexed but below a strict threshold
        (2, mixture(0, 0.05), 2),  # a stranger; her face was never indexed
        # p3 has no faces at all
    ]
    index = make_index(faces, photo_ids, {"alice": unit(0)})
    dataset = make_dataset(photo_ids, {"alice": {"p0", "p1", "p2", "p3"}})

    # p2 and p3 are unreachable; p0 and p1 are a tuning question.
    assert unreachable_rate(score_pairs(index, dataset)) == pytest.approx(0.5)


def test_unreachable_rate_is_zero_when_there_is_nothing_to_find() -> None:
    photo_ids = ["p0"]
    index = make_index([(0, mixture(0, 0.9), 2)], photo_ids, {"alice": unit(0)})
    assert unreachable_rate(score_pairs(index, make_dataset(photo_ids, {"alice": set()}))) == 0.0


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------


def rows_from(spec: list[tuple[float, float, float]]) -> list:
    from eval.metrics import SweepRow

    return [
        SweepRow(threshold=t, precision=p, recall=r, f1=0.0, n_tp=0, n_fp=0, n_fn=0)
        for t, p, r in spec
    ]


def test_t_high_is_the_lowest_threshold_meeting_the_precision_floor() -> None:
    """Lowest, not highest: every step beyond it only discards true positives."""
    rows = rows_from(
        [(0.40, 0.95, 0.90), (0.45, 0.985, 0.85), (0.47, 0.991, 0.80), (0.50, 0.999, 0.70)]
    )
    assert pick_t_high(rows, target_precision=0.99).threshold == pytest.approx(0.47)


def test_t_high_refuses_rather_than_settling_for_less() -> None:
    """The whole product rests on this number. There is no acceptable fallback."""
    rows = rows_from([(0.40, 0.90, 0.9), (0.50, 0.95, 0.7), (0.60, 0.97, 0.5)])
    with pytest.raises(ThresholdNotReachable, match=r"0\.9700"):
        pick_t_high(rows, target_precision=0.99)


def test_t_low_is_the_highest_threshold_still_meeting_the_recall_target() -> None:
    """Within the recall requirement, take the fewest false positives available."""
    rows = rows_from(
        [(0.30, 0.60, 0.99), (0.35, 0.70, 0.97), (0.38, 0.75, 0.95), (0.42, 0.80, 0.90)]
    )
    assert pick_t_low(rows, target_recall=0.95, ceiling=0.60).threshold == pytest.approx(0.38)


def test_t_low_is_capped_at_t_high() -> None:
    """A "maybe" threshold above the confident one would be incoherent."""
    rows = rows_from([(0.30, 0.6, 0.99), (0.40, 0.7, 0.97), (0.50, 0.8, 0.96)])
    assert pick_t_low(rows, target_recall=0.95, ceiling=0.40).threshold == pytest.approx(0.40)


def test_t_low_falls_back_when_recall_is_never_reached() -> None:
    """Usually means the ceiling is set by detection, not by the threshold."""
    rows = rows_from([(0.30, 0.6, 0.70), (0.40, 0.7, 0.60)])
    assert pick_t_low(rows, target_recall=0.95, ceiling=0.60).threshold == pytest.approx(0.30)
