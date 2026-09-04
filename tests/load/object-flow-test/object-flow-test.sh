#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export API_BASE="${API_BASE:-https://ops.acchindra.com}"
export ADMIN_USERNAME="admin"
export ADMIN_PASSWORD="change-me"

k6 run "object-flow-test.js"
