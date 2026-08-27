"""Threshold sweep and sliced metrics.

**What counts as a prediction.** The unit of evaluation is a (person, photograph)
pair, because that is the unit the attendee experiences. They do not see faces;
they see a grid of photographs, and they judge the product by how many of theirs
are missing and whether any of them are of somebody else. So results are grouped
by photograph and scored on the best-matching face in each, exactly as §4 of the
spec describes ranking working in production.

Scoring a face-level task instead would produce prettier numbers — most faces in
an album are easy — and would not predict what a user sees.

**Precision is the number that matters.** Returning a stranger's photographs is a
reportable personal data breach in the EU, not a bad search result. `T_high` is
therefore taken at precision >= 0.99, not at the F1 optimum, and the harness
reports precision at every recall level so the trade is visible rather than
implied.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from faceapp_ml.embeddings import cosine_similarity_matrix

from .dataset import LabeledDataset
from .faceindex import FaceIndex

# A similarity below which we assume the person's face is not in the index at
# all — not detected, or rejected by the quality gate. Well under any plausible
# operating threshold. See `unreachable_rate`.
REACHABILITY_FLOOR = 0.20


@dataclass(slots=True)
class PairScores:
    """Best similarity between each enrolled person and each photograph."""

    person_ids: list[str]
    photo_ids: list[str]
    scores: np.ndarray  # (P, N) float32; -inf where the photo has no qualifying face
    truth: np.ndarray  # (P, N) bool
    best_face: np.ndarray  # (P, N) int32; index into the FaceIndex arrays, -1 if none

    @property
    def n_pairs(self) -> int:
        return int(self.scores.size)

    @property
    def n_positive(self) -> int:
        return int(self.truth.sum())


def score_pairs(
    index: FaceIndex,
    dataset: LabeledDataset,
    *,
    tiers: tuple[int, ...] = (1, 2),
) -> PairScores:
    """Score every (enrolled person, photograph) pair.

    `tiers` restricts which indexed faces may contribute. The confident set is
    tier-2 only, so `T_high` is chosen from a sweep with `tiers=(2,)`; the
    "maybe" bucket sees everything.
    """
    person_ids = sorted(index.queries)
    queries = np.stack([index.queries[p] for p in person_ids])

    mask = np.isin(index.tier, np.asarray(tiers))
    face_rows = np.flatnonzero(mask)

    n_people, n_photos = len(person_ids), index.n_photos
    scores = np.full((n_people, n_photos), -np.inf, dtype=np.float32)
    best_face = np.full((n_people, n_photos), -1, dtype=np.int32)

    if face_rows.size:
        sims = cosine_similarity_matrix(queries, index.embeddings[face_rows])  # (P, F')
        photo_of_face = index.photo_index[face_rows]

        # Group by photograph, taking the maximum. A loop over photographs would
        # be O(P x N x F); this is one pass over the faces.
        for col, photo_col in enumerate(photo_of_face):
            better = sims[:, col] > scores[:, photo_col]
            scores[better, photo_col] = sims[better, col]
            best_face[better, photo_col] = face_rows[col]

    truth = np.zeros((n_people, n_photos), dtype=bool)
    photo_pos = {pid: i for i, pid in enumerate(index.photo_ids)}
    for row, person in enumerate(person_ids):
        for photo_id in dataset.positives(person):
            truth[row, photo_pos[photo_id]] = True

    return PairScores(
        person_ids=person_ids,
        photo_ids=list(index.photo_ids),
        scores=scores,
        truth=truth,
        best_face=best_face,
    )


@dataclass(frozen=True, slots=True)
class SweepRow:
    threshold: float
    precision: float
    recall: float
    f1: float
    n_tp: int
    n_fp: int
    n_fn: int

    def as_dict(self) -> dict[str, float | int]:
        return {
            "threshold": round(self.threshold, 4),
            "precision": round(self.precision, 6),
            "recall": round(self.recall, 6),
            "f1": round(self.f1, 6),
            "n_tp": self.n_tp,
            "n_fp": self.n_fp,
            "n_fn": self.n_fn,
        }


def default_grid(start: float = 0.30, stop: float = 0.60, step: float = 0.01) -> np.ndarray:
    """The sweep from the spec: 0.30 to 0.60 inclusive, in hundredths."""
    n = round((stop - start) / step) + 1
    return np.round(start + step * np.arange(n), 4)


def sweep(pairs: PairScores, grid: np.ndarray | None = None) -> list[SweepRow]:
    grid = default_grid() if grid is None else np.asarray(grid, dtype=float)
    rows: list[SweepRow] = []

    truth = pairs.truth
    positives = int(truth.sum())

    for t in grid:
        predicted = pairs.scores >= t
        tp = int(np.count_nonzero(predicted & truth))
        fp = int(np.count_nonzero(predicted & ~truth))
        fn = positives - tp

        precision = tp / (tp + fp) if (tp + fp) else 1.0
        recall = tp / positives if positives else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

        rows.append(
            SweepRow(
                threshold=float(t),
                precision=precision,
                recall=recall,
                f1=f1,
                n_tp=tp,
                n_fp=fp,
                n_fn=fn,
            )
        )
    return rows


def unreachable_rate(pairs: PairScores, *, floor: float = REACHABILITY_FLOOR) -> float:
    """Fraction of true appearances where no face in the photograph scores at all.

    This separates the two very different reasons a photograph goes missing:

      * the threshold was too strict — the face is indexed and scored 0.41 when
        we asked for 0.47. Tuning helps.
      * the face is not in the index — too small, too blurred, turned too far
        away, or the detector never saw it. No threshold recovers it, and
        lowering one only buys false positives elsewhere.

    The second number is the ceiling on recall, and it is the honest thing to put
    in front of an operator during onboarding. "We will find roughly 85% of your
    appearances, and in wide crowd shots more like 50%" is a feature when it is
    true and said up front.
    """
    if pairs.n_positive == 0:
        return 0.0
    missed = (pairs.scores < floor) & pairs.truth
    return float(np.count_nonzero(missed) / pairs.n_positive)


# ---------------------------------------------------------------------------
# Slices
# ---------------------------------------------------------------------------

FACE_PX_BUCKETS: tuple[tuple[str, float, float], ...] = (
    ("40-70px", 40, 70),
    ("70-120px", 70, 120),
    ("120-200px", 120, 200),
    (">200px", 200, np.inf),
)

YAW_BUCKETS: tuple[tuple[str, float, float], ...] = (
    ("frontal <15", 0, 15),
    ("15-30", 15, 30),
    ("30-45", 30, 45),
    ("profile >45", 45, np.inf),
)


@dataclass(frozen=True, slots=True)
class SliceRow:
    name: str
    n_positive: int
    recall: float
    note: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "n_positive": self.n_positive,
            "recall": round(self.recall, 6),
            "note": self.note,
        }


@dataclass(slots=True)
class Slices:
    by_face_px: list[SliceRow] = field(default_factory=list)
    by_yaw: list[SliceRow] = field(default_factory=list)
    by_lighting: list[SliceRow] = field(default_factory=list)

    def as_dict(self) -> dict[str, list[dict[str, object]]]:
        return {
            "by_face_px": [r.as_dict() for r in self.by_face_px],
            "by_yaw": [r.as_dict() for r in self.by_yaw],
            "by_lighting": [r.as_dict() for r in self.by_lighting],
        }


def sliced_recall(
    pairs: PairScores,
    index: FaceIndex,
    dataset: LabeledDataset,
    *,
    threshold: float,
) -> Slices:
    """Recall broken down by face size, head pose and lighting.

    You need to know that recall is 0.92 for large frontal faces and 0.41 for
    small profile ones, because that is the difference between a customer who
    was told what to expect and one who thinks the product is broken.

    **A caveat that belongs in the open, not in a footnote.** Labels are per
    photograph, not per face: the ground truth says "Dana is in photo 214", not
    "Dana is the third face from the left". To slice by face size we have to
    decide which face in the photograph was Dana's, and the only available answer
    is the highest-scoring one. For a true positive that is almost always right.
    For a miss it is a guess, and when the miss happened because Dana's face was
    never indexed at all, the attributed face belongs to somebody else entirely.

    So these slices are reliable in shape and approximate in detail. They are
    good enough to tell you that small faces are the problem — which is the
    decision they exist to support — and not good enough to quote to three
    decimal places. Per-face labels would fix it and are not worth the labeling
    effort at this stage.
    """
    positives = pairs.truth
    hit = (pairs.scores >= threshold) & positives
    face_of_pair = pairs.best_face

    def bucket_rows(
        values: np.ndarray, buckets: tuple[tuple[str, float, float], ...]
    ) -> list[SliceRow]:
        rows: list[SliceRow] = []
        for name, lo, hi in buckets:
            sel = np.zeros_like(positives, dtype=bool)
            idx = np.argwhere(positives)
            for r, c in idx:
                f = face_of_pair[r, c]
                if f < 0:
                    continue
                v = values[f]
                if np.isnan(v):
                    continue
                if lo <= v < hi:
                    sel[r, c] = True
            n = int(np.count_nonzero(sel))
            recall = float(np.count_nonzero(sel & hit) / n) if n else 0.0
            note = "too few samples to read anything into" if 0 < n < 20 else ""
            rows.append(SliceRow(name=name, n_positive=n, recall=recall, note=note))

        unattributed = int(np.count_nonzero(positives & (face_of_pair < 0)))
        if unattributed:
            rows.append(
                SliceRow(
                    name="no face indexed",
                    n_positive=unattributed,
                    recall=0.0,
                    note=(
                        "the person's face was never indexed for this photo; "
                        "no threshold recovers these"
                    ),
                )
            )
        return rows

    slices = Slices(
        by_face_px=bucket_rows(index.face_px.astype(float), FACE_PX_BUCKETS),
        by_yaw=bucket_rows(np.abs(index.yaw.astype(float)), YAW_BUCKETS),
    )

    lighting_of_photo = {p.photo_id: p.lighting for p in dataset.photos}
    labels = sorted({v for v in lighting_of_photo.values() if v})
    for label in labels:
        cols = [i for i, pid in enumerate(pairs.photo_ids) if lighting_of_photo.get(pid) == label]
        if not cols:
            continue
        sel = np.zeros_like(positives, dtype=bool)
        sel[:, cols] = positives[:, cols]
        n = int(np.count_nonzero(sel))
        recall = float(np.count_nonzero(sel & hit) / n) if n else 0.0
        slices.by_lighting.append(
            SliceRow(
                name=label,
                n_positive=n,
                recall=recall,
                note="too few samples to read anything into" if 0 < n < 20 else "",
            )
        )

    return slices


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------


class ThresholdNotReachable(RuntimeError):
    """No threshold in the swept range achieves the required precision."""


def pick_t_high(rows: list[SweepRow], *, target_precision: float) -> SweepRow:
    """The lowest threshold whose measured precision reaches the target.

    Lowest, not best: precision is monotone-ish increasing in the threshold and
    recall is decreasing, so once the precision floor is met, every further step
    up only loses true positives.
    """
    for row in rows:
        if row.precision >= target_precision:
            return row
    best = max(rows, key=lambda r: r.precision)
    raise ThresholdNotReachable(
        f"no threshold in [{rows[0].threshold:.2f}, {rows[-1].threshold:.2f}] reaches "
        f"precision {target_precision}. The best was {best.precision:.4f} at "
        f"{best.threshold:.2f}.\n"
        "Either the sweep needs to extend higher, or — more likely — this album has "
        "look-alikes, or too many small faces are reaching the confident set and the "
        "quality gate needs tightening before the threshold can save you."
    )


def pick_t_low(rows: list[SweepRow], *, target_recall: float, ceiling: float) -> SweepRow:
    """The highest threshold that still reaches the target recall.

    Highest, not lowest: within the recall requirement we want as few false
    positives in the "maybe" bucket as we can get. Clamped to `ceiling` (T_high),
    since a "maybe" threshold above the confident one would be incoherent.
    """
    eligible = [r for r in rows if r.recall >= target_recall and r.threshold <= ceiling]
    if eligible:
        return max(eligible, key=lambda r: r.threshold)

    # Recall never reaches the target anywhere in range — which usually means the
    # ceiling is set by detection, not by the threshold. Fall back to the lowest
    # swept threshold and let the report say so.
    return rows[0]
