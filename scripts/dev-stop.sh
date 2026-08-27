#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for pidfile in "$ROOT"/.dev/*.pid; do
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile")"
  name="$(basename "$pidfile" .pid)"
  if kill -0 "$pid" 2>/dev/null; then
    echo "stopping $name ($pid)"
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
done
