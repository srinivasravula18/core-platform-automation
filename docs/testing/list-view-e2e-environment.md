# Standalone Folder Note

This copy lives in `D:\core-platform-automation`. It runs automation from this folder and targets the application under test through `CORE_PLATFORM_ROOT`, defaulting to `D:\core-platform`.

Install dependencies in this folder before running Playwright:

```powershell
cd D:\core-platform-automation
npm install
npx playwright install chromium
```

Then start the dashboard:

```powershell
npm run test:ui:list-view:env
```

---
# List View E2E Test Environment

This document explains the dedicated HTML dashboard and Playwright pipeline for list-view end-to-end testing. It is intended for developers and QA engineers who need to run, debug, or extend the Admin and Keystone list-view suites.

## Purpose

The list-view E2E environment provides one local place to:

- Run Admin list-view regression.
- Run Keystone/Shockwave list-view regression.
- Run list-view API contract regression.
- Run the full list-view regression pipeline.
- Watch live terminal output while tests execute.
- See every generated test case, status, priority, testing level, expected result, actual result, evidence, and bug report.
- Open HTML, CSV, JSON, PDF, and screenshot evidence from the browser.
- Stop a running test pipeline from the dashboard.

## Local Ports

The environment expects the local stack to use fixed ports:

```text
Service API:        http://localhost:5001
Admin App:          http://localhost:5002
Keystone/Shockwave: http://localhost:5003
E2E Dashboard:      http://127.0.0.1:5372
```

Admin and Keystone Vite dev servers use `strictPort` so they fail fast instead of silently moving to another port. If an old process is already using a port, stop the stack first.

## Quick Start

Stop any old local stack:

```powershell
npm run stop:all
```

Start the dedicated list-view E2E environment:

```powershell
npm run test:ui:list-view:env
```

Open the dashboard:

```text
http://127.0.0.1:5372/
```

The dashboard starts the local Service, Admin, Keystone/Shockwave, and worker stack, then serves the HTML E2E dashboard on port `5372`.

## Dashboard Controls

The dashboard has these run buttons:

```text
Run Admin
Run Keystone
Run API
Run Full
Stop Run
```

Use `Run Admin` for Admin metadata list views.

Use `Run Keystone` for Keystone/Shockwave business-data object list views.

Use `Run API` for list-view backend contract tests.

Use `Run Full` for Admin, Keystone, and API list-view regression together.

Use `Stop Run` to terminate the currently running Playwright pipeline and child processes. The button is available in the top header and in the run-control panel.

The dashboard also includes:

- Run status cards.
- Manual scenario selection for shell/toolbar, search, settings, resize/fit, row navigation, lifecycle/recycle bin, multi-step workflows, exports, and API/security.
- Selectable test inventory so a tester can tick one or more exact test cases and run only those cases.
- Pending/running/pass/fail/skip counts.
- Testing level reference for BVT, Sanity, and Regression.
- Full test-case inventory.
- Bug report table for failed cases.
- Live output from the running PowerShell/Playwright process.
- Links to HTML, CSV, and PDF reports.

## Terminal Commands

Run the full list-view pipeline with database reset and seed:

```powershell
npm run test:ui:list-view:full
```

Run the full list-view pipeline without database reset:

```powershell
npm run test:ui:list-view:full:no-reset
```

Run Admin list-view tests only:

```powershell
npm run test:ui:list-view:admin
```

Run Admin list-view tests with a visible browser:

```powershell
npm run test:ui:list-view:admin:headed
```

Run the disposable Admin app lifecycle and recycle-bin checks:

```powershell
npm run test:ui:list-view:admin:lifecycle
```

Run Keystone/Shockwave list-view tests only:

```powershell
npm run test:ui:list-view:keystone
```

Run Keystone/Shockwave list-view tests with a visible browser:

```powershell
npm run test:ui:list-view:keystone:headed
```

Run the disposable Keystone record lifecycle and recycle-bin checks:

