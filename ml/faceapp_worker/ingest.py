"""The ingestion worker.

    python -m faceapp_worker.ingest

Claims photographs from `ingest_jobs`, generates derivatives, detects and embeds
faces, writes the rows. Runs until interrupted. Several may run at once — the
queue hands out disjoint batches under SKIP LOCKED.

Ordering inside a job matters and is not arbitrary. Derivatives are written and
recorded before detection runs, so a photograph that crashes the detector still
has a preview and a thumbnail and shows up in the operator's album instead of
disappearing. Faces are written last, in one transaction, replacing whatever a
previous attempt left behind.
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import sys
import time
from types import FrameType

import numpy as np
from PIL import Image

from faceapp_ml.engine import FaceEngine
from faceapp_ml.quality import QualityPolicy

from .images import load_rgb, make_watermarked_preview, taken_at
from .repo import Job, Repo, format_vector
from .settings import Settings
from .storage import Storage, from_env

log = logging.getLogger("faceapp.ingest")

_stop = False


def _handle_stop(signum: int, frame: FrameType | None) -> None:
    """Finish the batch in hand, then exit.

    Dropping the batch would work too — the leases expire and another worker
    picks the jobs up — but finishing cleanly means a rolling deploy does not
    leave a five-minute hole in throughput.
    """
    del signum, frame
    global _stop
    if _stop:
        log.warning("second signal, exiting now")
        sys.exit(1)
    _stop = True
    log.info("stopping after the current batch")


def derivative_keys(storage_key: str) -> tuple[str, str]:
    stem = storage_key.rsplit(".", 1)[0]
    return f"{stem}.preview.webp", f"{stem}.thumb.webp"


def process_one(
    job: Job,
    *,
    repo: Repo,
    storage: Storage,
    engine: FaceEngine,
    policy: QualityPolicy,
    settings: Settings,
) -> tuple[int, int]:
    """Returns (faces indexed, detections rejected)."""
    if not storage.exists(job.storage_key):
        raise FileNotFoundError(f"{job.storage_key} is not in storage")

    # Through the driver rather than off the filesystem: with R2 there is no
    # path, and EXIF has to be read from the same bytes we decode.
    raw = storage.read(job.storage_key)
    image = load_rgb(raw)
    preview_key, thumb_key = derivative_keys(job.storage_key)

    mark = job.event_name.upper()[:24] or "PREVIEW"
    storage.write(
        preview_key,
        make_watermarked_preview(
            image, settings.preview_px, mark, quality=settings.preview_quality
        ),
        content_type="image/webp",
    )
    # The thumbnail is watermarked too. It is what the attendee results grid
    # shows, and a 400px unmarked copy of every photograph in the album is a
    # perfectly good scrape — the watermark has to be on whatever is reachable
    # before the photographs are released, not only on the large preview.
    storage.write(
        thumb_key,
        make_watermarked_preview(image, settings.thumb_px, mark, quality=80),
        content_type="image/webp",
    )

    repo.store_photo_derivatives(
        job.photo_id,
        width=image.width,
        height=image.height,
        preview_key=preview_key,
        thumb_key=thumb_key,
        taken_at=taken_at(raw),
    )

    rgb = np.asarray(image, dtype=np.uint8)
    faces, stats = engine.detect_and_embed(rgb, policy=policy)

    rows = [
        {
            "embedding": format_vector(f.embedding.tolist()),
            "bbox": _bbox_json(f),
            "det_score": float(f.detection.det_score),
            "face_px": f.detection.face_px,
            "yaw": f.detection.pose.yaw,
            "pitch": f.detection.pose.pitch,
            "roll": f.detection.pose.roll,
            "blur_score": f.quality.blur_score,
            "quality_tier": f.quality.tier,
        }
        for f in faces
    ]
    repo.replace_faces(job.photo_id, job.event_id, rows)

    return len(rows), stats.rejected


def _bbox_json(face: object) -> str:
    import json

    bbox = face.detection.bbox  # type: ignore[attr-defined]
    return json.dumps(bbox.to_json())


def run(settings: Settings | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s  %(message)s"
    )
    settings = settings or Settings.from_env()
    Image.MAX_IMAGE_PIXELS = 200_000_000  # decompression-bomb guard, generous for DSLRs

    worker_id = f"{socket.gethostname()}-{os.getpid()}"
    repo = Repo(settings.database_url)
    storage = from_env(settings.storage_root, settings.bucket)
    policy = QualityPolicy.load()

    log.info("loading face engine")
    from faceapp_ml.engine import InsightFaceEngine

    engine: FaceEngine = InsightFaceEngine()
    log.info(
        "worker %s ready, engine=%s, storage=%s",
        worker_id, engine.name, type(storage).__name__,
    )

    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)

    idle_logged = False
    while not _stop:
        try:
            jobs = repo.claim(worker_id, settings.batch_size, settings.lease_seconds)
        except Exception:
            log.exception("could not claim jobs; retrying")
            time.sleep(2.0)
            continue

        if not jobs:
            if not idle_logged:
                log.info("queue empty, waiting")
                idle_logged = True
            time.sleep(settings.poll_seconds)
            continue

        idle_logged = False
        repo.heartbeat([j.id for j in jobs], settings.lease_seconds)

        for job in jobs:
            started = time.perf_counter()
            try:
                indexed, rejected = process_one(
                    job,
                    repo=repo,
                    storage=storage,
                    engine=engine,
                    policy=policy,
                    settings=settings,
                )
            except Exception as exc:
                # Deliberately broad. A worker that dies on one malformed JPEG
                # stops the whole album; the queue already knows how to retry
                # and how to give up, so hand it the reason and move on.
                log.warning("photo %s failed: %s", job.photo_id, exc)
                state = repo.finish(job.id, False, str(exc)[:2000])
                if state == "failed":
                    log.error("photo %s dead-lettered after %d attempts",
                              job.photo_id, job.attempts)
                continue

            repo.finish(job.id, True, None, indexed, rejected)
            log.info(
                "photo %s  %d indexed, %d rejected, %.0fms",
                job.photo_id, indexed, rejected, (time.perf_counter() - started) * 1000,
            )
            # Extend the lease on whatever is left in the batch: a slow crowd
            # shot must not let the rest of the batch expire underneath us.
            repo.heartbeat([j.id for j in jobs], settings.lease_seconds)

    repo.close()
    log.info("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
