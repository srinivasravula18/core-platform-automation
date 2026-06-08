#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export BACKEND_PORT="${BACKEND_PORT:-3001}"
export VITE_BACKEND_URL="${VITE_BACKEND_URL:-http://localhost:3001}"

if [ "${START_LOCAL_DB:-true}" = "true" ]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose up -d db
  else
    echo "Docker Compose is not available. Set START_LOCAL_DB=false and DATABASE_URL to an external Postgres database." >&2
    exit 1
  fi
fi

npm run start:backend &
BACKEND_PID=$!

npm run start:frontend &
FRONTEND_PID=$!

trap 'kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true' EXIT
wait -n "$BACKEND_PID" "$FRONTEND_PID"
