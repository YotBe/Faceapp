"""Run a threshold evaluation.

    python -m eval.run --dataset eval/datasets/wedding-2026-05
    python -m eval.run --synthetic            # harness self-check, no album needed

Writes a JSON report and a Markdown report to `eval/reports/`. The JSON is the
input to `eval.select_thresholds`, which is the only thing allowed to write
`config/thresholds.toml`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from faceapp_ml.config import TARGET_PRECISION
from faceapp_ml.quality import QualityPolicy

from .dataset import load_dataset
from .faceindex import build_or_load_index
from .metrics import (
    ThresholdNotReachable,
    default_grid,
    pick_t_high,
    score_pairs,
    sliced_recall,
    sweep,
    unreachable_rate,
)
from .report import EvalReport, now_stamp


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="eval.run", description=__doc__)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--dataset", type=Path, help="directory containing dataset.toml")
    src.add_argument(
        "--synthetic",
        action="store_true",
        help="generate an album statistically. Proves the harness; cannot set thresholds.",
    )
    p.add_argument("--seed", type=int, default=20260827, help="synthetic seed")
    p.add_argument(
        "--engine",
        default="insightface",
        choices=("insightface",),
        help="face engine to index with",
    )
    p.add_argument("--quality-config", type=Path, default=None)
    p.add_argument("--grid-min", type=float, default=0.30)
    p.add_argument("--grid-max", type=float, default=0.60)
    p.add_argument("--grid-step", type=float, default=0.01)
    p.add_argument(
        "--no-cache",
        action="store_true",
        help="re-index even if a cached index exists for this dataset+engine+policy",
    )
    p.add_argument("--out", type=Path, default=None, help="report directory")
    p.add_argument(
        "--allow-uncorrected",
        action="store_true",
        help="run over a dataset whose labels were entirely model-proposed. For "
        "inspecting a label set mid-review; the resulting report cannot set "
        "thresholds.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    policy = QualityPolicy.load(args.quality_config)
    notes: list[str] = []

    if args.synthetic:
        from .synth import SynthConfig, generate

        print("==> generating a synthetic album (harness self-check)")
        dataset, index = generate(SynthConfig(seed=args.seed))
    else:
        dataset = load_dataset(args.dataset)
        print(f"==> {dataset.summary()}")
        if dataset.labelling is not None:
            print(f"==> {dataset.labelling.summary()}")
            if not dataset.labelling.has_human_corrections and not args.allow_uncorrected:
                raise SystemExit(
                    "\nThis dataset's labels were all proposed by the same model that is "
                    "about to be evaluated, and not one of them was corrected by a "
                    "person.\n\n"
                    "Recall computed against it would be measuring the model against its "
                    "own opinions: every face the detector missed, and every face the "
                    "quality gate rejected, is invisible to labels derived from "
                    "detections. The number would come out high and mean nothing, and a "
                    "threshold chosen from it is worse than no threshold because it looks "
                    "earned.\n\n"
                    "Work through the misses screen for each person:\n"
                    f"    python -m eval.label review --dataset {args.dataset}\n\n"
                    "--allow-uncorrected runs it anyway. The report is then marked "
                    "untrustworthy and select_thresholds will still refuse it."
                )
        if args.engine == "insightface":
            from faceapp_ml.engine import InsightFaceEngine

            engine = InsightFaceEngine()
        else:  # pragma: no cover - argparse restricts this
            raise SystemExit(f"unknown engine {args.engine}")

        print(f"==> indexing with {engine.name}")
        index, cached = build_or_load_index(
            dataset, engine, policy=policy, use_cache=not args.no_cache
        )
        if cached:
            print("    (reused cached index; --no-cache to force a re-index)")

    print(f"==> {index.n_faces:,} faces indexed across {index.n_photos:,} photographs")
    if index.enrollment_failures:
        print(f"==> {len(index.enrollment_failures)} enrollment problem(s)")

    # Confident set: tier-2 faces only, exactly as the search path will restrict
    # it. Sweeping over all tiers here would pick a T_high for a population that
    # never reaches the confident bucket.
    confident_pairs = score_pairs(index, dataset, tiers=(2,))
    all_pairs = score_pairs(index, dataset, tiers=(1, 2))

    grid = default_grid(args.grid_min, args.grid_max, args.grid_step)
    confident_rows = sweep(confident_pairs, grid)

    # If the precision floor is unreachable inside the swept range, extend rather
    # than fail: "no threshold works" and "your threshold is above 0.60" are very
    # different diagnoses and the operator deserves to be told which one it is.
    if max(r.precision for r in confident_rows) < TARGET_PRECISION and args.grid_max < 0.80:
        extended = default_grid(args.grid_min, 0.80, args.grid_step)
        confident_rows = sweep(confident_pairs, extended)
        grid = extended
        notes.append(
            f"Precision did not reach {TARGET_PRECISION} within [{args.grid_min:.2f}, "
            f"{args.grid_max:.2f}]; the sweep was automatically extended to 0.80."
        )

    all_rows = sweep(all_pairs, grid)

    try:
        t_high_row = pick_t_high(confident_rows, target_precision=TARGET_PRECISION)
        slice_threshold = t_high_row.threshold
        notes.append(
            f"T_high candidate {t_high_row.threshold:.2f}: precision "
            f"{t_high_row.precision:.4f}, recall {t_high_row.recall:.4f}."
        )
    except ThresholdNotReachable as exc:
        best = max(confident_rows, key=lambda r: r.precision)
        slice_threshold = best.threshold
        notes.append(f"No usable T_high. {exc}")
        print(f"\n!!  {exc}\n", file=sys.stderr)

    slices = sliced_recall(confident_pairs, index, dataset, threshold=slice_threshold)

    labelling_dict = None
    if not args.synthetic and dataset.labelling is not None:
        labelling_dict = {
            "tool": dataset.labelling.tool,
            "engine": dataset.labelling.engine,
            "from_clusters": dataset.labelling.from_clusters,
            "human_added": dataset.labelling.human_added,
            "human_removed": dataset.labelling.human_removed,
            "held_out_photos": dataset.labelling.held_out_photos,
        }

    report = EvalReport(
        dataset_id=dataset.dataset_id,
        dataset_kind=dataset.kind,
        engine=index.engine_name,
        generated_at=now_stamp(),
        n_photos=index.n_photos,
        n_faces=index.n_faces,
        n_query_people=len(index.queries),
        n_positive_pairs=int(np.count_nonzero(all_pairs.truth)),
        gate=index.gate,
        policy=policy,
        confident_sweep=confident_rows,
        all_tier_sweep=all_rows,
        unreachable_rate=unreachable_rate(all_pairs),
        confident_unreachable_rate=unreachable_rate(confident_pairs),
        enrollment_failures=index.enrollment_failures,
        labelling=labelling_dict,
        slices=slices,
        notes=notes,
    )

    json_path, md_path = report.write(args.out)

    print()
    print(report._render_table(confident_rows))
    print()
    print(
        f"recall ceiling: {report.unreachable_rate:.1%} of appearances were never indexed "
        f"at all; {report.confident_unreachable_rate:.1%} are out of reach of the "
        f"confident (tier-2 only) set"
    )
    print(f"report: {json_path}")
    print(f"        {md_path}")
    print()
    if dataset.is_real:
        print("Next: python -m eval.select_thresholds --report", json_path, "--write")
    else:
        print(
            "This was a synthetic run. It cannot set production thresholds —\n"
            "eval.select_thresholds will refuse, and so will the config loader."
        )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
