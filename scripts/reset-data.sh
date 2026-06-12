#!/usr/bin/env bash
# Test Flow AI — DATA RESET (destructive). Wipes Postgres tables + the local JSON
# persistence files, so the app re-seeds demo data and the admin/mark logins next start.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Test Flow AI — DATA RESET =="
echo "This DELETES ALL data:"
echo "  - Postgres: every table in the public schema is truncated"
echo "  - JSON: .testflow-data.json and .testflow-settings.json are removed"
echo "  (projects, cases, runs, reports, defects, app users, websites, knowledge, usage)"
echo "The app re-seeds demo data and recreates the admin/mark logins on next start."
echo

read -r -p "Type 'reset' to confirm: " ans
if [ "$ans" != "reset" ]; then
  echo "Aborted."
  exit 1
fi

RESET_CONFIRM=1 node scripts/reset-data.mjs
