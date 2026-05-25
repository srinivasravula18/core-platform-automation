# Core Platform Automation

Standalone Playwright and HTML dashboard automation for Core Platform list-view E2E testing.

## Application Under Test

By default this automation project targets:

```text
D:\core-platform
```

Override it when needed:

```powershell
$env:CORE_PLATFORM_ROOT="D:\core-platform"
```

## First-Time Setup

Install automation dependencies inside this folder:

```powershell
cd D:\core-platform-automation
npm install
npx playwright install chromium
```

## Start The HTML E2E Dashboard

```powershell
npm run start
```

Open:

```text
http://127.0.0.1:5372/
```

The dashboard is now a modular React web app with a side navigation layout, light/dark theme support, suite/scenario/test-case navigation, execution controls, report and bug views, and an AI Agent section for scanning `CORE_PLATFORM_ROOT` changes.

Build the dashboard without starting the server:

```powershell
npm run build:dashboard
```

Run the Vite development server for dashboard UI work:

```powershell
npm run dev:dashboard
```

This starts only the standalone HTML test dashboard from this automation folder. The dashboard shows a live Services card for API `5001`, Admin `5002`, and Shockwave/Keystone `5003` so you can see whether each service is up before running tests.

To start missing Core Platform services automatically and then open the dashboard:

```powershell
npm run test:ui:list-view:env
```

## Run Suites From Terminal

```powershell
npm run test:ui:list-view:admin
npm run test:ui:list-view:keystone
npm run test:ui:list-view:api
npm run test:ui:list-view:full
```

Focused scenario runs:

```powershell
npm run test:ui:list-view:admin:lifecycle
npm run test:ui:list-view:keystone:lifecycle
npm run test:ui:list-view:workflow
npm run test:ui:list-view:settings
npm run test:ui:list-view:search
```

The HTML dashboard also has scenario checkboxes so QA can choose shell/toolbar, search, settings, resize/fit, row navigation, lifecycle/recycle bin, multi-step workflows, exports, or API/security before clicking a run button. Use the Selectable Test Inventory to tick exact test cases and run only those selected cases.

Headed runs:

```powershell
npm run test:ui:list-view:admin:headed
npm run test:ui:list-view:keystone:headed
npm run test:ui:list-view:full:headed
```

List test inventory without executing:

```powershell
npm run test:ui:list-view:list
```

## Stop Everything

```powershell
npm run stop:all
```

This stops the Core Platform app stack from `CORE_PLATFORM_ROOT` and the standalone dashboard on `5372`.

## Evidence And Reports

Reports are written under this automation folder:

```text
D:\core-platform-automation\tests\e2e\reports\list-view-regression\
```

Screenshots are written here:

```text
D:\core-platform-automation\tests\e2e\reports\list-view-regression\assets\
```

## More Documentation

See:

```text
docs\testing\list-view-e2e-environment.md
docs\testing\ui-regression-commands.md
```
