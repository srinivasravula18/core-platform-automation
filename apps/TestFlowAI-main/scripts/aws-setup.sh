#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f ".env" ]; then
  cp .env.example .env
  cat >> .env <<'ENV'

DATABASE_URL=postgres://postgres@localhost:5432/testflowai
BACKEND_PORT=3001
VITE_BACKEND_URL=http://localhost:3001
ENV
fi

npm ci

if [ "${START_LOCAL_DB:-true}" = "true" ]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose up -d db
  else
    echo "Docker Compose is not available. Set START_LOCAL_DB=false and DATABASE_URL to an external Postgres database." >&2
    exit 1
  fi
fi

npm run build
