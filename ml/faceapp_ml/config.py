"""Match thresholds, and the machinery that stops anyone inventing one.

Hardcoding a cosine threshold read off a blog post is the most common way this
category of product fails. The right number depends on the detector, the
embedding model, and the photographic conditions of the specific albums being
searched. Somewhere around 0.35–0.55 is as much as anyone can say without data,
and shipping the midpoint of that range is how a user ends up with two
strangers' photographs in their download — which in the EU is a reportable
personal data breach, not a bad search result.

So the number is not a constant in the source. It lives in
`config/thresholds.toml`, that file is written only by
`eval.select_thresholds`, and loading it in strict mode verifies:

  * the file says it has been tuned at all;
  * the evaluation it came from used a real labeled dataset, not the synthetic
    one that exists to test the harness;
  * the measured precision at `t_high` actually reaches the target;
  * the report that justified the numbers is present, and its SHA-256 matches
    what was recorded when they were chosen.

That last check is the one that matters. Without it, editing `t_high` by hand
and leaving the provenance block intact would look identical to a tuned config,
and would be exactly the kind of change that passes review.
"""

from __future__ import annotations

import hashlib
import tomllib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
DEFAULT_THRESHOLDS_PATH = CONFIG_DIR / "thresholds.toml"

# The precision floor for the confident result set. Not 0.95: with 0.95, a user
# with forty photographs receives two belonging to somebody else.
TARGET_PRECISION = 0.99


class UntunedThresholdError(RuntimeError):
    """Thresholds were requested but none have been measured.

    Deliberately fatal. The tempting alternative — fall back to a reasonable
    default and log a warning — produces a system that runs, returns plausible
    results, and is wrong in a direction nobody notices until someone complains
    that they received a stranger's photographs.
    """


class ThresholdProvenanceError(RuntimeError):
    """The thresholds exist but cannot be traced to the evaluation that set them."""


@dataclass(frozen=True, slots=True)
class Provenance:
    """Where a threshold came from. Every field is evidence, not metadata."""

    report: str
    report_sha256: str
    dataset_id: str
    dataset_kind: str  # "real" | "synthetic"
    engine: str
    n_query_people: int
    n_photos: int
    n_faces: int
    precision_at_t_high: float
    recall_at_t_high: float
    recall_at_t_low: float
    generated_at: str

    @property
    def is_real(self) -> bool:
        return self.dataset_kind == "real"


@dataclass(frozen=True, slots=True)
class Thresholds:
    """The two numbers the search path runs on.

    `t_high` — the confident set. Shown by default, included in a download,
    eligible for automatic delivery. Chosen at measured precision >= 0.99.

    `t_low` — the "maybe" set, shown behind an expander. Never auto-included in
    a download and never auto-sent over WhatsApp: a borderline match has to be
    looked at by a human before it goes anywhere.
    """

    t_high: float
    t_low: float
    provenance: Provenance

    def bucket(self, similarity: float, *, quality_tier: int) -> str:
        """Classify one scored face: 'confident', 'maybe' or 'reject'.

        A tier-1 face can never reach the confident set however well it scores.
        A small, blurred or strongly angled face that matches at 0.6 is more
        likely to be a coincidence than a good match, and the confident set is
        the one that gets delivered without anybody looking at it.
        """
        if similarity >= self.t_high and quality_tier >= 2:
            return "confident"
        if similarity >= self.t_low:
            return "maybe"
        return "reject"


def _require(data: dict[str, Any], section: str, key: str, path: Path) -> Any:
    try:
        return data[section][key]
    except KeyError as exc:
        raise ThresholdProvenanceError(f"{path}: missing [{section}].{key}") from exc


