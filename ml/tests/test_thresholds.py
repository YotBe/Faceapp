"""Threshold loading, and the checks that stop a number being invented.

The rule "never hardcode a face-matching threshold" is only worth stating if
something enforces it. These tests are that something.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from faceapp_ml.config import (
    DEFAULT_THRESHOLDS_PATH,
    TARGET_PRECISION,
    Provenance,
    ThresholdProvenanceError,
    Thresholds,
    UntunedThresholdError,
    load_thresholds,
    write_thresholds,
)


def make_report(tmp_path: Path, *, kind: str = "real") -> Path:
    path = tmp_path / "report.json"
    path.write_text(
        json.dumps({"dataset_id": "wedding-2026-05", "dataset_kind": kind}, sort_keys=True) + "\n"
    )
    return path


def make_provenance(report: Path, *, kind: str = "real", precision: float = 0.9912) -> Provenance:
    return Provenance(
        report=report.name,
        report_sha256=hashlib.sha256(report.read_bytes()).hexdigest(),
        dataset_id="wedding-2026-05",
        dataset_kind=kind,
        engine="insightface/buffalo_l",
        n_query_people=20,
        n_photos=612,
        n_faces=2841,
        precision_at_t_high=precision,
        recall_at_t_high=0.812,
        recall_at_t_low=0.951,
        generated_at="2026-08-27T12:00:00+00:00",
    )


# ---------------------------------------------------------------------------
# The shipped, untuned config
# ---------------------------------------------------------------------------


def test_the_repository_ships_without_a_threshold() -> None:
    """A default that "looks about right" is the failure mode this prevents.

    If this test ever starts failing because someone tuned the thresholds for
    real, replace it with an assertion about the committed provenance.
    """
    with pytest.raises(UntunedThresholdError, match="has not been tuned"):
        load_thresholds(DEFAULT_THRESHOLDS_PATH)


def test_the_untuned_error_says_how_to_fix_it() -> None:
    with pytest.raises(UntunedThresholdError) as exc:
        load_thresholds(DEFAULT_THRESHOLDS_PATH)
    message = str(exc.value)
    assert "eval.run" in message
    assert "eval.select_thresholds" in message


def test_a_missing_config_is_untuned_not_a_crash(tmp_path: Path) -> None:
    with pytest.raises(UntunedThresholdError, match="no threshold config"):
        load_thresholds(tmp_path / "nope.toml")


# ---------------------------------------------------------------------------
# Round trip
# ---------------------------------------------------------------------------


def test_write_then_load(tmp_path: Path) -> None:
    report = make_report(tmp_path)
    written = Thresholds(t_high=0.47, t_low=0.38, provenance=make_provenance(report))
    config = tmp_path / "thresholds.toml"
    write_thresholds(written, path=config)

    loaded = load_thresholds(config)
    assert loaded.t_high == pytest.approx(0.47)
    assert loaded.t_low == pytest.approx(0.38)
    assert loaded.provenance.dataset_id == "wedding-2026-05"
    assert loaded.provenance.engine == "insightface/buffalo_l"


def test_editing_a_threshold_by_hand_is_caught(tmp_path: Path) -> None:
    """The check that actually matters.

    Without the report digest, changing 0.47 to 0.41 and leaving the provenance
    block alone produces a file indistinguishable from a tuned one — and it is
    precisely the change that sails through review.
    """
    report = make_report(tmp_path)
    config = tmp_path / "thresholds.toml"
    write_thresholds(
        Thresholds(t_high=0.47, t_low=0.38, provenance=make_provenance(report)), path=config
    )

    report.write_text(json.dumps({"dataset_id": "wedding-2026-05", "dataset_kind": "real"}))

    with pytest.raises(ThresholdProvenanceError, match="does not match the digest"):
        load_thresholds(config)


def test_a_missing_report_is_refused(tmp_path: Path) -> None:
    """The evidence has to ship with the code that relies on it."""
    report = make_report(tmp_path)
    config = tmp_path / "thresholds.toml"
    write_thresholds(
        Thresholds(t_high=0.47, t_low=0.38, provenance=make_provenance(report)), path=config
    )
    report.unlink()

    with pytest.raises(ThresholdProvenanceError, match="report that justified"):
        load_thresholds(config)


def test_synthetic_provenance_is_refused(tmp_path: Path) -> None:
    report = make_report(tmp_path, kind="synthetic")
    config = tmp_path / "thresholds.toml"
    write_thresholds(
        Thresholds(
            t_high=0.47, t_low=0.38, provenance=make_provenance(report, kind="synthetic")
        ),
        path=config,
    )

    with pytest.raises(ThresholdProvenanceError, match="synthetic"):
        load_thresholds(config)


def test_precision_below_the_floor_is_refused(tmp_path: Path) -> None:
    report = make_report(tmp_path)
    config = tmp_path / "thresholds.toml"
    write_thresholds(
        Thresholds(t_high=0.47, t_low=0.38, provenance=make_provenance(report, precision=0.962)),
        path=config,
    )

    with pytest.raises(ThresholdProvenanceError, match="below the"):
        load_thresholds(config)


def test_inverted_thresholds_are_refused(tmp_path: Path) -> None:
    report = make_report(tmp_path)
    config = tmp_path / "thresholds.toml"
    write_thresholds(
        Thresholds(t_high=0.38, t_low=0.47, provenance=make_provenance(report)), path=config
    )

    with pytest.raises(ThresholdProvenanceError, match="t_low <= t_high"):
        load_thresholds(config)


def test_strict_false_is_available_for_the_eval_harness(tmp_path: Path) -> None:
    """The harness has to read a config that is not yet trustworthy.

    Nothing serving an attendee request may use this.
    """
    report = make_report(tmp_path, kind="synthetic")
    config = tmp_path / "thresholds.toml"
    write_thresholds(
        Thresholds(
            t_high=0.47, t_low=0.38, provenance=make_provenance(report, kind="synthetic")
        ),
        path=config,
    )

    loaded = load_thresholds(config, strict=False)
    assert loaded.t_high == pytest.approx(0.47)


def test_a_truncated_provenance_block_is_refused(tmp_path: Path) -> None:
    config = tmp_path / "thresholds.toml"
    config.write_text(
        'status = "tuned"\n\n[thresholds]\nt_high = 0.47\nt_low = 0.38\n\n[provenance]\n'
    )
    with pytest.raises(ThresholdProvenanceError, match="missing"):
        load_thresholds(config)


# ---------------------------------------------------------------------------
# Bucketing
# ---------------------------------------------------------------------------


def bucketer() -> Thresholds:
    return Thresholds(
        t_high=0.47,
        t_low=0.38,
        provenance=Provenance(
            report="r.json",
            report_sha256="x",
            dataset_id="d",
            dataset_kind="real",
            engine="e",
            n_query_people=1,
            n_photos=1,
            n_faces=1,
            precision_at_t_high=TARGET_PRECISION,
            recall_at_t_high=0.8,
            recall_at_t_low=0.95,
            generated_at="now",
        ),
    )


@pytest.mark.parametrize(
    ("sim", "tier", "expected"),
    [
        (0.90, 2, "confident"),
        (0.47, 2, "confident"),
        (0.46, 2, "maybe"),
        (0.38, 2, "maybe"),
        (0.37, 2, "reject"),
        (0.10, 2, "reject"),
    ],
)
def test_bucket_boundaries(sim: float, tier: int, expected: str) -> None:
    assert bucketer().bucket(sim, quality_tier=tier) == expected


@pytest.mark.parametrize("sim", [0.99, 0.60, 0.47])
def test_a_weak_face_can_never_reach_the_confident_set(sim: float) -> None:
    """However well it scores.

    A small, blurred or strongly angled face matching at 0.6 is more likely to be
    a coincidence than a good match, and the confident set is delivered without
    anybody looking at it first.
    """
    assert bucketer().bucket(sim, quality_tier=1) == "maybe"
