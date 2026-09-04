#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

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

export API_BASE="${API_BASE:-http://localhost:5001}"
export AUTH_API_BASE="${AUTH_API_BASE:-$API_BASE}"
export SETUP_WAIT_SECONDS="30"
export DURATION="${DURATION:-1m}"
export INITIAL_LOGIN_SPREAD_MS="${INITIAL_LOGIN_SPREAD_MS:-0}"
export LOGIN_MAX_ATTEMPTS="${LOGIN_MAX_ATTEMPTS:-1}"
export LOGIN_RETRY_BASE_MS="${LOGIN_RETRY_BASE_MS:-1000}"
export ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
export SEEDED_USER_POOL_LIMIT="${SEEDED_USER_POOL_LIMIT:-300}"
export REQUIRE_UNIQUE_USERS="${REQUIRE_UNIQUE_USERS:-1}"
export ADMIN_APP_VUS="${ADMIN_APP_VUS:-2}"
export SHOCKWAVE_ADMIN_VUS="${SHOCKWAVE_ADMIN_VUS:-5}"
export CRM_VUS="${CRM_VUS:-83}"
export HR_VUS="${HR_VUS:-10}"

k6 run "real-time-ops3-test.js"