def load_thresholds(
    path: Path | str | None = None,
    *,
    strict: bool = True,
    verify_report: bool = True,
) -> Thresholds:
    """Read the tuned thresholds.

    `strict=False` skips the provenance checks and is for the eval harness
    itself, which necessarily has to read a config that is not yet tuned. It is
    not for the search path. Nothing that serves an attendee request should ever
    pass `strict=False`.
    """
    path = Path(path) if path is not None else DEFAULT_THRESHOLDS_PATH
    if not path.exists():
        raise UntunedThresholdError(f"no threshold config at {path}")

    with path.open("rb") as fh:
        data = tomllib.load(fh)

    status = data.get("status", "untuned")
    thresholds = data.get("thresholds", {})
    t_high = thresholds.get("t_high")
    t_low = thresholds.get("t_low")

    if status != "tuned" or t_high is None or t_low is None:
        raise UntunedThresholdError(
            f"{path} has not been tuned (status={status!r}).\n"
            "\n"
            "Thresholds are measured, not chosen. Build a labeled set of event\n"
            "photographs (see ml/eval/README.md), then:\n"
            "\n"
            "    python -m eval.run --dataset eval/datasets/<name>\n"
            "    python -m eval.select_thresholds --report eval/reports/<report>.json --write\n"
        )

    t_high = float(t_high)
    t_low = float(t_low)
    if not 0.0 < t_low <= t_high < 1.0:
        raise ThresholdProvenanceError(
            f"{path}: need 0 < t_low <= t_high < 1, got t_low={t_low}, t_high={t_high}"
        )

    provenance = Provenance(
        report=str(_require(data, "provenance", "report", path)),
        report_sha256=str(_require(data, "provenance", "report_sha256", path)),
        dataset_id=str(_require(data, "provenance", "dataset_id", path)),
        dataset_kind=str(_require(data, "provenance", "dataset_kind", path)),
        engine=str(_require(data, "provenance", "engine", path)),
        n_query_people=int(_require(data, "provenance", "n_query_people", path)),
        n_photos=int(_require(data, "provenance", "n_photos", path)),
        n_faces=int(_require(data, "provenance", "n_faces", path)),
        precision_at_t_high=float(_require(data, "provenance", "precision_at_t_high", path)),
        recall_at_t_high=float(_require(data, "provenance", "recall_at_t_high", path)),
        recall_at_t_low=float(_require(data, "provenance", "recall_at_t_low", path)),
        generated_at=str(_require(data, "provenance", "generated_at", path)),
    )

    if not strict:
        return Thresholds(t_high=t_high, t_low=t_low, provenance=provenance)

    if not provenance.is_real:
        raise ThresholdProvenanceError(
            f"{path}: thresholds were derived from a {provenance.dataset_kind!r} dataset.\n"
            "The synthetic generator exists to prove the harness computes the right\n"
            "arithmetic. It says nothing about how ArcFace behaves on a backlit face\n"
            "at 45 pixels, which is the only question that matters here."
        )

    if provenance.precision_at_t_high < TARGET_PRECISION:
        raise ThresholdProvenanceError(
            f"{path}: measured precision at t_high is "
            f"{provenance.precision_at_t_high:.4f}, below the {TARGET_PRECISION} floor. "
            "The confident set is delivered without anyone reviewing it."
        )

    if verify_report:
        report_path = (path.parent / provenance.report).resolve()
        if not report_path.exists():
            report_path = (Path.cwd() / provenance.report).resolve()
        if not report_path.exists():
            raise ThresholdProvenanceError(
                f"{path}: the report that justified these thresholds is missing "
                f"({provenance.report}). It has to ship with the code that uses the numbers."
            )
        digest = hashlib.sha256(report_path.read_bytes()).hexdigest()
        if digest != provenance.report_sha256:
            raise ThresholdProvenanceError(
                f"{path}: {provenance.report} does not match the digest recorded when "
                "these thresholds were chosen.\n"
                f"  recorded: {provenance.report_sha256}\n"
                f"  actual:   {digest}\n"
                "Either the report changed or the thresholds were edited by hand. "
                "Re-run eval.select_thresholds."
            )

    return Thresholds(t_high=t_high, t_low=t_low, provenance=provenance)


def write_thresholds(
    thresholds: Thresholds,
    *,
    path: Path | str | None = None,
    notes: str = "",
) -> Path:
    """Write `config/thresholds.toml`.

    Called only by `eval.select_thresholds`. If you are reaching for this from
    anywhere else, the thing you actually want is to run an evaluation.
    """
    path = Path(path) if path is not None else DEFAULT_THRESHOLDS_PATH
    p = thresholds.provenance

    note_block = ""
    if notes:
        note_block = "#\n" + "\n".join(f"# {line}" for line in notes.splitlines()) + "\n"

    body = f'''# Face matching thresholds.
#
# GENERATED FILE — do not edit by hand.
#
# Written by `python -m eval.select_thresholds`. Editing a number here without
# re-running the evaluation will fail `load_thresholds()`, because the SHA-256
# of the report below is checked against the recorded digest.
#
# Written at {datetime.now(UTC).isoformat(timespec="seconds")}
{note_block}
status = "tuned"

[thresholds]
# Confident set: shown by default, included in downloads, eligible for delivery.
t_high = {thresholds.t_high:.4f}
# "Maybe" set: behind an expander, never auto-included, never auto-sent.
t_low = {thresholds.t_low:.4f}

[provenance]
report = "{p.report}"
report_sha256 = "{p.report_sha256}"
dataset_id = "{p.dataset_id}"
dataset_kind = "{p.dataset_kind}"
engine = "{p.engine}"
n_query_people = {p.n_query_people}
n_photos = {p.n_photos}
n_faces = {p.n_faces}
precision_at_t_high = {p.precision_at_t_high:.6f}
recall_at_t_high = {p.recall_at_t_high:.6f}
recall_at_t_low = {p.recall_at_t_low:.6f}
generated_at = "{p.generated_at}"
'''
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path
