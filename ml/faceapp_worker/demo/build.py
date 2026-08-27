"""Generate a demo album and matching selfie frames.

    python -m faceapp_worker.demo.build --out /tmp/demo-album

The source is the group photograph bundled with InsightFace for its own smoke
tests. It contains six distinct, clearly detectable faces, which is exactly what
a demo needs: real faces, real embeddings, and a ground truth we know because we
constructed the crops.

**This is a demo fixture, not an evaluation set.** Six people and a handful of
derived frames cannot measure precision to two decimal places, which is why it
sets no thresholds and why `eval.select_thresholds` would refuse it. See
ml/eval/README.md for what a real labeled album looks like.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageEnhance

# Face boxes in the 1280x886 source, left to right, from SCRFD.
PEOPLE: list[dict[str, object]] = [
    {"name": "guest-a", "box": (59, 259, 109, 138)},
    {"name": "guest-b", "box": (268, 146, 104, 121)},
    {"name": "guest-c", "box": (466, 269, 108, 147)},
    {"name": "guest-d", "box": (745, 339, 100, 140)},
    {"name": "guest-e", "box": (903, 63, 110, 142)},
    {"name": "guest-f", "box": (1133, 269, 94, 129)},
]

# Album shots, as (left, top, right, bottom) windows on the source. Each one
# contains a different subset of the six, so a search has something to be right
# and wrong about.
SHOTS: list[dict[str, object]] = [
    {"name": "wide-01", "window": (0, 0, 1280, 886), "brightness": 1.0, "scale": 1.0},
    {"name": "wide-02", "window": (0, 0, 1280, 886), "brightness": 1.18, "scale": 0.8},
    {"name": "left-01", "window": (0, 60, 640, 700), "brightness": 1.0, "scale": 1.0},
    {"name": "left-02", "window": (20, 80, 620, 680), "brightness": 0.82, "scale": 1.1},
    {"name": "right-01", "window": (640, 0, 1280, 700), "brightness": 1.0, "scale": 1.0},
    {"name": "right-02", "window": (660, 20, 1260, 680), "brightness": 1.12, "scale": 0.9},
    {"name": "centre-01", "window": (350, 80, 950, 640), "brightness": 1.0, "scale": 1.0},
    {"name": "centre-02", "window": (380, 100, 920, 620), "brightness": 0.9, "scale": 1.15},
    {"name": "pair-01", "window": (820, 0, 1280, 560), "brightness": 1.05, "scale": 1.0},
    {"name": "pair-02", "window": (0, 180, 460, 700), "brightness": 0.95, "scale": 1.0},
]


def _source() -> Image.Image:
    from insightface.data import get_image

    return Image.fromarray(get_image("t1", to_rgb=True))


def _apply(image: Image.Image, brightness: float, scale: float) -> Image.Image:
    out = ImageEnhance.Brightness(image).enhance(brightness)
    if scale != 1.0:
        out = out.resize((max(1, round(out.width * scale)), max(1, round(out.height * scale))))
    return out


def _people_in(window: tuple[int, int, int, int]) -> list[str]:
    """Whose face centre falls inside this window. The ground truth."""
    left, top, right, bottom = window
    present = []
    for person in PEOPLE:
        x, y, w, h = person["box"]  # type: ignore[misc]
        # Require the whole box, not just the centre: a face clipped in half is
        # not reliably a photograph of that person.
        if left <= x and top <= y and x + w <= right and y + h <= bottom:
            present.append(str(person["name"]))
    return present


def build(out_dir: Path, *, selfie_of: str = "guest-c") -> dict[str, object]:
    out_dir = Path(out_dir)
    photos_dir = out_dir / "photos"
    selfies_dir = out_dir / "selfies"
    photos_dir.mkdir(parents=True, exist_ok=True)
    selfies_dir.mkdir(parents=True, exist_ok=True)

    source = _source()
    truth: dict[str, list[str]] = {}

    for shot in SHOTS:
        window = shot["window"]  # type: ignore[assignment]
        cropped = source.crop(window)  # type: ignore[arg-type]
        image = _apply(cropped, float(shot["brightness"]), float(shot["scale"]))  # type: ignore[arg-type]
        name = f"{shot['name']}.jpg"
        image.save(photos_dir / name, quality=90)
        truth[name] = _people_in(window)  # type: ignore[arg-type]

    person = next(p for p in PEOPLE if p["name"] == selfie_of)
    x, y, w, h = person["box"]  # type: ignore[misc]
    # A selfie is a head-and-shoulders frame, so pad well beyond the face box.
    pad_x, pad_y = int(w * 1.1), int(h * 0.9)

    for i, (dx, dy, bright) in enumerate(
        [(0, 0, 1.0), (-8, 6, 1.1), (10, -5, 0.92)]
    ):
        box = (
            max(0, x - pad_x + dx),
            max(0, y - pad_y + dy),
            min(source.width, x + w + pad_x + dx),
            min(source.height, y + h + pad_y + dy),
        )
        frame = _apply(source.crop(box), bright, 1.6)
        frame.save(selfies_dir / f"frame-{i}.jpg", quality=92)

    manifest = {
        "note": (
            "Demo fixture built from the InsightFace sample photograph. "
            "Six people, ten derived shots. Not an evaluation set — far too "
            "small to measure precision, and it sets no thresholds."
        ),
        "selfie_of": selfie_of,
        "people": [p["name"] for p in PEOPLE],
        "expected_matches": sorted(k for k, v in truth.items() if selfie_of in v),
        "truth": truth,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="faceapp_worker.demo.build", description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--selfie-of", default="guest-c")
    args = parser.parse_args(argv)

    manifest = build(args.out, selfie_of=args.selfie_of)
    print(f"wrote {args.out}")
    print(f"selfie of {manifest['selfie_of']}")
    print(f"should match {len(manifest['expected_matches'])} of {len(SHOTS)} photos:")
    for name in manifest["expected_matches"]:  # type: ignore[union-attr]
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
