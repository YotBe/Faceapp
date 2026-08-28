"""Choose `T_high` and `T_low` from an evaluation report, and write the config.

This is the only sanctioned writer of `config/thresholds.toml`. Everything about
it is arranged so that the number in that file can be traced back to the
measurement that produced it:

  * it will not run on a synthetic report;
  * it will not select a threshold whose measured precision is below the floor;
  * it records the SHA-256 of the report, which `load_thresholds` re-checks, so
    a hand-edited threshold fails on load rather than quietly shipping.

    python -m eval.select_thresholds --report eval/reports/<name>.json
    python -m eval.select_thresholds --report eval/reports/<name>.json --write
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from faceapp_ml.config import (
    TARGET_PRECISION,
    Provenance,
    Thresholds,
    write_thresholds,
)

from .metrics import SweepRow, ThresholdNotReachable, pick_t_high, pick_t_low
from .report import EvalReport

# Recall target for the secondary "maybe" bucket. Lower precision is acceptable
# here precisely because nothing in this bucket is auto-included in a download
# or auto-sent — a person looks at it first.
TARGET_RECALL_LOW = 0.95


def _rows(raw: list[dict]) -> list[SweepRow]:
    return [
        SweepRow(
            threshold=float(r["threshold"]),
            precision=float(r["precision"]),
            recall=float(r["recall"]),
            f1=float(r["f1"]),
            n_tp=int(r["n_tp"]),
            n_fp=int(r["n_fp"]),
            n_fn=int(r["n_fn"]),
        )
        for r in raw
    ]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="eval.select_thresholds", description=__doc__)
    p.add_argument("--report", type=Path, required=True, help="the JSON report from eval.run")
    p.add_argument(
        "--write",
        action="store_true",
        help="write config/thresholds.toml. Without this, prints what it would choose.",
    )
    p.add_argument("--target-precision", type=float, default=TARGET_PRECISION)
    p.add_argument("--target-recall-low", type=float, default=TARGET_RECALL_LOW)
    p.add_argument("--config", type=Path, default=None, help="override the config path")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    report_path = args.report.resolve()
    data = json.loads(report_path.read_text(encoding="utf-8"))

    labelling = data.get("labelling")
    if isinstance(labelling, dict) and not labelling.get("human_added", 0):
        raise SystemExit(
            f"refusing: every label behind {report_path.name} was proposed by the "
            f"model this report evaluates, and none was corrected by a person.\n"
            "\n"
            "A recall figure measured against a model's own output cannot see the "
            "faces that model missed, so it comes out high whatever the model is "
            "worth. A threshold chosen from it would carry a number that looks "
            "earned and is not.\n"
            "\n"
            "Go through the misses screen for each person, re-run eval.run, and try "
            "again."
        )

    if data.get("dataset_kind") != "real":
        raise SystemExit(
            f"refusing: {report_path.name} was produced from a "
            f"{data.get('dataset_kind')!r} dataset.\n"
            "\n"
            "The synthetic generator models what embeddings look like statistically.\n"
            "It knows nothing about backlight, motion blur, sunglasses, or a face turned\n"
            "sixty degrees away — which is where the threshold is actually decided.\n"
            "Build a labeled set from a real album. See eval/README.md."
        )

    if args.target_precision < TARGET_PRECISION:
        raise SystemExit(
            f"refusing: --target-precision {args.target_precision} is below the "
            f"{TARGET_PRECISION} floor.\n"
            "At 0.95, a user with forty photographs receives two belonging to someone "
            "else, which is a reportable personal data breach in the EU. If this floor "
            "genuinely needs to move, it moves in faceapp_ml/config.py with a reason "
            "written down, not from a command line flag."
        )

    confident = _rows(data["confident_sweep"])
    all_tier = _rows(data["all_tier_sweep"])

    try:
        t_high_row = pick_t_high(confident, target_precision=args.target_precision)
    except ThresholdNotReachable as exc:
        raise SystemExit(f"refusing: {exc}") from exc

    t_low_row = pick_t_low(
        all_tier, target_recall=args.target_recall_low, ceiling=t_high_row.threshold
    )

    counts = data["counts"]
    provenance = Provenance(
        report=report_path.name,
        report_sha256=EvalReport.digest(report_path),
        dataset_id=str(data["dataset_id"]),
        dataset_kind=str(data["dataset_kind"]),
        engine=str(data["engine"]),
        n_query_people=int(counts["query_people"]),
        n_photos=int(counts["photos"]),
        n_faces=int(counts["faces_indexed"]),
        precision_at_t_high=t_high_row.precision,
        recall_at_t_high=t_high_row.recall,
        recall_at_t_low=t_low_row.recall,
        generated_at=datetime.now(UTC).isoformat(timespec="seconds"),
    )
    thresholds = Thresholds(
        t_high=t_high_row.threshold, t_low=t_low_row.threshold, provenance=provenance
    )

    print(f"report:        {report_path.name}")
    print(f"dataset:       {provenance.dataset_id} [{provenance.dataset_kind}]")
    print(f"engine:        {provenance.engine}")
    print()
    print(
        f"T_high = {thresholds.t_high:.2f}   precision {t_high_row.precision:.4f}   "
        f"recall {t_high_row.recall:.4f}   ({t_high_row.n_tp} tp / {t_high_row.n_fp} fp)"
    )
    print(
        f"T_low  = {thresholds.t_low:.2f}   precision {t_low_row.precision:.4f}   "
        f"recall {t_low_row.recall:.4f}   ({t_low_row.n_tp} tp / {t_low_row.n_fp} fp)"
    )
    print()
    print(
        f"Recall ceiling from unindexed faces: {data['unreachable_rate']:.1%}. "
        "Tell the operator this number."
    )
    print()

    if not args.write:
        print("Dry run. Re-run with --write to update config/thresholds.toml.")
        return 0

    notes = (
        f"T_high is the lowest swept threshold reaching precision "
        f">= {args.target_precision}.\n"
        f"T_low is the highest swept threshold still reaching recall "
        f">= {args.target_recall_low}, capped at T_high."
    )
    written = write_thresholds(thresholds, path=args.config, notes=notes)
    print(f"wrote {written}")
    print("Commit the report alongside it — load_thresholds() verifies its digest.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
