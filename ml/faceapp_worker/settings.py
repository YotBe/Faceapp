"""Configuration, read once."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str
    storage_root: Path
    bucket: str = "event-photos"

    # Long edge of the generated derivatives.
    thumb_px: int = 400
    preview_px: int = 1400
    preview_quality: int = 82

    # How many photos one worker claims at a time. Small: a large batch means a
    # killed worker leaves more jobs waiting for their lease to expire.
    batch_size: int = 4
    lease_seconds: int = 300
    poll_seconds: float = 1.0

    @classmethod
    def from_env(cls) -> Settings:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise SystemExit("DATABASE_URL is not set")
        return cls(
            database_url=url,
            storage_root=Path(os.environ.get("STORAGE_ROOT", ".storage")).resolve(),
        )
