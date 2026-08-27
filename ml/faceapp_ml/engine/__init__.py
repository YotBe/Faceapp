"""Face engines.

`InsightFaceEngine` is imported lazily so that importing `faceapp_ml` does not
drag in onnxruntime. The core package — quality gating, embedding arithmetic,
threshold loading, the eval harness — must stay usable, and testable, without
the model extras installed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .base import EnrollmentError, FaceEngine
from .scripted import ScriptedEngine, ScriptedFace, deterministic_embedding

if TYPE_CHECKING:  # pragma: no cover
    from .insightface_engine import InsightFaceEngine

__all__ = [
    "EnrollmentError",
    "FaceEngine",
    "InsightFaceEngine",
    "ScriptedEngine",
    "ScriptedFace",
    "deterministic_embedding",
]


def __getattr__(name: str) -> Any:
    if name == "InsightFaceEngine":
        from .insightface_engine import InsightFaceEngine

        return InsightFaceEngine
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
