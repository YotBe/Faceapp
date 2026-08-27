"""The whole harness, on a synthetic album.

This is the test that would catch a wiring mistake between the pieces — a sweep
run against the wrong tier, a report field that never gets populated, a
selection step that silently accepts a synthetic dataset. It is fast because the
synthetic generator produces embeddings directly, so CI runs it on every commit
without needing an event album or a 300MB model pack.

It asserts *internal consistency* — that the numbers agree with each other and
with the ground truth we constructed — never that any particular threshold is
correct. No synthetic run can tell you that.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from eval.metrics import score_pairs, sweep, unreachable_rate
from eval.report import EvalReport, now_stamp
from eval.synth import SynthConfig, generate
from faceapp_ml.quality import QualityPolicy

ML_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def album():
    return generate(SynthConfig(n_photos=120, n_identities=30, n_query_people=10, seed=99))


def test_the_generated_album_is_internally_consistent(album) -> None:
    dataset, index = album

    assert dataset.kind == "synthetic"
    assert len(dataset.photos) == 120
    assert index.n_photos == 120
    assert len(index.queries) == 10

    assert index.embeddings.shape[1] == 512
    norms = np.linalg.norm(index.embeddings, axis=1)
    np.testing.assert_allclose(norms, 1.0, atol=1e-5)

    assert set(np.unique(index.tier)).issubset({1, 2})
    assert index.gate.detected == index.gate.rejected + index.gate.tier1 + index.gate.tier2


def test_the_gate_never_indexes_a_face_it_rejected(album) -> None:
    _, index = album
    assert index.face_px.min() >= 40
    assert index.det_score.min() >= 0.5


def test_a_person_scores_higher_against_their_own_photographs(album) -> None:
    """The generator has to produce a signal, or the sweep tests prove nothing."""
    dataset, index = album
    pairs = score_pairs(index, dataset, tiers=(1, 2))

    scored = np.isfinite(pairs.scores)
    mine = pairs.scores[pairs.truth & scored]
    theirs = pairs.scores[~pairs.truth & scored]

    assert mine.mean() > theirs.mean() + 0.2


def test_precision_rises_and_recall_falls_across_the_sweep(album) -> None:
    dataset, index = album
    rows = sweep(score_pairs(index, dataset, tiers=(2,)), np.arange(0.30, 0.81, 0.02))

    assert rows[-1].precision >= rows[0].precision
    recalls = [r.recall for r in rows]
    assert recalls == sorted(recalls, reverse=True)


def test_counts_reconcile_at_every_threshold(album) -> None:
    """tp + fn is the number of true appearances, whatever the threshold."""
    dataset, index = album
    pairs = score_pairs(index, dataset, tiers=(1, 2))
    positives = int(pairs.truth.sum())

    for row in sweep(pairs, np.arange(0.20, 0.90, 0.05)):
        assert row.n_tp + row.n_fn == positives


def test_the_confident_ceiling_is_never_better_than_the_overall_one(album) -> None:
    """Tier-2 faces are a subset, so fewer appearances are reachable through them.

    Reporting these the wrong way round would make the confident sweep's recall
    column look inexplicable.
    """
    dataset, index = album
    overall = unreachable_rate(score_pairs(index, dataset, tiers=(1, 2)))
    confident = unreachable_rate(score_pairs(index, dataset, tiers=(2,)))
    assert confident >= overall


def test_recall_at_t_high_respects_the_confident_ceiling(album) -> None:
    dataset, index = album
    pairs = score_pairs(index, dataset, tiers=(2,))
    ceiling = 1.0 - unreachable_rate(pairs)

    for row in sweep(pairs, np.arange(0.30, 0.61, 0.05)):
        assert row.recall <= ceiling + 1e-9


def test_report_round_trips_through_json(album, tmp_path: Path) -> None:
    dataset, index = album
    confident = score_pairs(index, dataset, tiers=(2,))
    all_tier = score_pairs(index, dataset, tiers=(1, 2))

    report = EvalReport(
        dataset_id=dataset.dataset_id,
        dataset_kind=dataset.kind,
        engine=index.engine_name,
        generated_at=now_stamp(),
        n_photos=index.n_photos,
        n_faces=index.n_faces,
        n_query_people=len(index.queries),
        n_positive_pairs=int(all_tier.truth.sum()),
        gate=index.gate,
        policy=QualityPolicy(),
        confident_sweep=sweep(confident),
        all_tier_sweep=sweep(all_tier),
        unreachable_rate=unreachable_rate(all_tier),
        confident_unreachable_rate=unreachable_rate(confident),
        enrollment_failures={},
    )

    json_path, md_path = report.write(tmp_path)
    data = json.loads(json_path.read_text())

    assert data["dataset_kind"] == "synthetic"
    assert len(data["confident_sweep"]) == 31
    assert "confident_unreachable_rate" in data
    assert md_path.read_text().startswith("# Threshold evaluation")


def test_report_json_digest_is_stable_across_writes(album, tmp_path: Path) -> None:
    """The digest is the anti-tamper check on thresholds; it has to be reproducible."""
    dataset, index = album
    pairs = score_pairs(index, dataset, tiers=(2,))
    stamp = now_stamp()

    def build() -> EvalReport:
        return EvalReport(
            dataset_id=dataset.dataset_id,
            dataset_kind=dataset.kind,
            engine=index.engine_name,
            generated_at=stamp,
            n_photos=index.n_photos,
            n_faces=index.n_faces,
            n_query_people=len(index.queries),
            n_positive_pairs=int(pairs.truth.sum()),
            gate=index.gate,
            policy=QualityPolicy(),
            confident_sweep=sweep(pairs),
            all_tier_sweep=sweep(pairs),
            unreachable_rate=unreachable_rate(pairs),
            confident_unreachable_rate=unreachable_rate(pairs),
            enrollment_failures={},
        )

    a, _ = build().write(tmp_path / "a")
    b, _ = build().write(tmp_path / "b")
    assert EvalReport.digest(a) == EvalReport.digest(b)


def test_report_contains_no_embeddings(album, tmp_path: Path) -> None:
    """Reports are committed to git. Biometric data is not.

    A stray embedding in a report would put face templates into a permanent,
    replicated, effectively un-deletable store — the exact opposite of every
    retention guarantee in docs/COMPLIANCE.md.
    """
    dataset, index = album
    pairs = score_pairs(index, dataset, tiers=(2,))
    report = EvalReport(
        dataset_id=dataset.dataset_id,
        dataset_kind=dataset.kind,
        engine=index.engine_name,
        generated_at=now_stamp(),
        n_photos=index.n_photos,
        n_faces=index.n_faces,
        n_query_people=len(index.queries),
        n_positive_pairs=int(pairs.truth.sum()),
        gate=index.gate,
        policy=QualityPolicy(),
        confident_sweep=sweep(pairs),
        all_tier_sweep=sweep(pairs),
        unreachable_rate=unreachable_rate(pairs),
        confident_unreachable_rate=unreachable_rate(pairs),
        enrollment_failures={},
    )
    json_path, md_path = report.write(tmp_path)

    for path in (json_path, md_path):
        text = path.read_text()
        assert "embedding" not in text.lower()
        assert ".jpg" not in text


# ---------------------------------------------------------------------------
# The CLI
# ---------------------------------------------------------------------------


def run_module(module: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", module, *args],
        cwd=ML_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.slow
def test_cli_runs_end_to_end_and_refuses_to_set_thresholds(tmp_path: Path) -> None:
    """The path a person actually takes, including the refusal at the end."""
    run = run_module("eval.run", "--synthetic", "--seed", "7", "--out", str(tmp_path))
    assert run.returncode == 0, run.stderr
    assert "threshold  precision  recall" in run.stdout
    assert "recall ceiling" in run.stdout

    reports = list(tmp_path.glob("*.json"))
    assert len(reports) == 1

    select = run_module("eval.select_thresholds", "--report", str(reports[0]))
    assert select.returncode != 0
    assert "refusing" in (select.stderr + select.stdout)
    assert "synthetic" in (select.stderr + select.stdout)


@pytest.mark.slow
def test_gate_passes_against_itself_and_fails_on_a_recall_drop(tmp_path: Path) -> None:
    run = run_module("eval.run", "--synthetic", "--seed", "11", "--out", str(tmp_path))
    assert run.returncode == 0, run.stderr
    baseline = next(iter(tmp_path.glob("*.json")))

    same = run_module("eval.gate", "--report", str(baseline), "--baseline", str(baseline))
    assert same.returncode == 0, same.stdout
    assert "no regression" in same.stdout

    # Degrade the new report: same T_high, materially worse recall.
    data = json.loads(baseline.read_text())
    for row in data["confident_sweep"]:
        row["recall"] = max(0.0, row["recall"] - 0.25)
    degraded = tmp_path / "degraded.json"
    degraded.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")

    regressed = run_module("eval.gate", "--report", str(degraded), "--baseline", str(baseline))
    assert regressed.returncode == 1
    assert "recall at T_high fell" in regressed.stdout
