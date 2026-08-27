"""Derivative generation and storage-key safety.

The watermark and the key validation are both security-relevant rather than
cosmetic: one is what stops an album being scraped before the photographs are
released, the other is what stops a crafted key reading files outside the bucket.
"""

from __future__ import annotations

import io
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from faceapp_worker.images import (
    load_rgb,
    make_thumbnail,
    make_watermarked_preview,
    taken_at,
)
from faceapp_worker.storage import LocalStorage, UnsafeKeyError


def photo(width: int = 900, height: int = 600, seed: int = 0) -> Image.Image:
    rng = np.random.default_rng(seed)
    return Image.fromarray(
        rng.integers(60, 200, size=(height, width, 3), dtype=np.uint8)
    )


# ---------------------------------------------------------------------------
# Derivatives
# ---------------------------------------------------------------------------


def test_thumbnail_fits_the_long_edge_and_keeps_the_aspect_ratio() -> None:
    thumb = Image.open(io.BytesIO(make_thumbnail(photo(1600, 900), 400)))
    assert max(thumb.size) == 400
    assert abs(thumb.width / thumb.height - 1600 / 900) < 0.02


def test_a_small_photo_is_not_upscaled() -> None:
    """Blowing a 200px photo up to 1400px makes the file bigger and the image no
    better, and on a 100k-photo album that is real storage."""
    preview = Image.open(
        io.BytesIO(make_watermarked_preview(photo(200, 150), 1400, "X"))
    )
    assert preview.size == (200, 150)


def test_the_watermark_actually_changes_the_pixels() -> None:
    source = photo(800, 600, seed=1)
    marked = Image.open(io.BytesIO(make_watermarked_preview(source, 800, "EVENT")))
    difference = np.abs(
        np.asarray(marked, dtype=np.int16) - np.asarray(source, dtype=np.int16)
    )
    assert difference.mean() > 1.0, "the preview came back effectively unmarked"


def test_the_watermark_covers_the_whole_frame_not_just_a_corner() -> None:
    """A corner mark is cropped off in seconds."""
    source = photo(800, 600, seed=2)
    marked = np.asarray(
        Image.open(io.BytesIO(make_watermarked_preview(source, 800, "EVENT"))),
        dtype=np.int16,
    )
    difference = np.abs(marked - np.asarray(source, dtype=np.int16)).mean(axis=2)

    h, w = difference.shape
    quadrants = [
        difference[: h // 2, : w // 2],
        difference[: h // 2, w // 2 :],
        difference[h // 2 :, : w // 2],
        difference[h // 2 :, w // 2 :],
    ]
    assert all(q.max() > 2.0 for q in quadrants), "some quadrant is unmarked"


def test_the_preview_is_still_recognisable() -> None:
    """The attendee has to be able to recognise themselves in it, so the mark is
    deliberately light. Too heavy and the preview stops doing its job."""
    source = photo(800, 600, seed=3)
    marked = np.asarray(
        Image.open(io.BytesIO(make_watermarked_preview(source, 800, "EVENT"))),
        dtype=np.int16,
    )
    difference = np.abs(marked - np.asarray(source, dtype=np.int16)).mean()
    assert difference < 40, "the watermark has obliterated the photograph"


# ---------------------------------------------------------------------------
# EXIF
# ---------------------------------------------------------------------------


def test_capture_time_is_read_from_exif(tmp_path: Path) -> None:
    path = tmp_path / "shot.jpg"
    image = photo(200, 200)
    exif = image.getexif()
    exif[36867] = "2026:07:04 21:15:30"
    image.save(path, exif=exif)

    assert taken_at(path) == datetime(2026, 7, 4, 21, 15, 30, tzinfo=UTC)


def test_a_photo_without_exif_is_not_an_error(tmp_path: Path) -> None:
    path = tmp_path / "plain.png"
    photo(100, 100).save(path)
    assert taken_at(path) is None


def test_a_corrupt_file_does_not_take_the_worker_down(tmp_path: Path) -> None:
    path = tmp_path / "broken.jpg"
    path.write_bytes(b"this is not a JPEG")
    assert taken_at(path) is None


def test_load_rgb_normalises_mode(tmp_path: Path) -> None:
    path = tmp_path / "grey.png"
    Image.fromarray(np.full((50, 60), 128, dtype=np.uint8)).save(path)
    loaded = load_rgb(path)
    assert loaded.mode == "RGB"
    assert loaded.size == (60, 50)


# ---------------------------------------------------------------------------
# Storage keys
# ---------------------------------------------------------------------------


def test_a_key_cannot_escape_its_bucket(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path, "event-photos")
    for key in ["../outside.jpg", "a/../../b.jpg", "/etc/passwd", "", "with\0null"]:
        with pytest.raises(UnsafeKeyError):
            storage.path(key)


def test_ordinary_keys_resolve_inside_the_bucket(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path, "event-photos")
    resolved = storage.path("2f3a/originals/deadbeef.jpg")
    assert resolved.is_relative_to(tmp_path / "event-photos")


def test_round_trip(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path, "event-photos")
    storage.write("a/b.txt", b"hello")
    assert storage.exists("a/b.txt")
    assert storage.read("a/b.txt") == b"hello"
    assert storage.delete("a/b.txt") is True
    assert storage.delete("a/b.txt") is False
