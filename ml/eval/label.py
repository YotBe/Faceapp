"""Turn a folder of photographs into a labeled evaluation set.

    python -m eval.label init ~/albums/rooftop --out eval/datasets/rooftop-2026
    python -m eval.label review --dataset eval/datasets/rooftop-2026
    python -m eval.label export --dataset eval/datasets/rooftop-2026

This exists because of one sentence in `eval/README.md`: *"for each of twenty
people, go through the album and record every photograph they appear in."* For
five hundred photographs that is hours of typing into a CSV, and it is the
reason this project has never had a measured threshold. The model can propose
the groupings in seconds; a human then confirms, corrects and — the part that
matters — adds what the model missed.

Runs entirely on a laptop. No database, no upload, no deployment. The review UI
is served from 127.0.0.1 so it can save your work back to disk; nothing leaves
the machine.

## The circularity problem

Grouping faces with the model's own embeddings and then measuring that model
against the result measures the model against its own opinions. Recall would
look superb, because every face the detector missed and every face the quality
gate rejected is invisible to labels derived from detections. A threshold
measured that way is worse than no threshold: it carries a number that looks
earned.

So the grouping here is a typing aid and nothing else, and four things enforce
that rather than merely asserting it:

  1. No group becomes a label until a human names it. Rejecting and splitting
     are one click each; accepting in bulk is not offered.
  2. The **misses** screen exists. For each person it shows the photographs the
     grouping did *not* give them — the highest-scoring unassigned ones, where
     near-misses concentrate, plus a random sample of the rest so the estimate
     is not purely adversarial. Adding what it missed is what makes recall mean
     anything.
  3. Every (photo, person) pair records how it got there: `cluster`,
     `human_added` or `human_removed`. The totals go into `dataset.toml`.
  4. `eval.run` refuses a dataset whose `human_added` count is zero. A human who
     added nothing rubber-stamped the model, and the recall figure from that is
     fiction. See `dataset.LabellingProvenance`.

## Photographs are not copied

`photos.csv` carries paths relative to the dataset directory, pointing back at
your album where it already lives. Copying would duplicate several gigabytes and
put a second copy of other people's faces somewhere you will forget about. The
same rule in `docs/COMPLIANCE.md` applies to the copy on your laptop: delete the
album, the dataset directory and `eval/cache/` when you are done.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys
import webbrowser
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import NamedTuple

import numpy as np

from faceapp_ml.clustering import dbscan_cosine
from faceapp_ml.embeddings import average_embeddings, l2_normalize
from faceapp_ml.quality import QualityPolicy

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}

STATE_VERSION = 1

# Provisional grouping distance, in cosine-distance units (1 - similarity).
#
# Tighter than anything the product would use to tell an attendee "this is you",
# and that is deliberate. Over-splitting is the safe failure here: merging two
# groups of the same person is one click, whereas a group that silently absorbed
# a stranger produces a wrong label that nobody will ever look at again.
#
# It is not derived from T_high, because T_high does not exist yet — measuring it
# is the entire point of the dataset this tool produces.
DEFAULT_EPS = 0.45
MIN_GROUP_SIZE = 2

# Candidates offered per person on the misses screen.
TOP_CANDIDATES = 40
RANDOM_CANDIDATES = 15

THUMB_PX = 160
FACE_THUMB_PX = 128


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


@dataclass
class State:
    """Everything the review UI reads and writes, as one JSON document.

    Held as a file rather than a database because the whole point is that this
    runs on a laptop against a folder, and because a half-finished labelling
    session should survive closing the laptop.
    """

    version: int
    album: str
    dataset_id: str
    engine: str
    policy: dict
    eps: float
    photos: list[dict]  # {id, path, thumb, w, h}
    faces: list[dict]  # {id, photo, group, thumb, tier, det_score, face_px}
    groups: list[dict]  # {id, faces: [face_id], person: str|null, dropped: bool}
    people: dict  # person_id -> {name, selfies: [path]}
    # (photo_id, person_id) -> "cluster" | "human_added"; removals are recorded
    # rather than deleted, so the export can report how much the human changed.
    labels: dict
    removed: dict
    done: dict = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> State:
        with path.open(encoding="utf-8") as fh:
            raw = json.load(fh)
        if raw.get("version") != STATE_VERSION:
            raise SystemExit(
                f"{path} was written by a different version of eval.label "
                f"(found {raw.get('version')}, expected {STATE_VERSION}). "
                "Re-run `init` into a fresh directory."
            )
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in raw.items() if k in known})

    def save(self, path: Path) -> None:
        tmp = path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(self.__dict__, fh, indent=1)
        # Atomic, because the UI saves on every click and a truncated state file
        # is an afternoon of labelling gone.
        tmp.replace(path)


# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------


def _find_images(root: Path) -> list[Path]:
    return sorted(
        p
        for p in root.rglob("*")
        if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES and not p.name.startswith(".")
    )


def _load_rgb(path: Path) -> np.ndarray:
    from PIL import Image, ImageOps

    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        return np.asarray(im.convert("RGB"), dtype=np.uint8)


def _write_thumb(image: np.ndarray, out: Path, longest: int) -> None:
    from PIL import Image

    out.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(image)
    im.thumbnail((longest, longest))
    im.save(out, format="JPEG", quality=78)


def _crop(image: np.ndarray, bbox, margin: float = 0.35) -> np.ndarray:
    h, w = image.shape[:2]
    pad_x, pad_y = bbox.w * margin, bbox.h * margin
    x0 = max(0, int(bbox.x - pad_x))
    y0 = max(0, int(bbox.y - pad_y))
    x1 = min(w, int(bbox.x + bbox.w + pad_x))
    y1 = min(h, int(bbox.y + bbox.h + pad_y))
    if x1 <= x0 or y1 <= y0:
        return image
    return image[y0:y1, x0:x1]


def cmd_init(args: argparse.Namespace) -> int:
    album = Path(args.album).expanduser().resolve()
    out = Path(args.out).expanduser().resolve()

    if not album.is_dir():
        raise SystemExit(f"{album} is not a directory")

    images = _find_images(album)
    if not images:
        raise SystemExit(f"no images under {album}")

    state_path = out / "state.json"
    if state_path.exists() and not args.force:
        raise SystemExit(
            f"{state_path} already exists. `review` continues it; --force starts over "
            "and discards every labelling decision in it."
        )

    policy = QualityPolicy.load(args.quality_config)

    from faceapp_ml.engine import InsightFaceEngine

    engine = InsightFaceEngine()

    print(f"==> {len(images)} photograph(s) under {album}")
    print(f"==> detecting and embedding with {engine.name}")

    thumbs = out / "thumbs"
    if thumbs.exists():
        shutil.rmtree(thumbs)

    photos: list[dict] = []
    faces: list[dict] = []
    embeddings: list[np.ndarray] = []
    rejected = 0

    for i, path in enumerate(images):
        if i % 25 == 0:
            print(f"    {i}/{len(images)}", flush=True)
        try:
            image = _load_rgb(path)
        except OSError as exc:
            print(f"    !! skipping {path.name}: {exc}", file=sys.stderr)
            continue

        photo_id = f"p{len(photos):05d}"
        found, stats = engine.detect_and_embed(image, policy=policy)
        rejected += stats.rejected

        _write_thumb(image, thumbs / f"{photo_id}.jpg", THUMB_PX)
        photos.append(
            {
                "id": photo_id,
                "path": os.path.relpath(path, out),
                "name": path.name,
                "thumb": f"thumbs/{photo_id}.jpg",
                "w": int(image.shape[1]),
                "h": int(image.shape[0]),
                "detected": stats.detected,
                "rejected": stats.rejected,
            }
        )

        for face in found:
            face_id = f"f{len(faces):05d}"
            _write_thumb(
                _crop(image, face.detection.bbox), thumbs / f"{face_id}.jpg", FACE_THUMB_PX
            )
            bbox = face.detection.bbox
            faces.append(
                {
                    "id": face_id,
                    "photo": photo_id,
                    "group": None,
                    "thumb": f"thumbs/{face_id}.jpg",
                    "tier": int(face.quality.tier),
                    "det_score": round(float(face.detection.det_score), 3),
                    "face_px": int(face.detection.face_px),
                    # Kept so `export` can cut a full-resolution enrolment image
                    # rather than enrolling from a 128px review thumbnail.
                    "bbox": [float(bbox.x), float(bbox.y), float(bbox.w), float(bbox.h)],
                }
            )
            embeddings.append(face.embedding)

    if not faces:
        raise SystemExit(
            "no face survived the quality gate in any photograph. Either the album is "
            "not what you think it is, or ml/config/quality.toml is far too strict."
        )

    matrix = np.stack(embeddings).astype(np.float32)
    labels = dbscan_cosine(matrix, eps=args.eps, min_samples=MIN_GROUP_SIZE)

    groups: list[dict] = []
    by_label: dict[int, list[str]] = {}
    for face, label in zip(faces, labels, strict=True):
        if label < 0:
            continue
        by_label.setdefault(int(label), []).append(face["id"])

    # Biggest first: the people who appear most are the ones worth labelling, and
    # they are also the ones whose groups are least ambiguous.
    for label in sorted(by_label, key=lambda k: -len(by_label[k])):
        group_id = f"g{len(groups):04d}"
        groups.append({"id": group_id, "faces": by_label[label], "person": None, "dropped": False})
        for face_id in by_label[label]:
            next(f for f in faces if f["id"] == face_id)["group"] = group_id

    np.save(out / "embeddings.npy", matrix)

    state = State(
        version=STATE_VERSION,
        album=str(album),
        dataset_id=args.dataset_id or out.name,
        engine=engine.name,
        policy={
            "min_face_px": policy.min_face_px,
            "min_det_score": policy.min_det_score,
            "good_face_px": policy.good_face_px,
            "good_det_score": policy.good_det_score,
            "max_yaw_deg": policy.max_yaw_deg,
            "min_blur_score": policy.min_blur_score,
        },
        eps=float(args.eps),
        photos=photos,
        faces=faces,
        groups=groups,
        people={},
        labels={},
        removed={},
    )
    state.save(state_path)

    grouped = sum(len(g["faces"]) for g in groups)
    print()
    print(f"    {len(photos):,} photographs, {len(faces):,} faces past the quality gate")
    print(f"    {rejected:,} detections rejected by it (tier 0 — never embedded)")
    print(f"    {len(groups):,} provisional groups covering {grouped:,} faces")
    print(f"    {len(faces) - grouped:,} faces in no group; they show up as candidates")
    print()
    print(f"    next:  python -m eval.label review --dataset {args.out}")
    return 0


# ---------------------------------------------------------------------------
# review
# ---------------------------------------------------------------------------


def _candidates(state: State, out: Path, person_id: str, seed: int = 20260828) -> list[dict]:
    """Photographs this person is *not* labeled in, ranked by best face similarity.

    The whole reason the misses screen is not busywork: a face the grouping put
    in nobody's group, or in the wrong one, is exactly the appearance whose
    absence would inflate recall. Ranking by similarity puts those first. The
    random tail is there so the sample is not purely adversarial — if the top
    forty are all correct rejections and a random fifteen are too, the label set
    is probably complete, and that is a claim worth being able to make.
    """
    matrix = np.load(out / "embeddings.npy")
    face_ids = [f["id"] for f in state.faces]
    index_of = {fid: i for i, fid in enumerate(face_ids)}

    assigned = {fid for fid, f in zip(face_ids, state.faces, strict=True)
                if f["group"] and _group(state, f["group"])["person"] == person_id}
    if not assigned:
        return []

    template = average_embeddings([matrix[index_of[fid]] for fid in assigned])
    scores = matrix @ l2_normalize(template)

    labelled = {p for (p, q) in (k.split("|") for k in state.labels) if q == person_id}

    best: dict[str, float] = {}
    for face, score in zip(state.faces, scores, strict=True):
        photo = face["photo"]
        if photo in labelled:
            continue
        best[photo] = max(best.get(photo, -1.0), float(score))

    ranked = sorted(best.items(), key=lambda kv: -kv[1])
    top = ranked[:TOP_CANDIDATES]

    rest = [p for p, _ in ranked[TOP_CANDIDATES:]]
    # Photographs with no face at all never enter `best`, and they are precisely
    # where a tier-0 rejection hides a real appearance. Include them in the pool
    # the random sample draws from.
    faceless = [p["id"] for p in state.photos if p["id"] not in best and p["id"] not in labelled]
    pool = rest + faceless
    rng = random.Random(f"{seed}-{person_id}")
    sample = rng.sample(pool, min(RANDOM_CANDIDATES, len(pool)))

    photo_by_id = {p["id"]: p for p in state.photos}
    return (
        [
            {"photo": pid, "thumb": photo_by_id[pid]["thumb"], "score": round(s, 3), "why": "near"}
            for pid, s in top
        ]
        + [
            {
                "photo": pid,
                "thumb": photo_by_id[pid]["thumb"],
                "score": round(best.get(pid, float("nan")), 3) if pid in best else None,
                "why": "random",
            }
            for pid in sample
        ]
    )


def _group(state: State, group_id: str) -> dict:
    return next(g for g in state.groups if g["id"] == group_id)


def _recompute_cluster_labels(state: State) -> None:
    """Rebuild the model-proposed labels from the current group -> person map.

    Kept separate from the human's additions and removals, which is the whole
    point: `labels` distinguishes what the model claimed from what a person
    actually asserted, and the export reports the ratio.
    """
    photo_by_face = {f["id"]: f["photo"] for f in state.faces}

    proposed: set[tuple[str, str]] = set()
    for group in state.groups:
        person = group["person"]
        if not person or group["dropped"]:
            continue
        for face_id in group["faces"]:
            proposed.add((photo_by_face[face_id], person))

    human = {k: v for k, v in state.labels.items() if v == "human_added"}

    labels = {f"{photo}|{person}": "cluster" for photo, person in proposed}
    labels.update(human)
    for key in state.removed:
        labels.pop(key, None)
    state.labels = labels


def cmd_review(args: argparse.Namespace) -> int:
    out = Path(args.dataset).expanduser().resolve()
    state_path = out / "state.json"
    if not state_path.exists():
        raise SystemExit(f"no state.json in {out}. Run `eval.label init` first.")

    state = State.load(state_path)
    _recompute_cluster_labels(state)
    state.save(state_path)

    page = (Path(__file__).resolve().parent / "review.html").read_text(encoding="utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # a local tool does not need a request log

        def _send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            path = self.path.split("?")[0]
            if path in ("/", "/index.html"):
                self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
                return
            if path == "/state":
                current = State.load(state_path)
                self._send(200, json.dumps(current.__dict__).encode(), "application/json")
                return
            if path.startswith("/candidates/"):
                person = path[len("/candidates/") :]
                current = State.load(state_path)
                body = json.dumps(_candidates(current, out, person)).encode()
                self._send(200, body, "application/json")
                return
            if path.startswith("/thumbs/") or path.startswith("/full/"):
                self._serve_file(path)
                return
            self._send(404, b"not found", "text/plain")

        def _serve_file(self, path: str) -> None:
            if path.startswith("/thumbs/"):
                target = (out / path.lstrip("/")).resolve()
                root = (out / "thumbs").resolve()
            else:
                current = State.load(state_path)
                photo_id = path[len("/full/") :]
                photo = next((p for p in current.photos if p["id"] == photo_id), None)
                if photo is None:
                    self._send(404, b"no such photo", "text/plain")
                    return
                target = (out / photo["path"]).resolve()
                root = Path(current.album).resolve()
            # The browser is local and so is the album, but this handler still
            # takes a path from a URL and turns it into a file read. Confining it
            # costs one line.
            if not target.is_file() or not target.is_relative_to(root):
                self._send(404, b"not found", "text/plain")
                return
            suffix = target.suffix.lower()
            kind = "image/png" if suffix == ".png" else "image/jpeg"
            self._send(200, target.read_bytes(), kind)

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            current = State.load(state_path)
            try:
                _apply(current, self.path, payload)
            except (KeyError, StopIteration, ValueError) as exc:
                self._send(400, json.dumps({"error": str(exc)}).encode(), "application/json")
                return
            _recompute_cluster_labels(current)
            current.save(state_path)
            self._send(200, json.dumps({"ok": True}).encode(), "application/json")

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"==> {state.dataset_id}: {len(state.photos):,} photographs, "
          f"{len(state.groups):,} groups")
    print(f"==> {url}")
    print("    everything you do is saved to state.json as you go. Ctrl-C when finished.")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n    stopped. `export` when you are ready.")
    return 0


def _apply(state: State, route: str, payload: dict) -> None:
    """Mutate state from one UI action. Every branch here is a human decision."""
    if route == "/name-group":
        group = _group(state, payload["group"])
        person_id = (payload.get("person") or "").strip()
        if person_id:
            state.people.setdefault(person_id, {"name": person_id, "selfies": []})
        group["person"] = person_id or None
        group["dropped"] = False

    elif route == "/drop-group":
        group = _group(state, payload["group"])
        group["dropped"] = bool(payload.get("dropped", True))
        if group["dropped"]:
            group["person"] = None

    elif route == "/move-face":
        # Splitting a group: the human says this face is not that person.
        face = next(f for f in state.faces if f["id"] == payload["face"])
        target = payload.get("group")
        if target:
            _group(state, target)["faces"].append(face["id"])
        source = face["group"]
        if source:
            _group(state, source)["faces"].remove(face["id"])
        face["group"] = target

    elif route == "/add-label":
        key = f"{payload['photo']}|{payload['person']}"
        state.labels[key] = "human_added"
        state.removed.pop(key, None)

    elif route == "/remove-label":
        key = f"{payload['photo']}|{payload['person']}"
        state.removed[key] = "human_removed"
        state.labels.pop(key, None)

    elif route == "/set-selfies":
        person = state.people.setdefault(
            payload["person"], {"name": payload["person"], "selfies": []}
        )
        person["selfies"] = list(payload.get("selfies", []))

    elif route == "/mark-done":
        state.done[payload["what"]] = bool(payload.get("done", True))

    else:
        raise ValueError(f"unknown action {route}")


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------


def _csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    import csv

    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        writer.writerows(rows)


class _Box(NamedTuple):
    """bbox as stored in state.json, in the shape `_crop` expects."""

    x: float
    y: float
    w: float
    h: float


def _write_selfies(state: State, out: Path, person: str) -> tuple[list[str], set[str]]:
    """Return (relative selfie paths, photo ids to hold out of the evaluation).

    Real selfies, if you have them, are better and are preferred: drop them in
    `selfies/<person>/` and nothing is held out. Otherwise the enrolment image is
    cut from the album at full resolution — and then **the photograph it came
    from leaves the evaluation entirely**.

    That holdout is not fussiness. Scoring a query against the very image it was
    cut from produces a similarity of essentially 1.0 and a guaranteed hit, which
    would flatter both precision and recall at exactly the thresholds being
    chosen. Dropping three photographs out of several hundred costs nothing;
    leaving the leak in would quietly invalidate the number this whole exercise
    exists to produce.
    """
    folder = out / "selfies" / person
    if folder.is_dir():
        existing = sorted(
            f for f in folder.iterdir()
            if f.is_file() and f.suffix.lower() in IMAGE_SUFFIXES
        )
        if existing:
            return [os.path.relpath(f, out) for f in existing], set()

    chosen = (state.people.get(person) or {}).get("selfies", [])
    if not chosen:
        return [], set()

    by_id = {f["id"]: f for f in state.faces}
    photo_by_id = {p["id"]: p for p in state.photos}

    paths: list[str] = []
    held_out: set[str] = set()
    for n, face_id in enumerate(chosen, start=1):
        face = by_id.get(face_id)
        if face is None:
            continue
        source = photo_by_id[face["photo"]]
        image = _load_rgb((out / source["path"]).resolve())
        # A wider margin than the review thumbnail: an enrolment frame is a head
        # and shoulders, not a tight face crop, and that is what the camera path
        # actually hands the engine.
        crop = _crop(image, _Box(*face["bbox"]), margin=0.6)
        target = out / "selfies" / f"{person}-{n}.jpg"
        target.parent.mkdir(parents=True, exist_ok=True)
        from PIL import Image

        Image.fromarray(crop).save(target, format="JPEG", quality=92)
        paths.append(os.path.relpath(target, out))
        held_out.add(face["photo"])

    return paths, held_out


def cmd_export(args: argparse.Namespace) -> int:
    out = Path(args.dataset).expanduser().resolve()
    state = State.load(out / "state.json")
    _recompute_cluster_labels(state)

    named = sorted(
        {g["person"] for g in state.groups if g["person"] and not g["dropped"]}
        | {k.split("|")[1] for k in state.labels}
    )
    if not named:
        raise SystemExit(
            "nobody has been named yet. Run `review` and name at least a few groups."
        )

    problems: list[str] = []
    selfie_rows: list[list[str]] = []
    held_out: set[str] = set()

    for person in named:
        paths, holds = _write_selfies(state, out, person)
        if not paths:
            problems.append(
                f"{person}: no enrolment image. Pick three faces on the selfies screen, "
                f"or put real selfies in selfies/{person}/. A person we cannot enroll "
                "cannot be evaluated."
            )
            continue
        held_out |= holds
        selfie_rows.extend([person, path] for path in paths)

    photos = [p for p in state.photos if p["id"] not in held_out]
    labels = {k: v for k, v in state.labels.items() if k.split("|")[0] not in held_out}

    # A correction made in a photograph that later became an enrolment source
    # leaves with it. On a small album that can take away every correction at
    # once, and "you added nothing" would then be a lie that sends someone back
    # to a screen they already finished. Count both sides so the message below
    # can say which of the two actually happened.
    added_before_holdout = sum(v == "human_added" for v in state.labels.values())

    label_rows = sorted([k.split("|")[0], k.split("|")[1]] for k in labels)
    counts = {"cluster": 0, "human_added": 0}
    for source in labels.values():
        counts[source] = counts.get(source, 0) + 1

    for person in named:
        if not any(row[1] == person for row in label_rows):
            problems.append(
                f"{person}: named but appears in no photograph that is still in the "
                "evaluation set. Label some appearances, or drop them."
            )

    if problems:
        print("These have to be fixed before the dataset can be used:\n", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    _csv(out / "photos.csv", ["photo_id", "path"], [[p["id"], p["path"]] for p in photos])
    _csv(out / "labels.csv", ["photo_id", "person_id"], label_rows)
    _csv(out / "selfies.csv", ["person_id", "path"], selfie_rows)

    total = counts["cluster"] + counts["human_added"]
    manifest = f'''# Written by `python -m eval.label export`. Change the labels in the review
# UI rather than here: the [labelling] counts below have to keep describing the
# CSVs beside them, and eval.run reads them.

id = "{state.dataset_id}"
kind = "real"
description = "Labelled from {len(photos)} photographs with cluster-assisted review."

[labelling]
# How each (photo, person) pair got here. `human_added` is the number that
# matters: appearances the model did not propose and a person asserted anyway.
# Zero of them means the labels describe what the model already believed, and
# recall measured against that is not a measurement — eval.run refuses it.
tool = "eval.label"
engine = "{state.engine}"
eps = {state.eps}
from_clusters = {counts["cluster"]}
human_added = {counts["human_added"]}
human_removed = {len(state.removed)}
# Photographs an enrolment image was cut from, dropped so no query is ever
# scored against the image it came from.
held_out_photos = {len(held_out)}
'''
    (out / "dataset.toml").write_text(manifest, encoding="utf-8")

    print(f"==> {out}")
    print(f"    {len(photos):,} photographs, {len(named)} people, {total:,} labeled appearances")
    print(f"    {counts['cluster']:,} proposed by grouping, "
          f"{counts['human_added']:,} added by you, {len(state.removed):,} removed")
    if held_out:
        print(f"    {len(held_out)} photograph(s) held out as enrolment sources")
    if counts["human_added"] == 0:
        print()
        if added_before_holdout:
            print(
                f"    !! All {added_before_holdout} of your corrections were in "
                "photographs that\n"
                "       were then held out as enrolment sources, so none of them "
                "reached\n"
                "       the dataset. Choose enrolment faces from photographs you did "
                "not\n"
                "       correct, or add corrections in other photographs.",
                file=sys.stderr,
            )
        else:
            print(
                "    !! You added nothing the grouping did not already propose.\n"
                "       Work through the misses screen for each person.",
                file=sys.stderr,
            )
        print(
            "\n       eval.run refuses this dataset either way, and is right to: "
            "recall\n"
            "       measured against the model's own output is not a measurement.",
            file=sys.stderr,
        )
        return 1
    print()
    print(f"    next:  python -m eval.run --dataset {args.dataset}")
    return 0


# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="eval.label", description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="detect, embed and group an album")
    init.add_argument("album", help="folder of photographs")
    init.add_argument("--out", required=True, help="dataset directory to create")
    init.add_argument("--dataset-id", default=None)
    init.add_argument(
        "--eps",
        type=float,
        default=DEFAULT_EPS,
        help=f"provisional grouping distance (default {DEFAULT_EPS}); "
        "lower splits more, which is the safe direction",
    )
    init.add_argument("--quality-config", type=Path, default=None)
    init.add_argument("--force", action="store_true", help="discard an existing state.json")
    init.set_defaults(func=cmd_init)

    review = sub.add_parser("review", help="name groups, find misses, pick selfies")
    review.add_argument("--dataset", required=True)
    review.add_argument("--port", type=int, default=8765)
    review.add_argument("--no-browser", action="store_true")
    review.set_defaults(func=cmd_review)

    export = sub.add_parser("export", help="write the dataset CSVs")
    export.add_argument("--dataset", required=True)
    export.set_defaults(func=cmd_export)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
