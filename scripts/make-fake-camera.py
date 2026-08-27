#!/usr/bin/env python3
"""Write a Y4M video from the demo selfie frames, for Chromium's fake camera.

    python scripts/make-fake-camera.py --out /tmp/fake-camera.y4m

Y4M is a text header, then per frame the literal b"FRAME\\n" followed by raw
planar YUV420. Writing it directly avoids depending on an ffmpeg build that
happens to include the image demuxer.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

import numpy as np
from PIL import Image

WIDTH, HEIGHT, FPS = 640, 800, 6


def write_y4m(frames: list[pathlib.Path], out: pathlib.Path, seconds: int = 10) -> None:
    with out.open("wb") as fh:
        fh.write(f"YUV4MPEG2 W{WIDTH} H{HEIGHT} F{FPS}:1 Ip A1:1 C420mpeg2\n".encode())
        for _ in range(max(1, (seconds * FPS) // max(1, len(frames)))):
            for path in frames:
                rgb = np.asarray(
                    Image.open(path).convert("RGB").resize((WIDTH, HEIGHT)),
                    dtype=np.float64,
                )
                r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
                y = 0.299 * r + 0.587 * g + 0.114 * b
                u = (-0.169 * r - 0.331 * g + 0.500 * b) + 128
                v = (0.500 * r - 0.419 * g - 0.081 * b) + 128
                # 4:2:0: average each 2x2 block of the chroma planes.
                u2 = u.reshape(HEIGHT // 2, 2, WIDTH // 2, 2).mean(axis=(1, 3))
                v2 = v.reshape(HEIGHT // 2, 2, WIDTH // 2, 2).mean(axis=(1, 3))
                fh.write(b"FRAME\n")
                for plane in (y, u2, v2):
                    fh.write(np.clip(plane, 0, 255).astype(np.uint8).tobytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=pathlib.Path, default=pathlib.Path("/tmp/demo-album/selfies"))
    parser.add_argument("--out", type=pathlib.Path, default=pathlib.Path("/tmp/fake-camera.y4m"))
    args = parser.parse_args()

    frames = sorted(args.frames.glob("*.jpg"))
    if not frames:
        print(f"no frames in {args.frames}", file=sys.stderr)
        return 1

    write_y4m(frames, args.out)
    print(f"wrote {args.out} ({args.out.stat().st_size // 1024 // 1024}MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
