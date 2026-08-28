#!/usr/bin/env bash
#
# One image, three roles.
#
#   service     the enrollment HTTP API
#   worker      the ingestion queue consumer
#   storage-gc  drains storage_gc_queue — the half of retention that touches bytes
#   cluster     a one-shot clustering pass over ready events
set -euo pipefail

role="${1:-service}"
shift || true

case "$role" in
  service)
    # One process. The model is several hundred MB resident and uvicorn workers
    # do not share it, so scale with replicas rather than with --workers.
    exec uvicorn faceapp_worker.service:app \
      --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 "$@"
    ;;
  worker)
    exec python -m faceapp_worker.ingest "$@"
    ;;
  storage-gc)
    exec python -m faceapp_worker.storage_gc "$@"
    ;;
  cluster)
    exec python -m faceapp_worker.cluster "$@"
    ;;
  bash|sh)
    exec /bin/bash "$@"
    ;;
  *)
    echo "unknown role: $role (expected service, worker, storage-gc or cluster)" >&2
    exit 64
    ;;
esac
