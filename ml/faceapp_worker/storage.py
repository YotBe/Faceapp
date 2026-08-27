"""Object storage, worker side.

Mirrors `src/lib/storage.ts`. Both sides validate keys independently rather than
trusting the other to have done it — they are separate processes and one of them
may be redeployed without the other.
"""

from __future__ import annotations

import re
from pathlib import Path

_SAFE_KEY = re.compile(r"^[A-Za-z0-9._\-/]+$")
_SAFE_BUCKET = re.compile(r"^[a-z0-9-]{1,64}$")


class UnsafeKeyError(ValueError):
    pass


class LocalStorage:
    def __init__(self, root: Path, bucket: str) -> None:
        self.root = Path(root).resolve()
        self.bucket = bucket
        if not _SAFE_BUCKET.match(bucket):
            raise UnsafeKeyError(f"unsafe bucket: {bucket!r}")

    def path(self, key: str) -> Path:
        if (
            not key
            or len(key) > 512
            or key.startswith("/")
            or ".." in key
            or "\0" in key
            or not _SAFE_KEY.match(key)
        ):
            raise UnsafeKeyError(f"unsafe storage key: {key!r}")

        base = (self.root / self.bucket).resolve()
        full = (base / key).resolve()
        if full != base and base not in full.parents:
            raise UnsafeKeyError("storage key escaped its bucket")
        return full

    def read(self, key: str) -> bytes:
        return self.path(key).read_bytes()

    def write(self, key: str, data: bytes) -> None:
        target = self.path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def delete(self, key: str) -> bool:
        target = self.path(key)
        if target.exists():
            target.unlink()
            return True
        return False

    def exists(self, key: str) -> bool:
        return self.path(key).exists()
