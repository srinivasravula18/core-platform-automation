# Core Platform Automation

Standalone Playwright automation and HTML dashboard for Core Platform list-view end-to-end testing.

This repository is not the Core Platform application itself. It is a dedicated QA automation workspace that runs against a local Core Platform checkout, starts or checks the required services, executes Admin, Keystone/Shockwave, and API list-view suites, and publishes readable test evidence from one local dashboard.

## What This Application Does

Core Platform Automation provides a focused regression environment for list-view behavior across the Core Platform stack:

- Admin metadata list views.
- Keystone/Shockwave business-object list views.
- Backend list-view API contracts.
- Search, settings, toolbar, column, navigation, lifecycle, recycle-bin, workflow, export, validation, and security scenarios.
- Screenshot, HTML, CSV, JSON, and PDF evidence for executed test cases.
- A browser dashboard for running suites, selecting scenarios, watching live logs, reviewing results, and stopping active runs.
- Optional AI-agent assisted scenario generation when `GEMINI_API_KEY` is configured.

## USP

The main advantage of this project is that it turns list-view regression from a set of terminal-only Playwright commands into a guided QA workbench.

- **One dashboard for QA and developers**: Run Admin, Keystone, API, or full suites from `http://127.0.0.1:5372/`.
- **Live service visibility**: The dashboard checks API `5001`, Admin `5002`, and Keystone/Shockwave `5003` before and during testing.
- **Selectable coverage**: Run the full suite, one surface, one scenario group, or exact selected test cases.
- **Evidence-first reporting**: Each test case can include status, priority, level, expected result, actual result, screenshots, and generated bug-report details.
- **Standalone from the product repo**: Automation lives in its own folder and targets the product through `CORE_PLATFORM_ROOT`.
- **Repeatable local setup**: Scripts can reset/seed data, start the local stack, run tests, and serve reports with consistent ports.
- **Extensible Playwright structure**: Admin, Keystone, and API specs are separated so new coverage can be added without mixing product surfaces.

## Prerequisites

Install these before running this automation on a new machine.

### Required

- Windows machine with PowerShell.
- Node.js `20` or newer.
- npm.
- Git.
- Chromium browser dependencies installed through Playwright.
- A working local checkout of the Core Platform application.
- Core Platform app dependencies installed in the Core Platform checkout.
- The Core Platform scripts expected by this automation:
  - `scripts/start-all.ps1`
  - `scripts/stop-all.ps1`
  - `scripts/reset-db.ps1`
- Local database and any services required by the Core Platform app.
- Ports available locally:
  - Service API: `5001`
  - Admin: `5002`
  - Keystone/Shockwave: `5003`
  - Automation dashboard: `5372`
  - Dashboard Vite dev server: `5373`

### Required For Full Reset Runs

Full reset runs call the Core Platform database reset and seed scripts. Make sure the target Core Platform machine has the database tools and credentials needed by that application. If the Core Platform reset script uses `psql`, then `psql` must be available in `PATH`.

### Optional

- `GEMINI_API_KEY` for AI-agent scenario planning and generation.
- `GEMINI_MODEL` to override the default Gemini model.
- GitNexus tooling if you want the dashboard's optional code graph/proxy features.

## Folder Relationship

By default, this automation project expects the application under test here:

```text
D:\core-platform
```

This automation project lives here:

```text
D:\core-platform-automation
```

On another machine, the paths can be different. Set `CORE_PLATFORM_ROOT` to the local Core Platform application path:

```powershell
$env:CORE_PLATFORM_ROOT="D:\core-platform"
```

You can also put this value in `.env`.

## Environment Configuration

Copy the example file:

```powershell
copy .env.example .env
```

Common values:

```env
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
CORE_PLATFORM_ROOT=D:\core-platform
ADMIN_BASE_URL=http://localhost:5002
TEST_BASE_URL=http://localhost:5003
TEST_API_URL=http://localhost:5001
```

Default test login credentials are:

```text
Username: admin
Password: admin
```

Override them when needed:

```powershell
$env:TEST_ADMIN_USERNAME="admin"
$env:TEST_ADMIN_PASSWORD="admin"
```

## First-Time Setup

From the automation folder:

```powershell
cd D:\core-platform-automation
npm install
npx playwright install chromium
```

Make sure the Core Platform application checkout is also installed and runnable from `CORE_PLATFORM_ROOT`.

## How To Run

### Start Only The Automation Dashboard

Use this when the Core Platform services are already running or when you only want to view existing reports.

```powershell
npm run start
```

Open:

```text
http://127.0.0.1:5372/
```

### Start Missing Core Platform Services And Dashboard

Use this for the normal local QA flow. The script checks ports `5001`, `5002`, and `5003`; if any service is missing, it runs `scripts/start-all.ps1` from `CORE_PLATFORM_ROOT`, then starts the automation dashboard.

