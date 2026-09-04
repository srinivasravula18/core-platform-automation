#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d "reports" ]]; then
  mkdir reports
fi

REPO_ENV="../../../.env"
if [[ -f "$REPO_ENV" ]]; then
  while IFS='=' read -r key value; do
    key="${key%%[[:space:]]*}"
    [[ -z "$key" || "$key" == \#* ]] && continue
    value="${value%$'\r'}"
    if [[ "$key" == "ADMIN_USERNAME" && -z "${ADMIN_USERNAME:-}" ]]; then
      export ADMIN_USERNAME="$value"
    fi
    if [[ "$key" == "ADMIN_PASSWORD" && -z "${ADMIN_PASSWORD:-}" ]]; then
      export ADMIN_PASSWORD="$value"
    fi
  done < "$REPO_ENV"
fi

if [[ -z "${USER_POOL:-}" && -f "user-pool-300.cmd" ]]; then
  export USER_POOL="$(sed -n 's/^set USER_POOL=//p' user-pool-300.cmd | tr -d '\r')"
fi

export API_BASE="http://localhost:5001"
export SETUP_WAIT_SECONDS="${SETUP_WAIT_SECONDS:-2}"
export DURATION="${DURATION:-2m}"
export ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
export SETUP_DESCRIBE="${SETUP_DESCRIBE:-1}"
export FAILURE_LOG_LIMIT="${FAILURE_LOG_LIMIT:-50}"
export SEEDED_USER_POOL_LIMIT="${SEEDED_USER_POOL_LIMIT:-300}"
export REQUIRE_UNIQUE_USERS="${REQUIRE_UNIQUE_USERS:-1}"
export SKIP_LIST_TABS="${SKIP_LIST_TABS:-1}"
export QUERY_LIST_VIEW_EVERY="${QUERY_LIST_VIEW_EVERY:-3}"
export SKIP_QUERY_LIST_VIEW="${SKIP_QUERY_LIST_VIEW:-0}"
export SKIP_FILE_OPS="${SKIP_FILE_OPS:-1}"
export MIN_ITERATION_MS="${MIN_ITERATION_MS:-200}"
export CRM_OBJECT_API="${CRM_OBJECT_API:-account}"
export HR_OBJECT_API="${HR_OBJECT_API:-department}"
export ADMIN_APP_VUS="${ADMIN_APP_VUS:-2}"
export SHOCKWAVE_ADMIN_VUS="${SHOCKWAVE_ADMIN_VUS:-5}"
export CRM_VUS="${CRM_VUS:-83}"
export HR_VUS="${HR_VUS:-10}"

k6 run "real-time-ops3-test.js"

if [[ -f "ops3-summary.html" ]]; then
  cp -f "ops3-summary.html" "reports/ops3-100-users-summary.html"
fi
