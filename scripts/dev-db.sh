#!/usr/bin/env bash
#
# Bring up a local Postgres with pgvector and apply every migration.
#
#   ./scripts/dev-db.sh          # create/reset the development database
#   ./scripts/dev-db.sh --keep   # start the server, leave data alone
#
# This is the "you do not need a Supabase project to run this" path. On a real
# deployment, `supabase db push` applies the same migrations.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${FACEAPP_DB:-faceapp}"

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

psql_q() { psql -v ON_ERROR_STOP=1 -q --no-psqlrc "$@"; }

# Start the cluster if it is not already up. Debian/Ubuntu layout; on macOS with
# Homebrew this is `brew services start postgresql@16` and the check still works.
if ! pg_isready -q 2>/dev/null; then
  echo "==> starting postgres"
  if command -v pg_ctlcluster >/dev/null; then
    pg_ctlcluster 16 main start 2>/dev/null || true
  fi
  for _ in $(seq 1 20); do
    pg_isready -q 2>/dev/null && break
    sleep 0.5
  done
fi

if ! pg_isready -q 2>/dev/null; then
  echo "postgres is not running and could not be started" >&2
  exit 1
fi

if [ "${1:-}" = "--keep" ]; then
  echo "==> postgres is up; leaving '$DB' alone"
  exit 0
fi

echo "==> rebuilding '$DB'"
psql_q -d postgres -c "drop database if exists \"$DB\" with (force)" >/dev/null
psql_q -d postgres -c "create database \"$DB\"" >/dev/null

# auth.users, auth.uid() and the anon/authenticated/service_role roles. Supplied
# by Supabase on a real project; recreated here so the same migrations apply.
psql_q -d "$DB" -f "$ROOT/supabase/tests/lib/local_shim.sql" >/dev/null

echo "==> applying migrations"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  printf '    %s\n' "$(basename "$migration")"
  psql_q -d "$DB" -f "$migration" >/dev/null
done

echo "==> ready: postgres://$PGUSER@$PGHOST:$PGPORT/$DB"
