"""Face detection, embedding and quality gating for event photo search.

The vendor-facing surface is `faceapp_ml.engine.FaceEngine`; everything else in
here is ours. Nothing in this package imports onnxruntime at module scope, so
the quality gate and the eval harness stay testable without the model extras.
"""

from __future__ import annotations

from .config import (
    TARGET_PRECISION,
    Provenance,
    ThresholdProvenanceError,
    Thresholds,
    UntunedThresholdError,
    load_thresholds,
)
from .embeddings import (
    average_embeddings,
    cosine_similarity,
    cosine_similarity_matrix,
    l2_normalize,
)
from .quality import GateStats, QualityPolicy, assess, blur_score
from .types import (
    EMBEDDING_DIM,
    BBox,
    Detection,
    Embedding,
    Face,
    Image,
    Pose,
    QualityAssessment,
)

__all__ = [
    "EMBEDDING_DIM",
    "TARGET_PRECISION",
    "BBox",
    "Detection",
    "Embedding",
    "Face",
    "GateStats",
    "Image",
    "Pose",
    "Provenance",
    "QualityAssessment",
    "QualityPolicy",
    "ThresholdProvenanceError",
    "Thresholds",
    "UntunedThresholdError",
    "assess",
    "average_embeddings",
    "blur_score",
    "cosine_similarity",
    "cosine_similarity_matrix",
    "l2_normalize",
    "load_thresholds",
]
