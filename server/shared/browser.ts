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
import type { LaunchOptions } from 'playwright';

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
