#!/usr/bin/env bash
#
# Seed a demo operator, event and indexed album, so the app can be looked at
# without anyone's real photographs.
#
#   ./scripts/seed-demo.sh                              # against localhost
#   BASE_URL=https://your-app.vercel.app ./scripts/seed-demo.sh   # against a deployment
#
# The album is built from the group photograph bundled with InsightFace — six
# distinct faces, ten derived shots, and a manifest recording which people are in
# which shot.
#
# The event is created with the demonstration box ticked. That is not cosmetic:
# without it the search refuses to run, because no thresholds have been measured
# and a real event must not return results from placeholder numbers.
#
# With DATABASE_URL set it watches the queue directly; without it (seeding a
# deployment from a laptop that has no database credentials) it polls the API.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a; [ -f .env.local ] && . ./.env.local; set +a

ALBUM="${DEMO_ALBUM:-/tmp/demo-album}"
BASE="${BASE_URL:-http://127.0.0.1:3000}"
EMAIL="${DEMO_EMAIL:-demo@example.com}"
PASSWORD="${DEMO_PASSWORD:-correct-horse-battery}"
JAR="$(mktemp)"

echo "==> building the demo album"
"$ROOT/ml/.venv/bin/python" -m faceapp_worker.demo.build --out "$ALBUM" 2>/dev/null | tail -3

echo "==> operator account"
curl -s -c "$JAR" -b "$JAR" -o /dev/null \
  -X POST "$BASE/api/auth/signup" -F "email=$EMAIL" -F "password=$PASSWORD" || true
curl -s -c "$JAR" -b "$JAR" -o /dev/null \
  -X POST "$BASE/api/auth/login" -F "email=$EMAIL" -F "password=$PASSWORD"

echo "==> event (marked as a demonstration)"
LOCATION="$(curl -s -c "$JAR" -b "$JAR" -o /dev/null -w '%{redirect_url}' \
  -X POST "$BASE/api/events" \
  -F "name=Tel Aviv Rooftop Party" -F "jurisdiction=IL" -F "retentionDays=30" \
  -F "isDemo=on")"
EVENT_ID="$(basename "$LOCATION")"
echo "    $EVENT_ID"

echo "==> uploading $(ls "$ALBUM"/photos/*.jpg | wc -l) photos"
ARGS=()
for photo in "$ALBUM"/photos/*.jpg; do ARGS+=(-F "files=@$photo;type=image/jpeg"); done
curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/api/events/$EVENT_ID/upload" "${ARGS[@]}"
echo

echo "==> waiting for the worker to index"
if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null; then
  for _ in $(seq 1 120); do
    REMAINING="$(psql "$DATABASE_URL" -tA -c \
      "select count(*) from ingest_jobs where event_id='$EVENT_ID' and state in ('pending','running')")"
    [ "$REMAINING" = "0" ] && break
    sleep 2
  done
  SLUG="$(psql "$DATABASE_URL" -tA -c "select slug from events where id='$EVENT_ID'")"
  echo
  psql "$DATABASE_URL" -c \
    "select name, status, photo_count, face_count, faces_rejected from events where id='$EVENT_ID'"
else
  # No database credentials here — poll the operator page instead. Slower and
  # coarser, but it is the only signal available when seeding a deployment from
  # a laptop, and it needs nothing but the session we already have.
  echo "    (no DATABASE_URL; polling the dashboard instead)"
  SLUG=""
  for _ in $(seq 1 150); do
    PAGE="$(curl -s -c "$JAR" -b "$JAR" "$BASE/events/$EVENT_ID")"
    SLUG="$(printf '%s' "$PAGE" | grep -oE '/e/[a-z0-9-]+' | head -1 | cut -d/ -f3)"
    printf '%s' "$PAGE" | grep -q 'Open for search' && break
    sleep 4
  done
fi

rm -f "$JAR"
echo
echo "operator   $EMAIL / $PASSWORD"
echo "attendee   $BASE/e/$SLUG"
echo "selfie     $ALBUM/selfies/  (should match $(python3 -c "
import json;print(len(json.load(open('$ALBUM/manifest.json'))['expected_matches']))") of 10 photos)"
echo
echo "This event is a DEMONSTRATION. Matching runs on placeholder thresholds and"
echo "every page says so. Do not read anything into the accuracy."
