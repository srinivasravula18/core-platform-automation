#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo
echo "== TestFlowAI restart =="
echo

# Stop any running instance, then start fresh.
bash ./stop.sh

echo
echo "Restarting TestFlowAI..."
exec bash ./run.sh
