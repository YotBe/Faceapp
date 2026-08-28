#!/usr/bin/env bash
#
# Start everything the app needs, in the background, and wait for it to be up.
#
#   ./scripts/dev-all.sh
#
# Three processes:
#   postgres            the database (started by dev-db.sh)
#   uvicorn :8000       the enrollment service — model execution lives here
#   worker              consumes ingest_jobs
#   storage-gc          drains storage_gc_queue, so retention empties the bucket
#                       as well as the database
#   next dev :3000      the web app
#
# Logs land in .dev/. Stop everything with ./scripts/dev-stop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .dev

PY="${FACEAPP_PYTHON:-$ROOT/ml/.venv/bin/python}"
if [ ! -x "$PY" ]; then
  echo "no python venv at $PY — run: cd ml && python -m venv .venv && .venv/bin/pip install -e '.[dev,service,insightface]'" >&2
  exit 1
fi

set -a; [ -f .env.local ] && . ./.env.local; set +a

"$ROOT/scripts/dev-db.sh" --keep

start() {
  local name="$1"; shift
  if [ -f ".dev/$name.pid" ] && kill -0 "$(cat ".dev/$name.pid")" 2>/dev/null; then
    echo "==> $name already running"
    return
  fi
  echo "==> starting $name"
  ( "$@" >".dev/$name.log" 2>&1 & echo $! > ".dev/$name.pid" )
}

start enrollment "$ROOT/ml/.venv/bin/uvicorn" faceapp_worker.service:app \
  --host 127.0.0.1 --port 8000 --app-dir "$ROOT/ml" --log-level warning
start worker env PYTHONPATH="$ROOT/ml" "$PY" -m faceapp_worker.ingest
start storage-gc env PYTHONPATH="$ROOT/ml" "$PY" -m faceapp_worker.storage_gc --forever
start web pnpm next dev --port 3000

wait_for() {
  local label="$1" url="$2"
  for _ in $(seq 1 "${3:-60}"); do
    if curl -sf -o /dev/null "$url"; then echo "    $label up"; return 0; fi
    sleep 2
  done
  echo "    $label did not come up; see .dev/" >&2
  return 1
}

wait_for "enrollment service" http://127.0.0.1:8000/health 90
wait_for "web app" http://127.0.0.1:3000/ 60

echo
echo "web        http://127.0.0.1:3000"
echo "enrollment http://127.0.0.1:8000/health"
echo "logs       .dev/*.log"
