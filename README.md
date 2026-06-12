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
