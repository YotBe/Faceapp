"""Database access for the worker.

Runs as the owning role and therefore bypasses RLS, which is correct: the worker
serves no user and belongs to no operator. Every query here is scoped by an
event or photo id that came from the queue, never from a request.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row


@dataclass(frozen=True, slots=True)
class Job:
    id: int
    photo_id: str
    event_id: str
    attempts: int
    storage_bucket: str
    storage_key: str
    event_name: str


class Repo:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._conn: psycopg.Connection[Any] | None = None

    def connect(self) -> psycopg.Connection[Any]:
        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self._dsn, row_factory=dict_row, autocommit=True)
        return self._conn

    def close(self) -> None:
        if self._conn is not None and not self._conn.closed:
            self._conn.close()

    # -- queue -------------------------------------------------------------

    def claim(self, worker: str, limit: int, lease_seconds: int) -> list[Job]:
        with self.connect().cursor() as cur:
            cur.execute(
                """
                select j.id, j.photo_id, j.event_id, j.attempts,
                       p.storage_bucket, p.storage_key, e.name as event_name
                  from claim_ingest_jobs(%s, %s, make_interval(secs => %s)) j
                  join photos p on p.id = j.photo_id
                  join events e on e.id = j.event_id
                """,
                (worker, limit, lease_seconds),
            )
            return [
                Job(
                    id=r["id"],
                    photo_id=str(r["photo_id"]),
                    event_id=str(r["event_id"]),
                    attempts=r["attempts"],
                    storage_bucket=r["storage_bucket"],
                    storage_key=r["storage_key"],
                    event_name=r["event_name"],
                )
                for r in cur.fetchall()
            ]

    def finish(
        self,
        job_id: int,
        ok: bool,
        error: str | None = None,
        faces: int = 0,
        rejected: int = 0,
    ) -> str:
        with self.connect().cursor() as cur:
            cur.execute(
                "select finish_ingest_job(%s, %s, %s, %s, %s) as state",
                (job_id, ok, error, faces, rejected),
            )
            row = cur.fetchone()
            return str(row["state"]) if row else "unknown"

    def heartbeat(self, job_ids: list[int], lease_seconds: int) -> None:
        """Extend the lease on jobs still being worked.

        A crowded photograph can take several seconds per face. Without this a
        slow job would have its lease expire while it was still running and be
        picked up by a second worker, and both would insert the same faces.
        """
        if not job_ids:
            return
        with self.connect().cursor() as cur:
            cur.execute(
                """
                update ingest_jobs
                   set locked_until = now() + make_interval(secs => %s)
                 where id = any(%s) and state = 'running'
                """,
                (lease_seconds, job_ids),
            )

    # -- writes ------------------------------------------------------------

    def store_photo_derivatives(
        self,
        photo_id: str,
        *,
        width: int,
        height: int,
        preview_key: str,
        thumb_key: str,
        taken_at: datetime | None,
    ) -> None:
        with self.connect().cursor() as cur:
            cur.execute(
                """
                update photos
                   set width = %s, height = %s,
                       preview_key = %s, thumb_key = %s,
                       taken_at = coalesce(%s, taken_at),
                       status = 'processing'
                 where id = %s
                """,
                (width, height, preview_key, thumb_key, taken_at, photo_id),
            )

    def replace_faces(self, photo_id: str, event_id: str, rows: list[dict[str, Any]]) -> None:
        """Delete then insert, in one transaction.

        Re-processing a photograph must not double its faces. This is the other
        half of ingestion idempotency — the unique storage key stops a duplicate
        photo row, and this stops duplicate face rows for a retried job.
        """
        conn = self.connect()
        with conn.transaction(), conn.cursor() as cur:
            cur.execute("delete from faces where photo_id = %s", (photo_id,))
            for row in rows:
                cur.execute(
                    """
                    insert into faces (
                        photo_id, event_id, embedding, bbox, det_score, face_px,
                        yaw, pitch, roll, blur_score, quality_tier
                    ) values (
                        %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s
                    )
                    """,
                    (
                        photo_id,
                        event_id,
                        row["embedding"],
                        row["bbox"],
                        row["det_score"],
                        row["face_px"],
                        row["yaw"],
                        row["pitch"],
                        row["roll"],
                        row["blur_score"],
                        row["quality_tier"],
                    ),
                )

    def excluded_embeddings(self, event_id: str) -> list[list[float]]:
        with self.connect().cursor() as cur:
            cur.execute(
                "select embedding::text as e from exclusions where event_id = %s",
                (event_id,),
            )
            return [_parse_vector(r["e"]) for r in cur.fetchall()]


def _parse_vector(text: str) -> list[float]:
    return [float(x) for x in text.strip("[]").split(",") if x]


def format_vector(values: list[float]) -> str:
    """pgvector's text input format."""
    return "[" + ",".join(f"{v:.7f}" for v in values) + "]"
