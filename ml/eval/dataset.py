"""Loading a labeled evaluation set.

The on-disk format is three CSV files and a TOML manifest, because a human being
has to sit down and produce this by hand for several hundred photographs, and
CSV is the only format they will actually fill in.

    eval/datasets/<name>/
        dataset.toml     what this is, and whether it is real
        photos.csv       photo_id,path[,lighting]
        labels.csv       photo_id,person_id      <- the ground truth
        selfies.csv      person_id,path          <- one row per selfie frame

`labels.csv` is the tedious part and there is no way around it. One row for
every (photograph, person) pair where that person is visible. For twenty people
across five hundred photographs that is a couple of hours of work, once.

`dataset.toml` carries `kind`, which is either "real" or "synthetic". Thresholds
can only be written from a real one — see faceapp_ml.config.
"""

from __future__ import annotations

import csv
import tomllib
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path


class DatasetError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class PhotoSpec:
    photo_id: str
    path: Path
    lighting: str | None = None  # free-text slice label, e.g. "indoor" / "backlit"


@dataclass(frozen=True, slots=True)
class PersonSpec:
    person_id: str
    selfie_paths: tuple[Path, ...]


@dataclass(slots=True)
class LabeledDataset:
    dataset_id: str
    kind: str  # "real" | "synthetic"
    root: Path
    photos: list[PhotoSpec]
    people: list[PersonSpec]
    # person_id -> set of photo_ids they appear in
    truth: dict[str, set[str]] = field(default_factory=dict)
    description: str = ""

    @property
    def is_real(self) -> bool:
        return self.kind == "real"

    @property
    def photo_ids(self) -> list[str]:
        return [p.photo_id for p in self.photos]

    def positives(self, person_id: str) -> set[str]:
        return self.truth.get(person_id, set())

    def summary(self) -> str:
        n_labels = sum(len(v) for v in self.truth.values())
        return (
            f"{self.dataset_id} [{self.kind}]: {len(self.photos)} photos, "
            f"{len(self.people)} people, {n_labels} labeled appearances"
        )


def _read_csv(path: Path, required: tuple[str, ...]) -> list[dict[str, str]]:
    if not path.exists():
        raise DatasetError(f"missing {path.name} in {path.parent}")
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            raise DatasetError(f"{path} is empty")
        missing = [c for c in required if c not in reader.fieldnames]
        if missing:
            raise DatasetError(f"{path}: missing column(s) {missing}; found {reader.fieldnames}")
        return [row for row in reader if any(v.strip() for v in row.values() if v is not None)]


def load_dataset(root: Path | str) -> LabeledDataset:
    root = Path(root)
    manifest_path = root / "dataset.toml"
    if not manifest_path.exists():
        raise DatasetError(f"no dataset.toml in {root}")

    with manifest_path.open("rb") as fh:
        manifest = tomllib.load(fh)

    dataset_id = str(manifest.get("id") or root.name)
    kind = str(manifest.get("kind", "")).strip().lower()
    if kind not in {"real", "synthetic"}:
        raise DatasetError(
            f"{manifest_path}: kind must be 'real' or 'synthetic', got {kind!r}.\n"
            "This is not bookkeeping: thresholds derived from a synthetic set are "
            "refused by the config loader, and the distinction has to be explicit."
        )

    photos: list[PhotoSpec] = []
    seen: set[str] = set()
    for row in _read_csv(root / "photos.csv", ("photo_id", "path")):
        pid = row["photo_id"].strip()
        if pid in seen:
            raise DatasetError(f"photos.csv: duplicate photo_id {pid!r}")
        seen.add(pid)
        lighting = (row.get("lighting") or "").strip() or None
        photos.append(PhotoSpec(photo_id=pid, path=root / row["path"].strip(), lighting=lighting))

    if not photos:
        raise DatasetError("photos.csv has no rows")

    selfies: dict[str, list[Path]] = defaultdict(list)
    for row in _read_csv(root / "selfies.csv", ("person_id", "path")):
        selfies[row["person_id"].strip()].append(root / row["path"].strip())

    if not selfies:
        raise DatasetError("selfies.csv has no rows")

    people = [
        PersonSpec(person_id=pid, selfie_paths=tuple(paths))
        for pid, paths in sorted(selfies.items())
    ]

    truth: dict[str, set[str]] = defaultdict(set)
    for row in _read_csv(root / "labels.csv", ("photo_id", "person_id")):
        photo_id = row["photo_id"].strip()
        person_id = row["person_id"].strip()
        if photo_id not in seen:
            raise DatasetError(f"labels.csv references unknown photo_id {photo_id!r}")
        if person_id not in selfies:
            raise DatasetError(
                f"labels.csv references {person_id!r}, who has no selfie in selfies.csv. "
                "A person we cannot enroll cannot be evaluated."
            )
        truth[person_id].add(photo_id)

    unlabeled = [p.person_id for p in people if not truth.get(p.person_id)]
    if unlabeled:
        raise DatasetError(
            f"these people have a selfie but no labeled appearances: {unlabeled}. "
            "Recall for them would be undefined and precision would be scored against "
            "an empty truth set, which silently inflates the false-positive count."
        )

    return LabeledDataset(
        dataset_id=dataset_id,
        kind=kind,
        root=root,
        photos=photos,
        people=people,
        truth=dict(truth),
        description=str(manifest.get("description", "")),
    )
