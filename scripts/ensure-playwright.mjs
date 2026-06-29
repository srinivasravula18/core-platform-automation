import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
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

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npxCommand, ['playwright', 'install', 'chromium'], {
  stdio: 'inherit',
  shell: false,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(executablePath)) {
  console.error(`[playwright] install completed but chromium executable is still missing at ${executablePath}`);
  process.exit(1);
}

console.log(`[playwright] chromium installed at ${executablePath}`);
