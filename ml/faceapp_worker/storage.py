"""Object storage, worker side.

Mirrors `src/lib/storage.ts`: a local driver for development, an S3 driver for
deployment. Both sides validate keys independently rather than trusting the
other to have done it — they are separate processes and either may be
redeployed without the other.

The worker never hands out URLs. It reads originals and writes derivatives; the
web app does the signing. So this interface is narrower than the TypeScript one
by design.
"""

from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from pathlib import Path

_SAFE_KEY = re.compile(r"^[A-Za-z0-9._\-/]+$")
_SAFE_BUCKET = re.compile(r"^[a-z0-9-]{1,64}$")


class UnsafeKeyError(ValueError):
    pass


def assert_safe_key(key: str) -> None:
    if (
        not key
        or len(key) > 512
        or key.startswith("/")
        or ".." in key
        or "\0" in key
        or not _SAFE_KEY.match(key)
    ):
        raise UnsafeKeyError(f"unsafe storage key: {key!r}")


class Storage(ABC):
    """What the ingestion worker needs and nothing more."""

    @abstractmethod
    def read(self, key: str) -> bytes: ...

    @abstractmethod
    def write(self, key: str, data: bytes, content_type: str | None = None) -> None: ...

    @abstractmethod
    def delete(self, key: str) -> bool: ...

    @abstractmethod
    def exists(self, key: str) -> bool: ...


class LocalStorage(Storage):
    def __init__(self, root: Path | str, bucket: str) -> None:
        self.root = Path(root).resolve()
        self.bucket = bucket
        if not _SAFE_BUCKET.match(bucket):
            raise UnsafeKeyError(f"unsafe bucket: {bucket!r}")

    def path(self, key: str) -> Path:
        assert_safe_key(key)
        base = (self.root / self.bucket).resolve()
        full = (base / key).resolve()
        if full != base and base not in full.parents:
            raise UnsafeKeyError("storage key escaped its bucket")
        return full

    def read(self, key: str) -> bytes:
        return self.path(key).read_bytes()

    def write(self, key: str, data: bytes, content_type: str | None = None) -> None:
        del content_type  # the filesystem has no opinion
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


class S3Storage(Storage):
    """Any S3-compatible object store: Cloudflare R2, Supabase Storage.

    Keys are prefixed with the logical bucket name, matching the TypeScript
    driver, so one real bucket holds every logical bucket the app uses and the
    two processes address the same objects.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        access_key_id: str,
        secret_access_key: str,
        logical_bucket: str,
        region: str = "auto",
    ) -> None:
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:  # pragma: no cover - deployment concern
            raise ImportError(
                "R2 storage needs boto3: pip install -e '.[service]'"
            ) from exc

        self.bucket = bucket
        self.logical_bucket = logical_bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            # R2 has no regions and wants the literal "auto"; Supabase Storage
            # wants the project's real region and rejects "auto".
            region_name=region,
            config=Config(
                signature_version="s3v4",
                retries={"max_attempts": 5, "mode": "standard"},
                # Supabase Storage addresses buckets by path, not subdomain.
                s3={"addressing_style": "path"},
            ),
        )

    def _full(self, key: str) -> str:
        assert_safe_key(key)
        return f"{self.logical_bucket}/{key}"

    def read(self, key: str) -> bytes:
        result = self._client.get_object(Bucket=self.bucket, Key=self._full(key))
        return bytes(result["Body"].read())

    def write(self, key: str, data: bytes, content_type: str | None = None) -> None:
        extra = {"ContentType": content_type} if content_type else {}
        self._client.put_object(Bucket=self.bucket, Key=self._full(key), Body=data, **extra)

    def delete(self, key: str) -> bool:
        self._client.delete_object(Bucket=self.bucket, Key=self._full(key))
        return True

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._client.head_object(Bucket=self.bucket, Key=self._full(key))
            return True
        except ClientError:
            return False


# Each entry is one setting; the names inside it are interchangeable. The R2_*
# spellings came first and are kept so nothing already deployed breaks.
_S3_SETTINGS = (
    ("S3_ENDPOINT", "R2_ENDPOINT"),
    ("S3_BUCKET", "R2_BUCKET"),
    ("S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"),
    ("S3_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"),
)


def _first_of(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def from_env(root: Path | str, logical_bucket: str = "event-photos") -> Storage:
    """S3-compatible storage when fully configured, local otherwise.

    Every value or none, matching `env.s3Configured` on the web side. A
    partially configured bucket that quietly falls back to a local filesystem is
    the failure that loses photographs without erroring anywhere.
    """
    values = [_first_of(*names) for names in _S3_SETTINGS]

    if all(values):
        endpoint, bucket, key_id, secret = values
        return S3Storage(
            endpoint=str(endpoint),
            bucket=str(bucket),
            access_key_id=str(key_id),
            secret_access_key=str(secret),
            logical_bucket=logical_bucket,
            region=_first_of("S3_REGION", "R2_REGION") or "auto",
        )

    missing = [names[0] for names, value in zip(_S3_SETTINGS, values, strict=True) if not value]
    if len(missing) != len(_S3_SETTINGS):
        raise SystemExit(
            "Object storage is partially configured; missing " + ", ".join(missing) + ".\n"
            "Set all of them or none — falling back to local storage with some of "
            "them set is how photographs get written somewhere they will not be "
            "found again."
        )

    return LocalStorage(root, logical_bucket)
