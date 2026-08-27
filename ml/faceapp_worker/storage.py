"""Object storage, worker side.

Mirrors `src/lib/storage.ts`: a local driver for development, an R2 driver for
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


class R2Storage(Storage):
    """Cloudflare R2 over the S3 API.

    Keys are prefixed with the logical bucket name, matching the TypeScript
    driver, so one R2 bucket holds every logical bucket the app uses and the two
    processes address the same objects.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        access_key_id: str,
        secret_access_key: str,
        logical_bucket: str,
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
            # R2 has no regions, but the S3 signature requires one.
            region_name="auto",
            config=Config(
                signature_version="s3v4",
                retries={"max_attempts": 5, "mode": "standard"},
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


def from_env(root: Path | str, logical_bucket: str = "event-photos") -> Storage:
    """R2 when fully configured, local otherwise.

    All four variables or none, matching `env.r2Configured` on the web side. A
    partially configured R2 that quietly falls back to a local filesystem is the
    failure that loses photographs without erroring anywhere.
    """
    endpoint = os.environ.get("R2_ENDPOINT")
    bucket = os.environ.get("R2_BUCKET")
    key_id = os.environ.get("R2_ACCESS_KEY_ID")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY")

    if endpoint and bucket and key_id and secret:
        return R2Storage(
            endpoint=endpoint,
            bucket=bucket,
            access_key_id=key_id,
            secret_access_key=secret,
            logical_bucket=logical_bucket,
        )

    partial = [
        name
        for name, value in [
            ("R2_ENDPOINT", endpoint),
            ("R2_BUCKET", bucket),
            ("R2_ACCESS_KEY_ID", key_id),
            ("R2_SECRET_ACCESS_KEY", secret),
        ]
        if not value
    ]
    if len(partial) != 4:
        raise SystemExit(
            "R2 is partially configured; missing " + ", ".join(partial) + ".\n"
            "Set all four or none — falling back to local storage with some of "
            "them set is how photographs get written somewhere they will not be "
            "found again."
        )

    return LocalStorage(root, logical_bucket)