```powershell
npm run test:ui:list-view:env
```

Open:

```text
http://127.0.0.1:5372/
```

### Run Suites From Terminal

Run the full list-view regression suite with reset/seed:

```powershell
npm run test:ui:list-view:full
```

Run the full suite without resetting the database:

```powershell
npm run test:ui:list-view:full:no-reset
```

Run focused suites:

```powershell
npm run test:ui:list-view:admin
npm run test:ui:list-view:keystone
npm run test:ui:list-view:api
```

Run with a visible browser:

```powershell
npm run test:ui:list-view:admin:headed
npm run test:ui:list-view:keystone:headed
npm run test:ui:list-view:full:headed
```

Run focused scenario groups:

```powershell
npm run test:ui:list-view:admin:lifecycle
npm run test:ui:list-view:keystone:lifecycle
npm run test:ui:list-view:workflow
npm run test:ui:list-view:settings
npm run test:ui:list-view:search
```

List available Playwright tests without executing them:

```powershell
npm run test:ui:list-view:list
```

## Dashboard Usage

After starting the dashboard, use:

```text
http://127.0.0.1:5372/
```

From the dashboard you can:

- Check whether API, Admin, and Keystone/Shockwave are running.
- Run Admin, Keystone, API, or full list-view suites.
- Select scenario groups such as search, settings, lifecycle, workflow, exports, and API/security.
- Select exact test cases from the inventory.
- Watch live PowerShell and Playwright output.
- Stop the current run.
- View generated reports, screenshots, and bug details.
- Record or run saved scenarios where supported.
- Use AI-agent generation features when configured.

## Build Or Develop The Dashboard

Build the dashboard assets:

```powershell
npm run build:dashboard
```

Run the Vite development server for dashboard UI work:

```powershell
npm run dev:dashboard
```

Vite serves the dashboard source on:

```text
http://127.0.0.1:5373/
```

## Reports And Evidence

Reports are written under:

```text
tests\e2e\reports\list-view-regression\
```

Primary output files:

```text
tests\e2e\reports\list-view-regression\list-view-regression-results.html
tests\e2e\reports\list-view-regression\list-view-regression-results.csv
tests\e2e\reports\list-view-regression\list-view-regression-results.json
tests\e2e\reports\list-view-regression\list-view-regression-results.pdf
```

Screenshot evidence is written under:

```text
tests\e2e\reports\list-view-regression\assets\
```

Dashboard report URLs:

```text
http://127.0.0.1:5372/report
http://127.0.0.1:5372/report/list-view-regression-results.html
```

## Stop Everything

Stop the Core Platform app stack and the standalone dashboard:

```powershell
npm run stop:all
```

## Important Files

```text
package.json
vite.config.js
tests\scripts\start-list-view-test-environment.ps1
tests\scripts\run-list-view-regression.ps1
tests\scripts\serve-list-view-report.mjs
tests\e2e\playwright.list-view-regression.config.ts
tests\e2e\list-view-regression\admin-list-view.spec.ts
tests\e2e\list-view-regression\keystone-list-view.spec.ts
tests\e2e\list-view-regression\list-view-api.spec.ts
tests\e2e\helpers\table-report.ts
```

## Adding Or Updating Tests

Add Admin list-view coverage in:

```text
tests\e2e\list-view-regression\admin-list-view.spec.ts
```

Add Keystone/Shockwave list-view coverage in:

```text
tests\e2e\list-view-regression\keystone-list-view.spec.ts
```

Add backend/API contract coverage in:

```text
tests\e2e\list-view-regression\list-view-api.spec.ts
```

Use searchable words or tags in test titles so dashboard filters can target them, for example:

```text
Search
Settings modal
@lifecycle
@recycle
@workflow
Export
```

For destructive tests, create disposable automation data and clean up only the records created by the test.

## Troubleshooting

If the dashboard does not open, check whether port `5372` is already in use, then run:

```powershell
npm run stop:all
npm run test:ui:list-view:env
```

If Admin, Keystone, or the API runs on the wrong port, stop old local processes and restart the environment:

```powershell
npm run stop:all
npm run test:ui:list-view:env
```

If screenshots show only the login page, reset the environment and rerun with valid credentials:

```powershell
npm run stop:all
$env:TEST_ADMIN_USERNAME="admin"
$env:TEST_ADMIN_PASSWORD="admin"
npm run test:ui:list-view:env
npm run test:ui:list-view:admin
```

If Playwright is not installed on a new machine:

```powershell
npx playwright install chromium
```

If a reset run fails before tests start, verify the Core Platform checkout, database, seed scripts, and `CORE_PLATFORM_ROOT` path first.

## More Documentation

See:

```text
docs\testing\list-view-e2e-environment.md
docs\testing\ui-regression-commands.md
```
