# Ops3 Capacity Test Plan

This folder contains the mixed-workload `k6` scenario for measuring how many concurrent users the current seeded system can handle.

## Current Seed Reality

- `seed:test-users` now creates `300` realistic usernames.
- Password pattern is `username@123`.
- The current access seeding is index-based:
  - seed ordinals `46..50` and `95..99` are HR
  - every other ordinal is CRM
- CRM users `71..85` can create; `86..94` have full CRUD plus `view_all` and `modify_all`; all other CRM users are read-only.

That means the capacity tests in this folder intentionally use:
- `10` HR users
- the remaining non-admin concurrency as CRM users

This matches the current seeded permissions without altering the data model.

## Before Running

1. Seed users and metadata:
   - `npm run seed:industry-suite`
   - `npm --workspace @core-platform/service run seed:test-users`
2. Start the stack in load-test mode:
   - [start-loadtest-stack.bat](/c:/repos/core-platform/tests/load/ops3/start-loadtest-stack.bat)
   - Linux API-only: `./scripts/start-server-loadtest.sh`
3. Verify `k6` is installed and available on PATH.
4. By default the runners target the local service at `http://localhost:5001`, and auth uses the same base.
5. For deployed environments, override `API_BASE` and `AUTH_API_BASE` with the App Service origin. For the supplied sandbox, both are `https://bulkseed01.bcp.acchindra.com` (do not append `/api`; the test adds its route paths itself).
6. Optional deployed throttling knobs are available via `INITIAL_LOGIN_SPREAD_MS`, `LOGIN_MAX_ATTEMPTS`, and `LOGIN_RETRY_BASE_MS`. Their defaults preserve the original local test behavior.

Load-test mode raises the auth/login throttle so local `k6` login bursts do not get blocked by the default `10 per IP per 15 minutes` protection.

## Test Progression

Run the tests in this order:

1. [run-100-users.bat](/c:/repos/core-platform/tests/load/ops3/run-100-users.bat)
   - Linux: `./tests/load/ops3/run-100-users.sh`
2. [run-150-users.bat](/c:/repos/core-platform/tests/load/ops3/run-150-users.bat)
3. [run-200-users.bat](/c:/repos/core-platform/tests/load/ops3/run-200-users.bat)
4. [run-250-users.bat](/c:/repos/core-platform/tests/load/ops3/run-250-users.bat)
5. [run-300-users.bat](/c:/repos/core-platform/tests/load/ops3/run-300-users.bat)

Or run the full staged sequence in one shot:

- [run-all-capacity-tests.bat](/c:/repos/core-platform/tests/load/ops3/run-all-capacity-tests.bat)

### Sandbox runner (Windows PowerShell)

Use [run-sandbox-load-test.ps1](/c:/repos/core-platform/tests/load/ops3/run-sandbox-load-test.ps1) for the supplied sandbox. It is the preferred runner because it requires your admin credentials from the current shell, uses all 300 seeded identities, spreads the initial login burst across one minute, and keeps credentials out of repository files.

```powershell
$env:ADMIN_USERNAME = "<your-admin-username>"
$env:ADMIN_PASSWORD = "<your-admin-password>"
```

Use this short-lived plain process environment variable only immediately before the runs, then clear it afterwards:

```powershell
.\tests\load\ops3\run-sandbox-load-test.ps1 -Users 100
.\tests\load\ops3\run-sandbox-load-test.ps1 -Users 200
.\tests\load\ops3\run-sandbox-load-test.ps1 -Users 300
Remove-Item Env:ADMIN_PASSWORD
```

Each script:
- loads the shared `300`-user pool from [user-pool-300.cmd](/c:/repos/core-platform/tests/load/ops3/user-pool-300.cmd)
- sets `SEEDED_USER_POOL_LIMIT=300` and `REQUIRE_UNIQUE_USERS=1` so each Shockwave VU uses a distinct seeded user
- keeps the `100`-user profile within the seeded pool limits: `10` HR and `83` CRM Shockwave users, plus `7` admin/admin-shockwave users
- runs for the supplied `DURATION` (the sandbox runner defaults to `15m`; pass `-Duration 2m` for a smoke test)
- writes the latest HTML summary to `ops3-summary.html`
- copies that summary into `reports/`

## Pass/Fail Guidance

Treat a level as supported only if all of these hold:

- `http_req_failed` stays below your agreed limit
- latency remains acceptable, especially `p95`
- there are no repeated `429` bursts, auth failures, or server crashes
- service and database CPU, memory, and connection counts remain stable
- business actions still succeed correctly

## Result Files

After each run, review:

- `reports/ops3-100-users-summary.html`
- `reports/ops3-150-users-summary.html`
- `reports/ops3-200-users-summary.html`
- `reports/ops3-250-users-summary.html`
- `reports/ops3-300-users-summary.html`
- matching `*.json` files with complete k6 metrics for automated comparison

The highest level that stays healthy is your current measured capacity.
