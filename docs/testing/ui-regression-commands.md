# UI Regression Test Commands

This document captures the local UI regression commands for Admin and Shockwave testing.

## Full Local UI Regression

Run the full local UI regression suite:

```powershell
npm run test:ui:local-regression
```

This command resets and seeds the local database, starts the local stack, and runs the UI regression suite.

Note: this requires `psql` to be available in `PATH` because `scripts/reset-db.ps1` uses it.

## Run Without Database Reset

Run the UI regression suite against the current local database:

```powershell
npm run test:ui:local-regression:no-reset
```

Use this when the local database is already seeded or when `psql` is not available.

## Run With Visible Browser

Run the UI regression suite with the Chromium browser visible:

```powershell
npm run test:ui:local-regression:headed
```

The browser opens while Playwright runs the tests and closes when the run completes.

## Single Browser Journey

Run Admin and Keystone checks in one shared browser context instead of closing and reopening between test cases:

```powershell
npm run test:ui:single-browser
```

Run the same journey with a visible browser:

```powershell
npm run test:ui:single-browser:headed
```

Run it in Playwright debug mode:

```powershell
npm run test:ui:single-browser:debug
```

Use this mode when you want to watch the script move through Admin and Keystone continuously in one Chromium window. The normal regression suite still uses isolated pages for reliability.

## Report Output

The UI regression suite writes reports here:

```text
tests/e2e/reports/ui-regression/
```

Primary CSV report:

```text
tests/e2e/reports/ui-regression/ui-regression-results.csv
```

Additional reports:

```text
tests/e2e/reports/ui-regression/ui-regression-results.html
tests/e2e/reports/ui-regression/ui-regression-results.pdf
```

Report files and screenshots are ignored by Git.

## Specific Component Or Feature Testing

### Admin App Regression

Run only Admin UI regression tests:

```powershell
npm run test:ui:admin
```

Run Admin UI regression with a visible browser:

```powershell
npm run test:ui:admin:headed
```

Run Admin UI regression in Playwright debug mode:

```powershell
npm run test:ui:admin:debug
```

### Admin List View Regression

Run the focused Admin list-view test:

```powershell
npm run test:ui:admin:list-view
```

Run the focused Admin list-view test with a visible browser:

```powershell
npm run test:ui:admin:list-view:headed
```

### List View Regression

This is the primary command set for the dedicated list-view testing pipeline. The suite uses `admin` / `admin` as the default local test credential unless `TEST_ADMIN_USERNAME` and `TEST_ADMIN_PASSWORD` are set in the terminal.

For the full developer guide to the HTML E2E dashboard, files, evidence, and extension workflow, see:

```text
docs/testing/list-view-e2e-environment.md
```

Before running tests against an old local stack, stop existing dev servers so Admin stays on `5002`, Keystone/Shockwave stays on `5003`, and the report dashboard stays on `5372`:

```powershell
npm run stop:all
```

Start the dedicated list-view testing environment:

```powershell
npm run test:ui:list-view:env
```

Open the dashboard:

```text
http://127.0.0.1:5372/
```

From the dashboard you can run Admin, Keystone, API, or Full list-view suites, watch live output, open reports, review test cases under execution, and use `Stop Run` to terminate the current test pipeline.

Terminal commands for each test suite:

Run the full focused list-view regression suite across Admin, Keystone, and list-view API contracts:

```powershell
npm run test:ui:list-view:full
```

This command resets/seeds the local database, starts the local stack, runs the focused list-view suite, and writes HTML/CSV/PDF reports with screenshot evidence under:

```text
tests/e2e/reports/list-view-regression/
```

Run the same focused suite against the current database without reset:

```powershell
npm run test:ui:list-view:full:no-reset
```

Run only Admin list-view regression:

```powershell
npm run test:ui:list-view:admin
```

Run only Admin list-view regression with the browser visible:

```powershell
npm run test:ui:list-view:admin:headed
```

Run only Keystone/Shockwave list-view regression:

```powershell
npm run test:ui:list-view:keystone
```

Run only Keystone/Shockwave list-view regression with the browser visible:

```powershell
npm run test:ui:list-view:keystone:headed
```

Run only list-view API contract regression:

```powershell
npm run test:ui:list-view:api
```

Run Playwright discovery without executing the suite:

```powershell
npx playwright test --list -c tests/e2e/playwright.list-view-regression.config.ts
```

Run one exact list-view spec directly:

