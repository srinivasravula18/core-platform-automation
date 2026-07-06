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

/* Launch gate: Chromium's INIT phase is the fragile window — several processes initializing at
 * once on a pressured host (agent inspection + evidence scripts + tool-loop sessions in parallel)
 * is what turns into "Target page, context or browser has been closed". Serialize the launches
 * (not the browsing) through a small semaphore so inits never stampede; running browsers are
 * unaffected. Cap is configurable for beefier hosts. */
const MAX_CONCURRENT_LAUNCHES = Math.max(1, Number(process.env.CHROMIUM_MAX_CONCURRENT_LAUNCHES) || 2);
let activeLaunches = 0;
const launchWaiters: Array<() => void> = [];

async function acquireLaunchSlot(): Promise<void> {
  if (activeLaunches < MAX_CONCURRENT_LAUNCHES) {
    activeLaunches += 1;
    return;
  }
  await new Promise<void>((resolve) => launchWaiters.push(resolve));
  activeLaunches += 1;
}

function releaseLaunchSlot(): void {
  activeLaunches -= 1;
  const next = launchWaiters.shift();
  if (next) next();
}

/**
 * Launch Chromium with a launch gate + retry. On a resource-pressured host (many browser/node
 * processes, low desktop-heap/memory — common on Windows after long sessions) a launch can fail
 * transiently: Chromium starts then dies during init, surfacing as Windows exit code 0xC0000142 or
 * Playwright's "browserType.launch: Target page, context or browser has been closed". Launches are
 * serialized through a small semaphore and retried with backoff, so a run is not lost to a
 * momentary system hiccup. Prefer this over chromium.launch().
 */
export async function launchChromiumWithRetry(overrides: LaunchOptions = {}, attempts = 4): Promise<Browser> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await acquireLaunchSlot();
    try {
      return await chromium.launch(chromiumLaunchOptions(overrides));
    } catch (err) {
      lastErr = err;
    } finally {
      releaseLaunchSlot();
    }
    if (attempt < attempts - 1) await sleep(1000 * (attempt + 1));
  }
  // All attempts failed — tell the operator what actually fixes this, per environment.
  const base = String((lastErr as any)?.message || lastErr || 'unknown launch failure').split('\n')[0];
  throw new Error(
    `Chromium failed to launch after ${attempts} attempts: ${base}. ` +
    'Likely causes: (1) host memory pressure — close other browsers/apps or wait for running agent tasks and retry; ' +
    '(2) on a deployed Linux server, missing/mismatched Playwright browsers — run "npm run playwright:install" ' +
    '(and "npx playwright install-deps" for system libraries).',
  );
}
