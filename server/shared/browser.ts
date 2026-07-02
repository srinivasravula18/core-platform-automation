/**
 * Chromium launch configuration for running on a remote/headless server (e.g. Ubuntu).
 *
 * On a typical Linux server — especially as root or inside a container — Chromium
 * fails to start without disabling the sandbox, and crashes under load because the
 * default /dev/shm is tiny. These flags make Playwright's Chromium run reliably there
 * and are harmless on a developer's local machine, so we apply them everywhere.
 *
 * To use a SYSTEM-installed Chromium instead of Playwright's bundled build (e.g.
 * Ubuntu's `chromium` / `chromium-browser`), set PLAYWRIGHT_CHROMIUM_PATH (or
 * CHROMIUM_EXECUTABLE_PATH) to its absolute path, e.g. /usr/bin/chromium.
 */
import { chromium, type Browser, type LaunchOptions } from 'playwright';

export const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

/** Absolute path to a system Chromium, if the operator configured one. */
export function chromiumExecutablePath(): string | undefined {
  return process.env.PLAYWRIGHT_CHROMIUM_PATH || process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
}

/** Launch options for `chromium.launch(...)` — headless + server-safe flags. */
export function chromiumLaunchOptions(overrides: LaunchOptions = {}): LaunchOptions {
  const executablePath = chromiumExecutablePath();
  return {
    headless: true,
    args: CHROMIUM_LAUNCH_ARGS,
    ...(executablePath ? { executablePath } : {}),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Launch Chromium with a small retry. On a resource-pressured host (many browser/node processes,
 * low desktop-heap/memory — common on Windows after long sessions) a launch can fail transiently:
 * Chromium starts then dies during init, surfacing as Windows exit code 0xC0000142 or Playwright's
 * "browserType.launch: Target page, context or browser has been closed". A short backoff usually
 * clears it, so a run is not lost to a momentary system hiccup. Prefer this over chromium.launch().
 */
export async function launchChromiumWithRetry(overrides: LaunchOptions = {}, attempts = 3): Promise<Browser> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chromium.launch(chromiumLaunchOptions(overrides));
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}
