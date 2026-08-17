import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

if (process.env.SKIP_PLAYWRIGHT_BROWSER_INSTALL === '1') {
  console.log('[playwright] browser install skipped by SKIP_PLAYWRIGHT_BROWSER_INSTALL=1');
  process.exit(0);
}

const executablePath = chromium.executablePath();

if (fs.existsSync(executablePath)) {
  console.log(`[playwright] chromium already installed at ${executablePath}`);
  process.exit(0);
}

console.log(`[playwright] chromium missing at ${executablePath}`);
console.log('[playwright] installing chromium browser binaries...');

const require = createRequire(import.meta.url);
const playwrightCli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
const result = spawnSync(process.execPath, [playwrightCli, 'install', 'chromium'], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[playwright] could not start the browser installer: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(executablePath)) {
  console.error(`[playwright] install completed but chromium executable is still missing at ${executablePath}`);
  process.exit(1);
}

console.log(`[playwright] chromium installed at ${executablePath}`);
