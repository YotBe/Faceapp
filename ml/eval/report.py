"""Evaluation reports.

Two outputs, on purpose:

* **JSON**, which `select_thresholds` reads and whose SHA-256 is recorded in
  `config/thresholds.toml`. It is the evidence for a number that decides whether
  strangers' photographs get delivered to somebody, so it is a committed
  artifact, not console output that scrolls away.
* **Markdown**, for a human — including the customer conversation about what
  recall to expect.

Neither contains an embedding, a crop, a file path or a person's name. Reports
are committed; biometric data is not. Person identifiers appear only as the
opaque ids used in `labels.csv`, and even those only in aggregate counts.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from faceapp_ml.quality import GateStats, QualityPolicy

from .metrics import Slices, SweepRow

REPORTS_DIR = Path(__file__).resolve().parent / "reports"


@dataclass(slots=True)
class EvalReport:
    dataset_id: str
    dataset_kind: str
    engine: str
    generated_at: str

    n_photos: int
    n_faces: int
    n_query_people: int
    n_positive_pairs: int

    gate: GateStats
    policy: QualityPolicy

    confident_sweep: list[SweepRow]  # tier-2 faces only; picks T_high
    all_tier_sweep: list[SweepRow]  # every indexed face; picks T_low

    # Appearances where no indexed face of any tier scores at all: the face was
    # never detected, or the gate rejected it. No threshold recovers these.
    unreachable_rate: float
    # The same, restricted to tier-2 faces. Higher than the above, because an
    # appearance whose only face is tier 1 can be found in the "maybe" bucket
    # but can never reach the confident set. This is what caps the recall
    # column of the confident sweep, and the two numbers have to be shown
    # together or the sweep table looks inexplicably bad.
    confident_unreachable_rate: float
    enrollment_failures: dict[str, str]
    # How the labels were arrived at, when a tool helped. Carried into the JSON
    # so select_thresholds can refuse a report whose ground truth was never
    # corrected by a person — the report is the only thing it gets to see.
    labelling: dict[str, Any] | None = None
    slices: Slices | None = None
    notes: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.notes is None:
            self.notes = []

    # -- serialisation -----------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": 1,
            "dataset_id": self.dataset_id,
            "dataset_kind": self.dataset_kind,
            "engine": self.engine,
            "generated_at": self.generated_at,
            "counts": {
                "photos": self.n_photos,
                "faces_indexed": self.n_faces,
                "query_people": self.n_query_people,
                "positive_pairs": self.n_positive_pairs,
            },
            "gate": {
                "detected": self.gate.detected,
                "rejected": self.gate.rejected,
                "tier1": self.gate.tier1,
                "tier2": self.gate.tier2,
                "rejection_rate": round(self.gate.rejection_rate, 6),
                "warns": self.gate.warns(),
            },
            "policy": {
                "min_face_px": self.policy.min_face_px,
                "min_det_score": self.policy.min_det_score,
                "good_face_px": self.policy.good_face_px,
                "good_det_score": self.policy.good_det_score,
                "max_yaw_deg": self.policy.max_yaw_deg,
                "min_blur_score": self.policy.min_blur_score,
            },
            "unreachable_rate": round(self.unreachable_rate, 6),
            "confident_unreachable_rate": round(self.confident_unreachable_rate, 6),
            "enrollment_failures": self.enrollment_failures,
            "labelling": self.labelling,
            "confident_sweep": [r.as_dict() for r in self.confident_sweep],
            "all_tier_sweep": [r.as_dict() for r in self.all_tier_sweep],
            "slices": self.slices.as_dict() if self.slices else None,
            "notes": list(self.notes),
        }

    def write(self, directory: Path | None = None, *, stem: str | None = None) -> tuple[Path, Path]:
        directory = directory or REPORTS_DIR
        directory.mkdir(parents=True, exist_ok=True)
        stamp = self.generated_at.replace(":", "").replace("-", "")[:15]
        stem = stem or f"{self.dataset_id}-{stamp}"

        json_path = directory / f"{stem}.json"
        # sort_keys and a trailing newline so the digest recorded in
        # thresholds.toml is stable across machines and Python versions.
        json_path.write_text(
            json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

        md_path = directory / f"{stem}.md"
        md_path.write_text(self.to_markdown(), encoding="utf-8")
        return json_path, md_path

    @staticmethod
    def digest(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    # -- rendering ---------------------------------------------------------

    def to_markdown(self) -> str:
        lines: list[str] = []
        a = lines.append

        a(f"# Threshold evaluation — {self.dataset_id}")
        a("")
        if self.dataset_kind != "real":
            a(
                f"> **This is a {self.dataset_kind} dataset.** The numbers below are the "
                "harness proving it computes the right arithmetic. They say nothing about "
                "how ArcFace behaves on a backlit face at 45 pixels, and thresholds derived "
                "from them are refused by the config loader."
            )
            a("")

        a(f"- engine: `{self.engine}`")
        a(f"- generated: {self.generated_at}")
        a(f"- photographs: {self.n_photos:,}")
        a(f"- faces indexed: {self.n_faces:,}")
        a(f"- people enrolled: {self.n_query_people}")
        a(f"- labeled appearances: {self.n_positive_pairs:,}")
        a("")

        a("## Quality gate")
        a("")
        a(f"- detections: {self.gate.detected:,}")
        a(f"- rejected (tier 0): {self.gate.rejected:,} ({self.gate.rejection_rate:.1%})")
        a(f"- tier 1 (weak): {self.gate.tier1:,}")
        a(f"- tier 2 (good): {self.gate.tier2:,}")
        a("")
        if self.gate.warns():
            a(
                f"> **{self.gate.rejection_rate:.0%} of detections were rejected.** This "
                "photographer is shooting wide crowds. Tell the operator what recall to "
                "expect before the event, not after it."
            )
            a("")

        a("## Recall ceilings")
        a("")
        a(
            f"- **{self.unreachable_rate:.1%}** of labeled appearances have no indexed "
            "face of any tier scoring above the reachability floor. The face was too "
            "small, too blurred, turned too far away, or never detected. **No threshold "
            "recovers these**, and lowering one to chase them only buys false positives "
            "elsewhere."
        )
        a(
            f"- **{self.confident_unreachable_rate:.1%}** are out of reach of the "
            "*confident* set specifically, which is restricted to tier-2 faces. The "
            "difference between these two numbers is the population that can only ever "
            "appear in the \"maybe\" bucket."
        )
        a("")
        a(
            f"So the recall column of the confident sweep cannot exceed "
            f"{1 - self.confident_unreachable_rate:.2f} no matter where `T_high` is put. "
            "That is the ceiling, and it is set by the camera and the quality gate, not "
            "by the threshold."
        )
        a("")
        a(
            "The first number is the one to put in front of an operator during "
            "onboarding. Under-promising here is a feature."
        )
        a("")

        a("## Confident set sweep (tier-2 faces only) — picks `T_high`")
        a("")
        a(self._render_table(self.confident_sweep))
        a("")

        a("## All-tier sweep — picks `T_low` for the \"maybe\" bucket")
        a("")
        a(self._render_table(self.all_tier_sweep))
        a("")

        if self.slices:
            a("## Sliced recall")
            a("")
            a(
                "Labels are per photograph, not per face, so a (person, photo) pair is "
                "attributed to the highest-scoring face in that photograph. Reliable for "
                "hits, approximate for misses. Read the shape, not the third decimal."
            )
            a("")
            for title, rows in (
                ("By face size", self.slices.by_face_px),
                ("By |yaw|", self.slices.by_yaw),
                ("By lighting", self.slices.by_lighting),
            ):
                if not rows:
                    continue
                a(f"### {title}")
                a("")
                a("| bucket | n | recall | |")
                a("|---|---:|---:|---|")
                for r in rows:
                    a(f"| {r.name} | {r.n_positive:,} | {r.recall:.3f} | {r.note} |")
                a("")

        if self.enrollment_failures:
            a("## Enrollment problems")
            a("")
            a("| person | reason |")
            a("|---|---|")
            for person, reason in sorted(self.enrollment_failures.items()):
                a(f"| {person} | {reason} |")
            a("")

        if self.notes:
            a("## Notes")
            a("")
            for note in self.notes:
                a(f"- {note}")
            a("")

        return "\n".join(lines) + "\n"

    @staticmethod
    def _render_table(rows: list[SweepRow]) -> str:
        """The report card format from the spec, as fixed-width text."""
        out = ["```", "threshold  precision  recall   F1     n_tp  n_fp  n_fn"]
        for r in rows:
            out.append(
                f"{r.threshold:<9.2f}  {r.precision:<9.3f}  {r.recall:<7.3f}  "
                f"{r.f1:<5.3f}  {r.n_tp:>4d}  {r.n_fp:>4d}  {r.n_fn:>4d}"
            )
        out.append("```")
        return "\n".join(out)


def now_stamp() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
