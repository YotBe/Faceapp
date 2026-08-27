"""Derivative generation: thumbnail, watermarked preview, EXIF timestamp.

The watermark is not decoration. Until an attendee has been matched and the
photographs released, everything they can see is a preview with a mark across
it, so scraping the album wholesale gets you a folder of watermarked images
rather than a wedding.
"""

from __future__ import annotations

import io
from datetime import UTC, datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

EXIF_DATETIME_ORIGINAL = 36867
EXIF_DATETIME = 306


def load_rgb(source: Path | bytes) -> Image.Image:
    """Open and orient.

    Takes bytes as well as a path, because with object storage there is no path
    — the worker has the object in memory and must not need a temporary file.

    `exif_transpose` matters more than it looks: a phone photograph carries its
    rotation in EXIF rather than in the pixels, and a face detector handed a
    sideways image finds nothing at all. Skipping it would look like a detection
    problem and be an image-loading one.
    """
    with Image.open(_as_stream(source)) as im:
        im = ImageOps.exif_transpose(im)
        return im.convert("RGB")


def _as_stream(source: Path | bytes) -> Path | io.BytesIO:
    return io.BytesIO(source) if isinstance(source, bytes) else source


def taken_at(source: Path | bytes) -> datetime | None:
    """Capture time from EXIF, which is what makes time-window filtering work."""
    try:
        with Image.open(_as_stream(source)) as im:
            exif = im.getexif()
    except Exception:
        return None
    if not exif:
        return None

    raw = exif.get(EXIF_DATETIME_ORIGINAL) or exif.get(EXIF_DATETIME)
    if not isinstance(raw, str):
        return None
    try:
        # EXIF has no timezone. Treating it as UTC is a lie, but a consistent
        # one, and it is only used for relative ordering and burst grouping.
        return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S").replace(tzinfo=UTC)
    except ValueError:
        return None


def _fit(image: Image.Image, long_edge: int) -> Image.Image:
    w, h = image.size
    if max(w, h) <= long_edge:
        return image.copy()
    scale = long_edge / max(w, h)
    return image.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


def _font(size: int) -> ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_thumbnail(image: Image.Image, long_edge: int, quality: int = 80) -> bytes:
    buf = io.BytesIO()
    _fit(image, long_edge).save(buf, format="WEBP", quality=quality, method=4)
    return buf.getvalue()


def make_watermarked_preview(
    image: Image.Image, long_edge: int, text: str, quality: int = 82
) -> bytes:
    """A diagonal repeating mark, drawn at low opacity over the whole frame.

    Repeating rather than a single corner mark: a corner is cropped off in
    seconds. Low opacity so the attendee can still recognise themselves, which
    is the entire job of the preview.
    """
    base = _fit(image, long_edge).convert("RGBA")
    w, h = base.size

    layer = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    draw = ImageDraw.Draw(layer)
    font = _font(max(16, w // 26))

    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]

    step_x, step_y = tw + w // 5, th + h // 7
    for y in range(-h, h * 2, step_y):
        for x in range(-w, w * 2, step_x):
            draw.text((x, y), text, font=font, fill=(255, 255, 255, 68))

    layer = layer.rotate(30, resample=Image.BICUBIC, center=(w // 2, h // 2))

    out = Image.alpha_composite(base, layer).convert("RGB")
    buf = io.BytesIO()
    out.save(buf, format="WEBP", quality=quality, method=4)
    return buf.getvalue()