```powershell
npx playwright test tests/e2e/list-view-regression/admin-list-view.spec.ts -c tests/e2e/playwright.list-view-regression.config.ts --workers=1
npx playwright test tests/e2e/list-view-regression/keystone-list-view.spec.ts -c tests/e2e/playwright.list-view-regression.config.ts --workers=1
npx playwright test tests/e2e/list-view-regression/list-view-api.spec.ts -c tests/e2e/playwright.list-view-regression.config.ts --workers=1
```

Run one test by title:

```powershell
npx playwright test tests/e2e/list-view-regression/admin-list-view.spec.ts -g "Admin Objects toolbar" -c tests/e2e/playwright.list-view-regression.config.ts --workers=1
```

Run with explicit local credentials:

```powershell
$env:TEST_ADMIN_USERNAME="admin"
$env:TEST_ADMIN_PASSWORD="admin"
npm run test:ui:list-view:admin
```

List-view report output:

```text
tests/e2e/reports/list-view-regression/list-view-regression-results.html
tests/e2e/reports/list-view-regression/list-view-regression-results.csv
tests/e2e/reports/list-view-regression/list-view-regression-results.json
tests/e2e/reports/list-view-regression/list-view-regression-results.pdf
```

Screenshot evidence output:

```text
tests/e2e/reports/list-view-regression/assets/
```

Dashboard report links:

```text
http://127.0.0.1:5372/report
http://127.0.0.1:5372/report/list-view-regression-results.html
```

The JSON/HTML/CSV reports include the standard test case fields: test case ID, module/suite, title, pre-conditions, test steps, test data, expected result, actual result, status, priority, testing level, automation status, evidence, and generated bug report.

Start the dedicated list-view test environment. This starts the local Service/Admin/Keystone stack, then keeps a local dashboard running where you can start Admin, Keystone, API, or full list-view runs and watch test cases, status, live output, reports, screenshots, and generated bug reports:

```powershell
npm run test:ui:list-view:env
```

Default URL:

```text
http://127.0.0.1:5372/
```

The dashboard has a `Stop Run` button in the top run-control panel next to the Admin, Keystone, API, and Full run buttons. It terminates the currently running Playwright pipeline and its child processes.

The report alias starts the same local environment and focuses on viewing the latest generated report:

```powershell
npm run test:ui:list-view:report
```

Default URL:

```text
http://127.0.0.1:5372/
```

Run only the current UI regression list-view test:

```powershell
npx playwright test tests/e2e/ui-regression/shockwave-ui-regression.spec.ts -g "list view" -c tests/e2e/playwright.ui-regression.config.ts
```

Run the same test with visible browser:

```powershell
$env:UI_REGRESSION_HEADED="1"; npx playwright test tests/e2e/ui-regression/shockwave-ui-regression.spec.ts -g "list view" -c tests/e2e/playwright.ui-regression.config.ts
```

### Existing Dedicated List View Specs

Run the older dedicated list-view Playwright specs:

```powershell
npm run test:ui:list-view
```

Run the same list-view specs with a visible browser:

```powershell
npm run test:ui:list-view:headed
```

Run the list-view specs in Playwright debug mode:

```powershell
npm run test:ui:list-view:debug
```

Debug mode is the best option when you need to actually watch and inspect the browser. It opens the Playwright inspector and pauses execution so the browser does not close immediately.

## Useful Playwright Filters

Run tests by title text:

```powershell
npx playwright test -g "System Settings" -c tests/e2e/playwright.ui-regression.config.ts
```

Run one spec file:

```powershell
npx playwright test tests/e2e/ui-regression/admin-ui-regression.spec.ts -c tests/e2e/playwright.ui-regression.config.ts
```

Run one exact test from a spec:

```powershell
npx playwright test tests/e2e/ui-regression/failure-path-ui-regression.spec.ts -g "invalid login" -c tests/e2e/playwright.ui-regression.config.ts
```

## Local URLs

When the stack is running:

```text
Admin:     http://localhost:5002
Shockwave: http://localhost:5003
Service:   http://localhost:5001
```

## Current Regression Coverage

The local UI regression suite covers:

- Admin screen navigation
- Admin create/edit modal entry points
- Admin System Settings labels and explanations
- Shockwave app launcher
- Shockwave tab picker
- Shockwave accessible tab rendering
- Shockwave list view controls
- Failure-path checks for invalid login, empty Admin create submission, and empty Agent message submission
