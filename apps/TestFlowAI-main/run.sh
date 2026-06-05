#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo
echo "== TestFlowAI local run =="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found in PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH."
  exit 1
fi

if [ ! -f ".env.local" ]; then
  echo "Creating .env.local from .env.example"
  if [ -f ".env.example" ]; then
    cp ".env.example" ".env.local"
  else
    : > ".env.local"
  fi
fi

echo "Installing node modules..."
npm install

echo "Building application..."
npm run build

echo "Stopping existing TestFlowAI listeners on ports 3000 and 3001..."
for port in 3000 3001; do
  pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
  fi
done

echo
echo "Frontend: http://localhost:3000/automation/"
echo "Backend:  http://localhost:3001"
if grep -q '^DATABASE_URL=' ".env.local" 2>/dev/null; then
  echo "Database: DATABASE_URL from .env.local"
elif grep -q '^DATABASE_URL=' ".env" 2>/dev/null; then
  echo "Database: DATABASE_URL from .env"
else
  echo "Database: JSON file persistence .testflow-data.json"
  echo "To use Postgres locally, add DATABASE_URL to .env.local before running this file."
fi
echo

mkdir -p .run

bash -lc 'npm run start:backend' > .run/backend.log 2>&1 &
backend_pid=$!
echo "$backend_pid" > .run/backend.pid

bash -lc 'npm run start:frontend' > .run/frontend.log 2>&1 &
frontend_pid=$!
echo "$frontend_pid" > .run/frontend.pid

sleep 5

echo "Backend PID:  $backend_pid"
echo "Frontend PID: $frontend_pid"
echo "Logs:"
echo "  .run/backend.log"
echo "  .run/frontend.log"
echo
echo "Run complete. TestFlowAI is running."

cleanup() {
  kill "$backend_pid" "$frontend_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM
wait "$backend_pid" "$frontend_pid"
