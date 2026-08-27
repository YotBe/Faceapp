#!/usr/bin/env bash
#
# Phase 0 acceptance tests.
#
#   * migrations apply clean
#   * RLS blocks cross-operator reads
#   * the retention job deletes an expired event end to end
#
# Builds a scratch database from scratch every run, applies the real migrations
# in order, then runs each test file. Needs nothing but psql and a Postgres with
# pgvector.
#
#   ./supabase/tests/run.sh
#   PGHOST=... PGUSER=... ./supabase/tests/run.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
TESTS="$ROOT/supabase/tests"

DB="${FACEAPP_TEST_DB:-faceapp_test}"
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

psql_q() { psql -v ON_ERROR_STOP=1 -q --no-psqlrc "$@"; }

echo "==> rebuilding scratch database '$DB'"
psql_q -d postgres -c "drop database if exists \"$DB\" with (force)" >/dev/null
psql_q -d postgres -c "create database \"$DB\"" >/dev/null

echo "==> local Supabase shim"
psql_q -d "$DB" -f "$TESTS/lib/local_shim.sql" >/dev/null

echo "==> applying migrations"
shopt -s nullglob
for m in "$MIGRATIONS"/*.sql; do
  printf '    %s\n' "$(basename "$m")"
  psql_q -d "$DB" -f "$m" >/dev/null
done

echo "==> assertion helpers"
psql_q -d "$DB" -f "$TESTS/lib/assert.sql" >/dev/null

failed=0
for t in "$TESTS"/[0-9]*.sql; do
  echo
  echo "==> $(basename "$t")"
  # -t -A: the helpers return their label as text, one clean line per assertion.
  if ! psql_q -t -A -d "$DB" -f "$t"; then
    failed=1
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "All Phase 0 acceptance tests passed."
