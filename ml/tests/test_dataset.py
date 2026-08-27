"""Loading a labeled set.

Every check here exists because the corresponding mistake produces a *plausible*
evaluation rather than an error. A person with a selfie but no labels scores
every retrieval against an empty truth set and silently inflates the false
positive count; a typo in a photo id quietly drops a person's ground truth. The
loader refuses all of it up front, because a wrong threshold is much more
expensive than a rejected CSV.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from eval.dataset import DatasetError, load_dataset


def write_dataset(
    root: Path,
    *,
    kind: str = "real",
    photos: str = "photo_id,path\np1,photos/1.jpg\np2,photos/2.jpg\n",
    selfies: str = "person_id,path\nalice,selfies/alice-0.jpg\nalice,selfies/alice-1.jpg\n",
    labels: str = "photo_id,person_id\np1,alice\n",
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "dataset.toml").write_text(f'id = "unit-set"\nkind = "{kind}"\n')
    (root / "photos.csv").write_text(photos)
    (root / "selfies.csv").write_text(selfies)
    (root / "labels.csv").write_text(labels)
    return root


def test_loads_a_well_formed_dataset(tmp_path: Path) -> None:
    dataset = load_dataset(write_dataset(tmp_path / "ds"))

    assert dataset.dataset_id == "unit-set"
    assert dataset.is_real
    assert len(dataset.photos) == 2
    assert len(dataset.people) == 1
    assert dataset.people[0].selfie_paths[0].name == "alice-0.jpg"
    assert dataset.positives("alice") == {"p1"}
    assert "2 photos, 1 people" in dataset.summary()


def test_paths_are_resolved_relative_to_the_dataset(tmp_path: Path) -> None:
    root = write_dataset(tmp_path / "ds")
    dataset = load_dataset(root)
    assert dataset.photos[0].path == root / "photos/1.jpg"


def test_lighting_is_optional_and_carried_through(tmp_path: Path) -> None:
    root = write_dataset(
        tmp_path / "ds",
        photos="photo_id,path,lighting\np1,photos/1.jpg,backlit\np2,photos/2.jpg,\n",
    )
    dataset = load_dataset(root)
    assert dataset.photos[0].lighting == "backlit"
    assert dataset.photos[1].lighting is None


def test_kind_must_be_stated_explicitly(tmp_path: Path) -> None:
    """Not bookkeeping: it decides whether thresholds may be written at all."""
    root = tmp_path / "ds"
    write_dataset(root)
    (root / "dataset.toml").write_text('id = "unit-set"\n')
    with pytest.raises(DatasetError, match="kind must be"):
        load_dataset(root)


def test_a_label_for_an_unknown_photo_is_refused(tmp_path: Path) -> None:
    """A typo here silently drops ground truth and inflates recall."""
    root = write_dataset(tmp_path / "ds", labels="photo_id,person_id\np1,alice\np9,alice\n")
    with pytest.raises(DatasetError, match="unknown photo_id 'p9'"):
        load_dataset(root)


def test_a_label_for_a_person_with_no_selfie_is_refused(tmp_path: Path) -> None:
    root = write_dataset(tmp_path / "ds", labels="photo_id,person_id\np1,alice\np2,bob\n")
    with pytest.raises(DatasetError, match="'bob', who has no selfie"):
        load_dataset(root)


def test_a_person_with_no_labeled_appearance_is_refused(tmp_path: Path) -> None:
    """Their recall would be undefined and their precision scored against nothing."""
    root = write_dataset(
        tmp_path / "ds",
        selfies="person_id,path\nalice,selfies/a.jpg\nbob,selfies/b.jpg\n",
    )
    with pytest.raises(DatasetError, match="selfie but no labeled appearances"):
        load_dataset(root)


def test_duplicate_photo_ids_are_refused(tmp_path: Path) -> None:
    root = write_dataset(tmp_path / "ds", photos="photo_id,path\np1,a.jpg\np1,b.jpg\n")
    with pytest.raises(DatasetError, match="duplicate photo_id"):
        load_dataset(root)


def test_a_missing_column_names_what_it_wanted(tmp_path: Path) -> None:
    root = write_dataset(tmp_path / "ds", photos="photo_id,filename\np1,a.jpg\n")
    with pytest.raises(DatasetError, match=r"missing column\(s\) \['path'\]"):
        load_dataset(root)


def test_a_missing_file_names_itself(tmp_path: Path) -> None:
    root = write_dataset(tmp_path / "ds")
    (root / "labels.csv").unlink()
    with pytest.raises(DatasetError, match=r"missing labels\.csv"):
        load_dataset(root)


def test_a_directory_without_a_manifest_is_refused(tmp_path: Path) -> None:
    (tmp_path / "empty").mkdir()
    with pytest.raises(DatasetError, match=r"no dataset\.toml"):
        load_dataset(tmp_path / "empty")


def test_blank_lines_are_tolerated(tmp_path: Path) -> None:
    """Hand-edited CSVs pick these up; they are not worth failing on."""
    root = write_dataset(
        tmp_path / "ds", labels="photo_id,person_id\np1,alice\n\n"
    )
    assert load_dataset(root).positives("alice") == {"p1"}