```powershell
npm run test:ui:list-view:keystone:lifecycle
```

Run settings-focused coverage across Admin and Keystone:

```powershell
npm run test:ui:list-view:settings
```

Run search-focused coverage across Admin and Keystone:

```powershell
npm run test:ui:list-view:search
```

Run multi-step workflow coverage:

```powershell
npm run test:ui:list-view:workflow
```

Run any scenario filter manually:

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\scripts\run-list-view-regression.ps1 -Surface all -SkipReset -Scenario "Search|Settings modal|@lifecycle"
```

Run list-view API contract tests only:

```powershell
npm run test:ui:list-view:api
```

Start only the report dashboard against existing reports:

```powershell
npm run test:ui:list-view:report
```

List all tests without executing them:

```powershell
npx playwright test --list -c tests/e2e/playwright.list-view-regression.config.ts
```

Run one spec directly:

```powershell
npx playwright test tests/e2e/list-view-regression/admin-list-view.spec.ts -c tests/e2e/playwright.list-view-regression.config.ts --workers=1
npx playwright test tests/e2e/list-view-regression/keystone-list-view.spec.ts -c tests/e2e/playwright.list-view-regression.config.ts --workers=1
npx playwright test tests/e2e/list-view-regression/list-view-api.spec.ts -c tests/e2e/playwright.list-view-regression.config.ts --workers=1
```

Run one test by title:

```powershell
npx playwright test tests/e2e/list-view-regression/admin-list-view.spec.ts -g "Admin Objects toolbar" -c tests/e2e/playwright.list-view-regression.config.ts --workers=1
```

Run with explicit credentials:

```powershell
$env:TEST_ADMIN_USERNAME="admin"
$env:TEST_ADMIN_PASSWORD="admin"
npm run test:ui:list-view:admin
```

## Credentials

The list-view suite defaults to:

```text
Username: admin
Password: admin
```

You can override these values:

```powershell
$env:TEST_ADMIN_USERNAME="admin"
$env:TEST_ADMIN_PASSWORD="admin"
```

The suite uses a shared authenticated Playwright storage state so UI tests do not submit the login form for every case. This avoids repeated login rate limits and keeps screenshots focused on the feature under test instead of the login screen.

## Reports And Evidence

Reports are written to:

```text
tests/e2e/reports/list-view-regression/
```

Main report files:

```text
tests/e2e/reports/list-view-regression/list-view-regression-results.html
tests/e2e/reports/list-view-regression/list-view-regression-results.csv
tests/e2e/reports/list-view-regression/list-view-regression-results.json
tests/e2e/reports/list-view-regression/list-view-regression-results.pdf
```

Screenshot evidence is written to:

```text
tests/e2e/reports/list-view-regression/assets/
```

Dashboard report links:

```text
http://127.0.0.1:5372/report
http://127.0.0.1:5372/report/list-view-regression-results.html
```

Screenshot links use this pattern:

```text
http://127.0.0.1:5372/report/assets/<screenshot-file-name>.png
```

Every test row includes evidence. UI tests attach screenshot evidence. API-only tests include assertion evidence notes because they do not render a browser page.

## Test Case Format

Generated test reports follow this standard structure:

```text
Test Case ID
Module / Suite
Test Case Title
Pre-conditions
Test Steps
Test Data
Expected Result
Actual Result
Status
Priority
Testing Level
Automation Status
Evidence
Bug Report
```

ID conventions:

```text
BVT_[MODULE]_[NUMBER]
SAN_[MODULE]_[NUMBER]
REG_[MODULE]_[NUMBER]
```

Testing levels:

```text
BVT:        Core build verification checks.
Sanity:     Narrow feature or fix checks.
Regression: Full existing behavior checks before release or major merge.
```

## Files

Playwright config:

```text
tests/e2e/playwright.list-view-regression.config.ts
```

Shared authentication setup:

```text
tests/e2e/list-view.auth.setup.ts
```

List-view E2E specs:

```text
tests/e2e/list-view-regression/admin-list-view.spec.ts
tests/e2e/list-view-regression/keystone-list-view.spec.ts
tests/e2e/list-view-regression/list-view-api.spec.ts
tests/e2e/list-view-regression/helpers.ts
```

HTML dashboard:

```text
tests/e2e/list-view-test-environment/index.html
tests/e2e/list-view-test-environment/styles.css
tests/e2e/list-view-test-environment/app.js
```

Dashboard server and runner scripts:

```text
tests/scripts/serve-list-view-report.mjs
tests/scripts/start-list-view-report.ps1
tests/scripts/start-list-view-test-environment.ps1
tests/scripts/run-list-view-regression.ps1
```

Custom report generator:

```text
tests/e2e/helpers/table-report.ts
```

## Adding Or Updating Tests

Add Admin list-view coverage in:

```text
tests/e2e/list-view-regression/admin-list-view.spec.ts
```

Add Keystone/Shockwave list-view coverage in:

```text
tests/e2e/list-view-regression/keystone-list-view.spec.ts
```

Add backend/API contract coverage in:

```text
tests/e2e/list-view-regression/list-view-api.spec.ts
```

Use annotations in the test title so the report can populate the test case table:

```ts
test("Admin Objects toolbar works [surface: Admin] [feature: Toolbar controls] [precondition: Objects list view is open] [input: inspect list selector, search, New, Delete, refresh, settings, CSV, PDF] [expected: every primary toolbar control is present] [proof: reference toolbar behavior is covered]", async ({ page }) => {
  // test steps
});
```

Keep Admin tests scoped to metadata views. Admin tests must not open or assert business data records.

Keep Keystone/Shockwave tests scoped to runtime business-object list views and generated metadata-driven object pages.

### Creating A New Scenario

1. Add the Playwright test to the Admin, Keystone, or API spec.
2. Put the report fields in the title: `[surface: ...] [feature: ...] [precondition: ...] [input: ...] [expected: ...] [proof: ...]`.
3. Add a searchable scenario word or tag in the title, such as `@lifecycle`, `@recycle`, `Search`, `Settings modal`, `Column resize`, or `Export`.
4. For destructive tests, create a unique disposable record/app inside the test and delete or purge only that matching automation data.
5. Attach before/after evidence around major UI changes with `attachEvidence`; the suite also captures a final screenshot for each UI test.
6. If the scenario needs a dashboard checkbox, add its grep expression to `tests/e2e/list-view-test-environment/index.html`.

### Multi-Step Workflow Cases

A test case can represent a full user journey with many steps. Prefer this pattern for time-saving regression workflows where the value is in proving the connected path, for example:

```text
Open Apps -> create disposable app -> select app row -> edit label -> save -> delete -> restore from Recycle Bin -> verify restored -> cleanup purge
```

Use `@workflow` in the test title for these connected journeys. The dashboard exposes a Multi-step workflows scenario checkbox and the terminal command `npm run test:ui:list-view:workflow`.

## Troubleshooting

If the dashboard does not show the latest HTML or the `Stop Run` button:

```powershell
npm run test:ui:list-view:env
```

Then hard refresh:

```text
http://127.0.0.1:5372/
```

If Admin opens on the dashboard port or a wrong port, stop old processes and restart:

```powershell
npm run stop:all
npm run test:ui:list-view:env
```

If screenshots all show the login page, the suite is not using the shared authenticated storage state or the previous run hit auth rate limits. Restart the stack and rerun:

```powershell
npm run stop:all
npm run test:ui:list-view:env
npm run test:ui:list-view:admin
```

If the report dashboard is running but test counts do not update, check the JSON report:

```text
tests/e2e/reports/list-view-regression/list-view-regression-results.json
```

If a run fails before Playwright starts, inspect the live output panel in the dashboard and the PowerShell terminal that launched the environment.
