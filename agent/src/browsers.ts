/**
 * Browser resolution for record & run.
 *
 * Preference order: Playwright's bundled Chromium when it's already installed (version-pinned,
 * reproducible) → the user's installed Google Chrome via channel 'chrome' (zero download — the
 * common case for a fresh end-user install) → otherwise auto-download Chromium in the background
 * at boot so start.bat alone yields a working agent.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import type { Logger } from 'pino';

const CHROME_CANDIDATES: string[] = process.platform === 'win32'
  ? [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];

export function systemChromePath(): string | null {
  for (const p of CHROME_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

export function bundledChromiumReady(): boolean {
  try {
    const p = chromium.executablePath();
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Channel for codegen/test: 'chrome' only when bundled Chromium is absent but system Chrome exists. */
export function chromiumChannel(): 'chrome' | undefined {
  return !bundledChromiumReady() && systemChromePath() ? 'chrome' : undefined;
}

function browsersRoot(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

/** Video capture needs Playwright's ffmpeg even when the browser itself is system Chrome. */
function ffmpegReady(): boolean {
  try { return fs.readdirSync(browsersRoot()).some((d) => d.startsWith('ffmpeg-')); } catch { return false; }
}

/** Boot check: install whatever is missing (browser and/or ffmpeg) in the background. */
export function ensureBrowsers(log: Logger, cwd: string): void {
  const chrome = systemChromePath();
  const needsBrowser = !bundledChromiumReady() && !chrome;
  const missing = [...(needsBrowser ? ['chromium'] : []), ...(ffmpegReady() ? [] : ['ffmpeg'])];
  if (!missing.length) {
    log.info(chrome && !bundledChromiumReady() ? { chrome } : {}, 'browser: ready (incl. ffmpeg for video)');
    return;
  }
  log.warn({ missing }, 'downloading missing Playwright components in the background (one time)');
  const child = spawn('npx', ['playwright', 'install', ...missing], {
    cwd,
    shell: process.platform === 'win32',
    env: { ...process.env }, // start.bat's PLAYWRIGHT_BROWSERS_PATH keeps the download inside the bundle
  });
  const onLine = (buf: Buffer) => String(buf).split('\n').filter((l) => l.trim()).forEach((l) => log.info({ line: l.trim() }, 'browser install'));
  child.stdout?.on('data', onLine);
  child.stderr?.on('data', onLine);
  child.once('close', (code) => {
    if (code === 0) log.info({ installed: missing }, 'browser components installed — record & run ready');
    else log.error({ code }, `install failed — run \`npx playwright install ${missing.join(' ')}\` in the agent folder`);
  });
  child.once('error', (err) => log.error({ err: err.message }, 'browser component install spawn failed'));
}
