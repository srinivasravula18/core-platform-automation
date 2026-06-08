#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo
echo "== TestFlowAI stop =="
echo

# Stop processes recorded by run.sh, if any.
for name in backend frontend; do
  pid_file=".run/${name}.pid"
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "Stopping $name (PID $pid)..."
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
done

# Fall back to anything still listening on the app ports.
echo "Stopping any remaining listeners on ports 3000 and 3001..."
for port in 3000 3001; do
  pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
  fi
done

echo
echo "TestFlowAI stopped."
