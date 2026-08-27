"""CI regression gate.

The spec asks for this by name: re-run the eval on every model or preprocessing
change, and fail the build on a recall regression. A quality-gate tweak or a
model bump that costs 8% of recall is exactly the change that looks harmless in
review and is discovered by a customer.

    python -m eval.gate --report eval/reports/new.json --baseline eval/reports/baseline.json

Compares like for like: same dataset, same target precision. Fails on
  * recall at the selected T_high dropping by more than `--max-recall-drop`
  * precision at the selected T_high falling below the floor
  * the recall ceiling (unindexed appearances) getting worse by more than
    `--max-ceiling-drift` — which catches a quality gate that has been tightened
    without anyone noticing what it cost.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from faceapp_ml.config import TARGET_PRECISION

from .metrics import SweepRow, ThresholdNotReachable, pick_t_high


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
    p = argparse.ArgumentParser(prog="eval.gate", description=__doc__)
    p.add_argument("--report", type=Path, required=True)
    p.add_argument("--baseline", type=Path, required=True)
    p.add_argument("--max-recall-drop", type=float, default=0.02)
    p.add_argument("--max-ceiling-drift", type=float, default=0.02)
    p.add_argument("--target-precision", type=float, default=TARGET_PRECISION)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    new = json.loads(args.report.read_text(encoding="utf-8"))
    old = json.loads(args.baseline.read_text(encoding="utf-8"))

    failures: list[str] = []

    if new["dataset_id"] != old["dataset_id"]:
        failures.append(
            f"datasets differ: {new['dataset_id']} vs baseline {old['dataset_id']}. "
            "A gate across two different albums compares nothing."
        )

    try:
        new_pick = pick_t_high(
            _rows(new["confident_sweep"]), target_precision=args.target_precision
        )
    except ThresholdNotReachable as exc:
        print(f"FAIL  {exc}")
        return 1

    try:
        old_pick = pick_t_high(
            _rows(old["confident_sweep"]), target_precision=args.target_precision
        )
    except ThresholdNotReachable:
        print("baseline never reached target precision; nothing to compare against")
        return 0

    recall_drop = old_pick.recall - new_pick.recall
    ceiling_drift = float(new["unreachable_rate"]) - float(old["unreachable_rate"])

    print(f"dataset:        {new['dataset_id']}")
    print(f"T_high:         {old_pick.threshold:.2f} -> {new_pick.threshold:.2f}")
    print(
        f"recall@T_high:  {old_pick.recall:.4f} -> {new_pick.recall:.4f} "
        f"({-recall_drop:+.4f})"
    )
    print(
        f"recall ceiling: {old['unreachable_rate']:.4f} -> {new['unreachable_rate']:.4f} "
        f"({ceiling_drift:+.4f} unindexed)"
    )
    print()

    if recall_drop > args.max_recall_drop:
        failures.append(
            f"recall at T_high fell by {recall_drop:.4f}, more than the "
            f"{args.max_recall_drop} allowed"
        )
    if new_pick.precision < args.target_precision:
        failures.append(
            f"precision at the selected T_high is {new_pick.precision:.4f}, "
            f"below the {args.target_precision} floor"
        )
    if ceiling_drift > args.max_ceiling_drift:
        failures.append(
            f"{ceiling_drift:.4f} more appearances are now unindexed. Something in the "
            "quality gate or the detector got stricter; that is a recall loss no "
            "threshold can undo."
        )

    if failures:
        for f in failures:
            print(f"FAIL  {f}")
        return 1

    print("OK    no regression")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
