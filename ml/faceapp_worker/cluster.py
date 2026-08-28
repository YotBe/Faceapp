"""Cluster an event's faces into identities.

    python -m faceapp_worker.cluster --event <uuid>
    python -m faceapp_worker.cluster --all-ready

Brute-force searching 800,000 face vectors per attendee is wasteful. Clustering
the tier-2 faces once, after ingestion, means a search matches against a few
thousand centroids and then expands only the best clusters — a 2-second search
becomes a 100ms one.

It also hands the operator something for free: "there are 2,000 distinct people
in this album."

The grouping itself is `faceapp_ml.clustering.dbscan_cosine`, which lives there
rather than here because `eval.label` needs the same algorithm on a laptop with
no database.

What belongs to *this* caller is the choice of `eps`: it is derived from the
tuned `T_high`, not chosen independently. Two faces belong together at the same
similarity at which we would tell an attendee "this is you" — anything looser
would build clusters that the search then trusts.
"""

from __future__ import annotations

import argparse
import logging
import os

import numpy as np

from faceapp_ml.clustering import dbscan_cosine
from faceapp_ml.config import UntunedThresholdError, load_thresholds
from faceapp_ml.embeddings import l2_normalize

from .repo import Repo, format_vector

log = logging.getLogger("faceapp.cluster")

# A cluster smaller than this is not a person, it is a coincidence. Singletons
# stay unclustered and are still reachable through the exact-face search path.
MIN_CLUSTER_SIZE = 2


def cluster_event(repo: Repo, event_id: str, eps: float) -> tuple[int, int]:
    """Returns (clusters written, faces assigned)."""
    conn = repo.connect()
    with conn.cursor() as cur:
        cur.execute(
            """
            select id, embedding::text as embedding
              from faces
             where event_id = %s and quality_tier = 2
             order by id
            """,
            (event_id,),
        )
        rows = cur.fetchall()

    if not rows:
        log.info("event %s has no tier-2 faces", event_id)
        return (0, 0)

    face_ids = [str(r["id"]) for r in rows]
    embeddings = np.stack(
        [
            l2_normalize(
                np.fromstring(r["embedding"].strip("[]"), sep=",", dtype=np.float32)
            )
            for r in rows
        ]
    )

    labels = dbscan_cosine(embeddings, eps=eps, min_samples=MIN_CLUSTER_SIZE)
    unique = [label for label in np.unique(labels) if label >= 0]
    log.info(
        "event %s: %d tier-2 faces -> %d clusters (%d unclustered)",
        event_id,
        len(face_ids),
        len(unique),
        int(np.count_nonzero(labels < 0)),
    )

    assigned = 0
    with conn.transaction(), conn.cursor() as cur:
        # Rebuild from scratch. Faces keep their cluster_id via ON DELETE SET
        # NULL, so a re-run after new photographs arrive is safe.
        cur.execute("delete from clusters where event_id = %s", (event_id,))

        for label in unique:
            members = np.flatnonzero(labels == label)
            centroid = l2_normalize(embeddings[members].mean(axis=0))
            cur.execute(
                """
                insert into clusters (event_id, centroid, face_count)
                values (%s, %s, %s) returning id
                """,
                (event_id, format_vector(centroid.tolist()), int(members.size)),
            )
            row = cur.fetchone()
            cluster_id = row["id"]
            cur.execute(
                "update faces set cluster_id = %s where id = any(%s::uuid[])",
                (cluster_id, [face_ids[i] for i in members]),
            )
            assigned += int(members.size)

    return (len(unique), assigned)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
    parser = argparse.ArgumentParser(prog="faceapp_worker.cluster", description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--event", help="event id")
    group.add_argument("--all-ready", action="store_true", help="every ready event")
    parser.add_argument(
        "--eps",
        type=float,
        default=None,
        help="cosine distance. Defaults to 1 - T_high from the tuned thresholds.",
    )
    args = parser.parse_args(argv)

    eps = args.eps
    if eps is None:
        try:
            eps = 1.0 - load_thresholds().t_high
        except UntunedThresholdError as exc:
            raise SystemExit(
                f"{exc}\n\n"
                "Clustering derives eps from T_high on purpose: two faces belong "
                "together at the same similarity at which we would tell somebody "
                "'this is you'. Pass --eps explicitly only if you know why."
            ) from exc

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set")

    repo = Repo(dsn)
    if args.event:
        events = [args.event]
    else:
        with repo.connect().cursor() as cur:
            cur.execute("select id from events where status = 'ready'")
            events = [str(r["id"]) for r in cur.fetchall()]

    total_clusters = 0
    for event_id in events:
        clusters, assigned = cluster_event(repo, event_id, eps)
        total_clusters += clusters
        print(f"{event_id}: {clusters} clusters, {assigned} faces assigned")

    repo.close()
    print(f"\n{total_clusters} distinct people across {len(events)} event(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
