# TestFlowAI

## Playwright runtime

This app uses Playwright at runtime, not only in tests. The repo now installs the
required Chromium browser automatically during `npm install` via `postinstall`.

On a fresh Linux host, if Chromium still fails to launch because OS packages are
missing, run:

```bash
npm run playwright:deps
```

If you intentionally need to skip browser download during install, set:

```bash
SKIP_PLAYWRIGHT_BROWSER_INSTALL=1
```

## Gylin production integration

TestFlow exposes `POST /api/gylin/runs` only when `GYLIN_INTEGRATION_ENABLED=true`. The endpoint authenticates with its own Bearer token before parsing the request and then resolves the requested URL to one configured TestFlow App. It reuses the normal LangGraph and Playwright runtime; arbitrary targets, credentials, repository paths, and human APIs are not exposed.

Required production configuration:

```text
GYLIN_INTEGRATION_ENABLED=true
GYLIN_INTEGRATION_TOKEN=<32-byte-or-stronger secret-manager value>
TESTFLOW_PUBLIC_URL=https://testflow.company.example
```

Configure the same secret in Gylin as `TEST_FLOW_TOKEN`, set its endpoint to `https://testflow.company.example/api/gylin/runs`, and ensure the deployed candidate URL exactly matches one TestFlow App `baseUrl`. That App's owning Project supplies repository grounding and owner-scoped credentials.

Roll out disabled first, enable one pilot project, and repeat the same request to confirm it returns the same `runId`. Roll back by setting `GYLIN_INTEGRATION_ENABLED=false` and restarting TestFlow; completed runs, evidence, and receipts remain audit records.
