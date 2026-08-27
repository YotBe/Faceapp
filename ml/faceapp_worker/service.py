"""Selfie enrollment service.

    uvicorn faceapp_worker.service:app --port 8000

One endpoint that matters: turn three captured frames into one search template.
It exists because model execution may not happen inside a Next.js route handler
— onnxruntime in a serverless function is a cold-start and a memory problem, and
keeping every inference path in one Python process means the quality gate that
guards ingestion is the same code that guards search.

**Nothing here is written to disk or to a database.** The frames arrive in a
request body, become one 512-d vector, and both are gone when the response
returns. That is the whole design: there is no selfie table to clean up because
nothing was ever put in one.
"""

from __future__ import annotations

import io
import logging
import time
from typing import Annotated

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image, ImageOps
from pydantic import BaseModel

from faceapp_ml.embeddings import average_embeddings
from faceapp_ml.engine import EnrollmentError
from faceapp_ml.quality import QualityPolicy

log = logging.getLogger("faceapp.service")

app = FastAPI(title="faceapp enrollment", version="1.0")

_engine = None
_policy: QualityPolicy | None = None

# A selfie frame that fills less of the frame than this is too far away to
# enroll well. Checked server-side as well as in the browser: the client check
# is there to give fast feedback, not to be trusted.
MIN_FACE_FRACTION = 0.18
MAX_FRAMES = 5
MAX_FRAME_BYTES = 8 * 1024 * 1024


def engine():
    global _engine, _policy
    if _engine is None:
        from faceapp_ml.engine import InsightFaceEngine

        log.info("loading face engine")
        _engine = InsightFaceEngine()
        _policy = QualityPolicy.load()
    return _engine


def policy() -> QualityPolicy:
    engine()
    assert _policy is not None
    return _policy


class Enrollment(BaseModel):
    embedding: list[float]
    frames_used: int
    elapsed_ms: int
    # Distinct advice per frame, so the capture UI can say what to fix rather
    # than running the search and returning nothing — which users read as the
    # product being broken.
    warnings: list[str]


class HealthResponse(BaseModel):
    ok: bool
    engine: str
    thresholds_are_this_service_business: bool = False


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True, engine=engine().name)


def _decode(data: bytes) -> np.ndarray:
    if len(data) > MAX_FRAME_BYTES:
        raise HTTPException(413, "frame too large")
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            return np.asarray(im.convert("RGB"), dtype=np.uint8)
    except Exception as exc:
        raise HTTPException(400, f"could not decode frame: {exc}") from exc


@app.post("/enroll", response_model=Enrollment)
async def enroll(
    frames: Annotated[list[UploadFile], File()],
    require_frames: Annotated[int, Form()] = 3,
) -> Enrollment:
    """Three frames in, one template out.

    A single selfie is a weak enrollment: one embedding, one lighting condition,
    one expression. Averaging several normalized embeddings pulls the template
    toward the centre of that person's cluster instead of leaving it wherever one
    frame happened to land.
    """
    started = time.perf_counter()

    if not frames:
        raise HTTPException(400, "no frames")
    if len(frames) > MAX_FRAMES:
        raise HTTPException(400, f"at most {MAX_FRAMES} frames")

    images = [_decode(await f.read()) for f in frames]

    embeddings: list[np.ndarray] = []
    warnings: list[str] = []

    for i, image in enumerate(images):
        faces, _ = engine().detect_and_embed(image, policy=policy())
        if not faces:
            warnings.append(f"frame {i + 1}: no face found — move into the light")
            continue
        if len(faces) > 1:
            warnings.append(f"frame {i + 1}: more than one face — make sure it is just you")
            continue

        face = faces[0]
        frame_height = image.shape[0]
        if face.detection.bbox.h / frame_height < MIN_FACE_FRACTION:
            warnings.append(f"frame {i + 1}: too far away — hold the camera closer")
            continue

        embeddings.append(face.embedding)

    if not embeddings:
        raise HTTPException(
            422,
            {
                "error": "no usable frame",
                "warnings": warnings
                or ["no face was found in any frame"],
            },
        )

    if len(embeddings) < require_frames and len(embeddings) < 2:
        # One usable frame is a weak template. Allowed, but the caller is told.
        warnings.append(
            "only one usable frame — matching will be less reliable than with three"
        )

    template = average_embeddings(embeddings)
    elapsed = int((time.perf_counter() - started) * 1000)

    # The frames go out of scope here. Nothing was written anywhere; the caller
    # records the destruction against its 60-second SLA.
    return Enrollment(
        embedding=[float(x) for x in template],
        frames_used=len(embeddings),
        elapsed_ms=elapsed,
        warnings=warnings,
    )


@app.exception_handler(EnrollmentError)
async def _enrollment_error(_request, exc: EnrollmentError):  # pragma: no cover
    raise HTTPException(422, str(exc))
