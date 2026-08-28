"""Storage garbage collection: the half of retention that touches bytes.

    python -m faceapp_worker.storage_gc            # run until the queue drains
    python -m faceapp_worker.storage_gc --forever  # stay up and poll
    python -m faceapp_worker.storage_gc --status   # what is still out there

`run_retention()` deletes the database rows and enqueues every object key the
event owned. Without this process those keys sit in `storage_gc_queue` and the
photographs sit in the bucket, so the sentence "this album is deleted after 60
days" is true of the index and false of the thing the sentence is about.

Failure here is not like failure in the ingestion worker. A dead-lettered
ingest job is a photograph that will not be searchable; a dead-lettered GC row
is personal data still sitting in a bucket after somebody was told it was gone.
So the exit code is non-zero while anything is dead-lettered, and `--status`
prints the backlog in a form a monitor can alert on.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import time
from types import FrameType

from .settings import Settings
from .storage import Storage, UnsafeKeyError, from_env

log = logging.getLogger("faceapp.storage_gc")

_stop = False


def _handle_stop(signum: int, frame: FrameType | None) -> None:
    del signum, frame
    global _stop
    _stop = True
    log.info("stopping after the current batch")


def drain_once(repo, storage: Storage, worker_id: str, batch: int, lease: int) -> tuple[int, int]:
    """One batch. Returns (deleted, failed)."""
    conn = repo.connect()
    with conn.cursor() as cur:
        cur.execute(
            "select id, bucket, storage_key from "
            "claim_storage_gc(%s, %s, make_interval(secs => %s))",
            (worker_id, batch, lease),
        )
        rows = cur.fetchall()

    deleted = failed = 0
    for row in rows:
        row_id, key = row["id"], row["storage_key"]
        try:
            existed = storage.delete(key)
        except UnsafeKeyError as exc:
            # A key that cannot be parsed will never delete. Dead-letter it now
            # rather than burning eight attempts on it.
            log.error("gc %s: unusable key %r: %s", row_id, key, exc)
            with conn.cursor() as cur:
                cur.execute(
                    "select finish_storage_gc(%s, false, %s)", (row_id, f"unusable key: {exc}")
                )
                cur.execute(
                    "update storage_gc_queue set state = 'failed' where id = %s", (row_id,)
                )
            failed += 1
            continue
        except Exception as exc:  # the queue is the error handler
            log.warning("gc %s: %s failed: %s", row_id, key, exc)
            with conn.cursor() as cur:
                cur.execute(
                    "select finish_storage_gc(%s, false, %s) as s",
                    (row_id, str(exc)[:2000]),
                )
                state = cur.fetchone()["s"]
            if state == "failed":
                log.error(
                    "gc %s: %s dead-lettered — this object is still in the bucket "
                    "after its event was deleted",
                    row_id, key,
                )
                failed += 1
            continue

        with conn.cursor() as cur:
            cur.execute("select finish_storage_gc(%s, true)", (row_id,))
        deleted += 1
        if not existed:
            # Already gone. Normal: a lease that expired after a successful
            # delete is retried, and the object store is the authority.
            log.debug("gc %s: %s was already absent", row_id, key)

    return deleted, failed


def backlog(repo) -> dict[str, object]:
    with repo.connect().cursor() as cur:
        cur.execute("select * from storage_gc_backlog")
        return dict(cur.fetchone())


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="faceapp_worker.storage_gc", description=__doc__)
    parser.add_argument("--forever", action="store_true", help="poll instead of exiting when empty")
    parser.add_argument("--status", action="store_true", help="print the backlog and exit")
    parser.add_argument("--batch", type=int, default=100)
    parser.add_argument("--lease-seconds", type=int, default=120)
    parser.add_argument("--poll-seconds", type=float, default=10.0)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s  %(message)s"
    )
    settings = Settings.from_env()

    from .repo import Repo

    repo = Repo(settings.database_url)

    if args.status:
        state = backlog(repo)
        print(f"pending          {state['pending']}")
        print(f"dead-lettered    {state['dead_lettered']}")
        print(f"deleted          {state['deleted']}")
        print(f"oldest pending   {state['oldest_pending_age']}")
        if state["dead_lettered"]:
            print(
                f"\n{state['dead_lettered']} object(s) could not be deleted. These are "
                "photographs still in the bucket after their event was erased.\n"
                "Investigate before telling anyone the album is gone."
            )
        repo.close()
        return 1 if state["dead_lettered"] else 0

    storage = from_env(settings.storage_root, settings.bucket)
    worker_id = f"{socket.gethostname()}-{os.getpid()}"
    log.info("storage gc %s ready, storage=%s", worker_id, type(storage).__name__)

    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)

    total_deleted = total_failed = 0
    while not _stop:
        deleted, failed = drain_once(
            repo, storage, worker_id, args.batch, args.lease_seconds
        )
        total_deleted += deleted
        total_failed += failed

        if deleted:
            log.info("deleted %d object(s)", deleted)

        if deleted == 0 and failed == 0:
            if not args.forever:
                break
            time.sleep(args.poll_seconds)

    state = backlog(repo)
    repo.close()

    log.info(
        "done: %d deleted this run, %s pending, %s dead-lettered",
        total_deleted, state["pending"], state["dead_lettered"],
    )
    # Non-zero while anything is dead-lettered: those are photographs still in
    # the bucket after someone was told they were gone, and a scheduler that
    # reports success on that is worse than no scheduler.
    return 1 if state["dead_lettered"] else 0


if __name__ == "__main__":
    raise SystemExit(run())
