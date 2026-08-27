"""The `FaceEngine` interface.

Everything vendor-specific lives behind this. The reason is not tidiness: it is
that a face-recognition vendor's data model must never reach our schema. If
`faces` ever grows a column because Rekognition returns it, or the search path
starts depending on a vendor's own similarity scale, then switching providers
becomes a migration instead of a config change — and at that point the vendor
sets the margin permanently.

`detect_and_embed` is concrete and shared by every implementation, because the
order of operations in it is a compliance property rather than an
implementation detail:

    detect  ->  reject cheaply  ->  pose  ->  grade  ->  embed

A face that fails the size or confidence gate is never turned into a biometric
template at all. It is also, incidentally, the fast path: on a crowd shot most
detections are background faces, and this skips both the pose model and the
embedding model for all of them.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence

import numpy as np

from ..embeddings import average_embeddings
from ..quality import (
    GateStats,
    QualityPolicy,
    assess,
    estimate_pose_from_landmarks,
)
from ..types import EMBEDDING_DIM, Detection, Embedding, Face, Image


class FaceEngine(ABC):
    """Detect faces in an image and turn them into 512-d templates."""

    name: str = "abstract"
    embedding_dim: int = EMBEDDING_DIM

    # -- to implement ------------------------------------------------------

    @abstractmethod
    def detect(self, image: Image) -> list[Detection]:
        """Find faces. RGB in.

        Should not apply its own quality policy beyond whatever detection
        threshold the model needs to run. Grading is `quality.assess`'s job, and
        having two places that decide what counts as a usable face is how the
        tier table drifts out of sync with what is actually indexed.
        """

    @abstractmethod
    def embed(self, image: Image, detection: Detection) -> Embedding:
        """Compute one L2-normalized 512-d template for a detected face."""

    # -- overridable -------------------------------------------------------

    def estimate_pose(self, image: Image, detection: Detection) -> Detection:
        """Fill in head pose, if it is not there already.

        The default approximates from the five-point landmark set. An engine with
        a real pose model should override this — `InsightFaceEngine` does, using
        the 3D landmark model in the buffalo_l pack.
        """
        del image
        if detection.pose.yaw is not None:
            return detection
        if detection.landmarks is None:
            return detection
        return Detection(
            bbox=detection.bbox,
            det_score=detection.det_score,
            landmarks=detection.landmarks,
            pose=estimate_pose_from_landmarks(detection.landmarks),
        )

    # -- shared ------------------------------------------------------------

    def detect_and_embed(
        self, image: Image, *, policy: QualityPolicy | None = None
    ) -> tuple[list[Face], GateStats]:
        """The ingestion path for one photograph.

        Returns the faces worth indexing and the accounting for everything that
        was thrown away, which the operator dashboard needs in order to warn a
        photographer that their crowd shots will not match well.
        """
        policy = policy or QualityPolicy()
        faces: list[Face] = []
        assessments = []

        for detection in self.detect(image):
            # Cheap rejection first: size and detection confidence need no model
            # and no image analysis. Anything that fails here is discarded before
            # a template exists for it.
            preliminary = assess(detection, policy=policy)
            if preliminary.rejected:
                assessments.append(preliminary)
                continue

            posed = self.estimate_pose(image, detection)
            graded = assess(posed, policy=policy, image=image)
            assessments.append(graded)
            if graded.rejected:  # defensive: the second pass only demotes
                continue

            faces.append(
                Face(detection=posed, embedding=self.embed(image, posed), quality=graded)
            )

        return faces, GateStats.of(assessments)

    def enroll(self, frames: Sequence[Image], *, policy: QualityPolicy | None = None) -> Embedding:
        """Build a search template from several selfie frames.

        Each frame must contain exactly one usable face. That is checked here
        rather than trusted from the client: a frame with two faces in it means
        we cannot tell which one the person meant, and picking the largest would
        occasionally enroll somebody standing behind them.
        """
        policy = policy or QualityPolicy()
        if not frames:
            raise ValueError("no frames supplied")

        embeddings: list[np.ndarray] = []
        for i, frame in enumerate(frames):
            faces, _ = self.detect_and_embed(frame, policy=policy)
            if not faces:
                raise EnrollmentError(f"frame {i}: no usable face found")
            if len(faces) > 1:
                raise EnrollmentError(f"frame {i}: {len(faces)} faces found, expected exactly one")
            embeddings.append(faces[0].embedding)

        return average_embeddings(embeddings)


class EnrollmentError(ValueError):
    """A selfie frame could not be used.

    Raised with a specific reason so the capture UI can say what is wrong —
    "move closer", "only you in frame" — instead of running the search and
    returning nothing, which users read as the product being broken.
    """
