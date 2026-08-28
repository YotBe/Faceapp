"""The labelling tool, and the gate that keeps it honest.

`eval.label` groups faces with the same model the evaluation is about to
measure. That shortcut is what makes labelling an album take minutes instead of
an afternoon, and it is also the thing that could quietly destroy the result: a
label set derived from detections cannot contain the faces the detector missed,
so recall measured against it comes out high whatever the model is worth.

Most of what is asserted here is therefore not "the export writes four files".
It is that the human's corrections survive into the CSVs distinguishable from
the model's proposals, that the count of them is carried all the way to
`select_thresholds`, and that a label set with none of them is refused.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from eval.dataset import DatasetError, load_dataset
from eval.label import State, _apply, _recompute_cluster_labels, cmd_export

# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


def write_album(root: Path, n: int = 4) -> list[Path]:
    from PIL import Image

    root.mkdir(parents=True, exist_ok=True)
    paths = []
    for i in range(n):
        path = root / f"shot{i}.jpg"
        # Distinct content per file so a mixed-up path is visible as a crop that
        # came from the wrong photograph rather than as a passing test.
        pixels = np.full((80, 120, 3), (i * 40) % 256, dtype=np.uint8)
        Image.fromarray(pixels).save(path, format="JPEG")
        paths.append(path)
    return paths


def make_state(tmp_path: Path, *, n_photos: int = 4) -> tuple[Path, Path]:
    """A dataset directory mid-review: one named group, one selfie chosen."""
    album = tmp_path / "album"
    out = tmp_path / "ds"
    out.mkdir(parents=True, exist_ok=True)
    paths = write_album(album, n_photos)

    photos = [
        {
            "id": f"p{i:05d}",
            "path": f"../album/{path.name}",
            "name": path.name,
            "thumb": f"thumbs/p{i:05d}.jpg",
            "w": 120,
            "h": 80,
            "detected": 1,
            "rejected": 0,
        }
        for i, path in enumerate(paths)
    ]
    # One face in each of the first three photographs; the fourth has none, which
    # is the case where a tier-0 rejection hides a real appearance.
    faces = [
        {
            "id": f"f{i:05d}",
            "photo": f"p{i:05d}",
            "group": "g0000",
            "thumb": f"thumbs/f{i:05d}.jpg",
            "tier": 2,
            "det_score": 0.9,
            "face_px": 60,
            "bbox": [20.0, 10.0, 50.0, 50.0],
        }
        for i in range(3)
    ]

    state = State(
        version=1,
        album=str(album),
        dataset_id="unit-album",
        engine="test-engine",
        policy={},
        eps=0.45,
        photos=photos,
        faces=faces,
        groups=[{"id": "g0000", "faces": [f["id"] for f in faces], "person": None,
                 "dropped": False}],
        people={},
        labels={},
        removed={},
    )
    state.save(out / "state.json")
    np.save(out / "embeddings.npy", np.eye(len(faces), 512, dtype=np.float32))
    return out, album


class Args:
    def __init__(self, dataset: Path) -> None:
        self.dataset = str(dataset)


# ---------------------------------------------------------------------------
# label bookkeeping
# ---------------------------------------------------------------------------


def test_naming_a_group_proposes_labels_for_its_photographs(tmp_path: Path) -> None:
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")

    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})
    _recompute_cluster_labels(state)

    assert set(state.labels) == {"p00000|alice", "p00001|alice", "p00002|alice"}
    assert set(state.labels.values()) == {"cluster"}


def test_a_human_addition_is_recorded_as_one(tmp_path: Path) -> None:
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})

    # p00003 has no detected face at all. Adding it is exactly the correction
    # that a label set derived from detections can never contain.
    _apply(state, "/add-label", {"photo": "p00003", "person": "alice"})
    _recompute_cluster_labels(state)

    assert state.labels["p00003|alice"] == "human_added"
    assert sum(v == "human_added" for v in state.labels.values()) == 1


def test_a_human_removal_survives_recomputation(tmp_path: Path) -> None:
    # The failure this guards: the group still contains the face, so rebuilding
    # cluster labels would quietly reinstate a pair a person just rejected.
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})
    _apply(state, "/remove-label", {"photo": "p00001", "person": "alice"})

    _recompute_cluster_labels(state)
    _recompute_cluster_labels(state)

    assert "p00001|alice" not in state.labels
    assert state.removed == {"p00001|alice": "human_removed"}


def test_pulling_a_face_out_of_a_group_drops_its_label(tmp_path: Path) -> None:
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})

    _apply(state, "/move-face", {"face": "f00002", "group": None})
    _recompute_cluster_labels(state)

    assert "p00002|alice" not in state.labels
    assert state.faces[2]["group"] is None


def test_dropping_a_group_removes_its_proposals(tmp_path: Path) -> None:
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})

    _apply(state, "/drop-group", {"group": "g0000", "dropped": True})
    _recompute_cluster_labels(state)

    assert state.labels == {}


def test_an_unknown_action_is_refused(tmp_path: Path) -> None:
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    with pytest.raises(ValueError, match="unknown action"):
        _apply(state, "/delete-everything", {})


def test_state_survives_a_round_trip(tmp_path: Path) -> None:
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})
    state.save(out / "state.json")

    assert State.load(out / "state.json").groups[0]["person"] == "alice"


def test_a_state_from_another_version_is_refused(tmp_path: Path) -> None:
    out, _ = make_state(tmp_path)
    path = out / "state.json"
    raw = json.loads(path.read_text())
    raw["version"] = 99
    path.write_text(json.dumps(raw))

    with pytest.raises(SystemExit, match="different version"):
        State.load(path)


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------


def prepared(tmp_path: Path) -> Path:
    """A finished review: a named group, a human addition, a chosen selfie."""
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})
    _apply(state, "/add-label", {"photo": "p00003", "person": "alice"})
    _apply(state, "/set-selfies", {"person": "alice", "selfies": ["f00000"]})
    _recompute_cluster_labels(state)
    state.save(out / "state.json")
    return out


def test_export_produces_a_dataset_the_loader_accepts(tmp_path: Path) -> None:
    out = prepared(tmp_path)

    assert cmd_export(Args(out)) == 0

    dataset = load_dataset(out)
    assert dataset.is_real
    assert [p.person_id for p in dataset.people] == ["alice"]
    # Every path in the CSVs resolves — the failure mode of relative paths is a
    # dataset that loads and then cannot open a single photograph.
    for photo in dataset.photos:
        assert photo.path.is_file(), photo.path
    for person in dataset.people:
        for selfie in person.selfie_paths:
            assert selfie.is_file(), selfie


def test_the_enrolment_source_is_held_out_of_the_album(tmp_path: Path) -> None:
    # Scoring a query against the very image it was cut from returns ~1.0 and a
    # guaranteed hit, flattering precision and recall at exactly the thresholds
    # being chosen. The photograph has to leave the evaluation entirely.
    out = prepared(tmp_path)
    cmd_export(Args(out))

    photos = (out / "photos.csv").read_text()
    labels = (out / "labels.csv").read_text()

    assert "p00000" not in photos
    assert "p00000" not in labels
    assert "p00001" in photos


def test_provenance_reaches_the_manifest_and_the_loader(tmp_path: Path) -> None:
    out = prepared(tmp_path)
    cmd_export(Args(out))

    dataset = load_dataset(out)
    assert dataset.labelling is not None
    assert dataset.labelling.tool == "eval.label"
    assert dataset.labelling.has_human_corrections
    assert dataset.labelling.human_added == 1
    # p00000 was held out with its label, leaving p00001 and p00002.
    assert dataset.labelling.from_clusters == 2
    assert dataset.labelling.held_out_photos == 1


def test_export_refuses_a_label_set_nobody_corrected(tmp_path: Path, capsys) -> None:
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})
    _apply(state, "/set-selfies", {"person": "alice", "selfies": ["f00000"]})
    _recompute_cluster_labels(state)
    state.save(out / "state.json")

    assert cmd_export(Args(out)) == 1
    assert "added nothing the grouping did not already propose" in capsys.readouterr().err


def test_export_refuses_a_person_with_no_enrolment_image(tmp_path: Path, capsys) -> None:
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})
    _apply(state, "/add-label", {"photo": "p00003", "person": "alice"})
    _recompute_cluster_labels(state)
    state.save(out / "state.json")

    assert cmd_export(Args(out)) == 1
    assert "no enrolment image" in capsys.readouterr().err


def test_real_selfies_are_preferred_and_hold_nothing_out(tmp_path: Path) -> None:
    out = prepared(tmp_path)
    write_album(out / "selfies" / "alice", 2)

    cmd_export(Args(out))

    dataset = load_dataset(out)
    assert dataset.labelling is not None
    assert dataset.labelling.held_out_photos == 0
    assert len(dataset.photos) == 4
    assert all("selfies/alice" in str(p) for p in dataset.people[0].selfie_paths)


# ---------------------------------------------------------------------------
# the manifest section itself
# ---------------------------------------------------------------------------


def test_a_hand_written_dataset_needs_no_provenance(tmp_path: Path) -> None:
    # The README's manual route is wholly human and has nothing to declare.
    # Requiring the section would make the tool mandatory, which it is not.
    root = tmp_path / "manual"
    root.mkdir()
    (root / "dataset.toml").write_text('id = "manual"\nkind = "real"\n')
    (root / "photos.csv").write_text("photo_id,path\np1,photos/1.jpg\n")
    (root / "selfies.csv").write_text("person_id,path\nalice,selfies/a.jpg\n")
    (root / "labels.csv").write_text("photo_id,person_id\np1,alice\n")

    assert load_dataset(root).labelling is None


def test_a_labelling_section_without_a_tool_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "odd"
    root.mkdir()
    (root / "dataset.toml").write_text(
        'id = "odd"\nkind = "real"\n\n[labelling]\nhuman_added = 4\n'
    )
    (root / "photos.csv").write_text("photo_id,path\np1,photos/1.jpg\n")
    (root / "selfies.csv").write_text("person_id,path\nalice,selfies/a.jpg\n")
    (root / "labels.csv").write_text("photo_id,person_id\np1,alice\n")

    with pytest.raises(DatasetError, match="needs a tool"):
        load_dataset(root)


# ---------------------------------------------------------------------------
# the gate, at the far end of the pipeline
# ---------------------------------------------------------------------------


def _report_with(labelling: dict | None, tmp_path: Path) -> Path:
    """A minimal report that would otherwise be perfectly acceptable.

    Everything except `labelling` is set up to pass: a real dataset, a sweep with
    a threshold that reaches the precision floor. So a refusal can only be about
    the provenance of the ground truth, which is the point.
    """
    report = {
        "schema": 1,
        "dataset_id": "unit",
        "dataset_kind": "real",
        "engine": "test-engine",
        "generated_at": "20260828T000000Z",
        "counts": {"photos": 100, "faces_indexed": 300, "query_people": 5,
                   "positive_pairs": 120},
        "gate": {"detected": 400, "rejected": 100, "tier1": 60, "tier2": 240,
                 "rejection_rate": 0.25, "warns": []},
        "policy": {"min_face_px": 40, "min_det_score": 0.5, "good_face_px": 70,
                   "good_det_score": 0.7, "max_yaw_deg": 40.0, "min_blur_score": 45.0},
        "unreachable_rate": 0.05,
        "confident_unreachable_rate": 0.10,
        "enrollment_failures": {},
        "labelling": labelling,
        "confident_sweep": [
            {"threshold": round(t, 2), "n_tp": 100, "n_fp": 0, "n_fn": 20,
             "precision": 1.0, "recall": 0.83, "f1": 0.91}
            for t in (0.40, 0.45, 0.50)
        ],
        "all_tier_sweep": [
            {"threshold": round(t, 2), "n_tp": 114, "n_fp": 6, "n_fn": 6,
             "precision": 0.95, "recall": 0.95, "f1": 0.95}
            for t in (0.40, 0.45, 0.50)
        ],
        "slices": None,
        "notes": [],
    }
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return path


def _select(report: Path) -> tuple[int, str]:
    import subprocess
    import sys

    done = subprocess.run(
        [sys.executable, "-m", "eval.select_thresholds", "--report", str(report)],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        check=False,
    )
    return done.returncode, done.stdout + done.stderr


@pytest.mark.slow
def test_select_thresholds_refuses_an_uncorrected_label_set(tmp_path: Path) -> None:
    code, output = _select(
        _report_with({"tool": "eval.label", "from_clusters": 120, "human_added": 0}, tmp_path)
    )

    assert code != 0
    assert "corrected by a person" in output


@pytest.mark.slow
def test_select_thresholds_accepts_a_corrected_one(tmp_path: Path) -> None:
    # The same report, with corrections. This is the control: without it the
    # test above would pass even if select_thresholds refused everything.
    code, output = _select(
        _report_with({"tool": "eval.label", "from_clusters": 108, "human_added": 12}, tmp_path)
    )

    assert code == 0, output


@pytest.mark.slow
def test_a_hand_written_report_is_not_caught_by_the_gate(tmp_path: Path) -> None:
    code, output = _select(_report_with(None, tmp_path))

    assert code == 0, output


def test_a_correction_lost_to_the_holdout_is_reported_as_such(tmp_path: Path, capsys) -> None:
    # The confusing failure: you did the misses screen, every correction you made
    # happened to be in a photograph you then picked an enrolment face from, and
    # the export tells you that you corrected nothing. On a small album that is
    # easy to hit and the message has to name the real cause.
    out, _ = make_state(tmp_path)
    state = State.load(out / "state.json")
    _apply(state, "/name-group", {"group": "g0000", "person": "alice"})
    _apply(state, "/remove-label", {"photo": "p00000", "person": "alice"})
    _apply(state, "/add-label", {"photo": "p00000", "person": "alice"})
    # ...and then enrol from a face in that same photograph.
    _apply(state, "/set-selfies", {"person": "alice", "selfies": ["f00000"]})
    _recompute_cluster_labels(state)
    state.save(out / "state.json")

    assert cmd_export(Args(out)) == 1
    assert "held out as enrolment sources" in capsys.readouterr().err
