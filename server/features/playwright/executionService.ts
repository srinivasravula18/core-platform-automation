/**
 * Real Playwright execution.
 *
 * Takes generated Playwright scripts, writes them to an isolated temp project,
 * runs `npx playwright test` with the JSON reporter, and parses true pass/fail
 * results (plus per-test errors and failure screenshots/traces). This is what
 * turns "the AI wrote a script" into "the script actually ran and here's the
 * result".
 */

import path from 'path';
import fs from 'fs/promises';
import { MISSION_RUNNER_SOURCE } from '../agent/compiler/missionRunner.template';
import { spawn } from 'child_process';
import { transformSync } from 'esbuild';
import { CHROMIUM_LAUNCH_ARGS, chromiumExecutablePath } from '../../shared/browser';

export interface ScriptInput {
  filename?: string;
  title?: string;
  code: string;
}

export interface TestResult {
  title: string;
  file: string;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  durationMs: number;
  error?: string;
  /** Absolute path to the end-of-test screenshot (screenshot: 'on' or last per-step shot). */
  screenshotPath?: string;
  /** Absolute paths to ordered per-step screenshots the script attached via testInfo.attach('step-N', ...). */
  stepScreenshotPaths?: string[];
  /** Absolute path to the Playwright trace zip (trace: 'retain-on-failure') — present for failures. */
  tracePath?: string;
  /** Absolute path to the per-test console/pageerror log JSON (attached as 'console-log' by the evidence fixture). */
  consoleLogPath?: string;
  /** Absolute path to the per-test failed/erroring network log JSON (attached as 'network-log'). */
  networkLogPath?: string;
  /** Absolute path to the ordered MissionRunner step log JSON (merged 'step-log' attachments). */
  stepLogPath?: string;
}

export interface ExecutionResult {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  tests: TestResult[];
  runId: string;
  error?: string;
  stderrTail?: string;
  /** Filenames of scripts that could not be parsed/repaired and were skipped so the batch could run. */
  quarantined?: string[];
}

const RUN_ROOT = path.resolve(process.cwd(), '.testflow-pw');

function sanitizeFilename(name: string, index: number): string {
  let file = String(name || `test-${index + 1}`).trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  if (!file) file = `test-${index + 1}`;
  if (!/\.spec\.(ts|js)$/.test(file)) file = `${file.replace(/\.(ts|js)$/, '')}.spec.ts`;
  return file;
}

// Repair the most common LLM signature mistake: putting `testInfo` INSIDE the
// fixtures destructure — `async ({ page, testInfo }) => ...` — which Playwright
// rejects as an unknown fixture (the whole spec then collects 0 tests). The
// correct form is `async ({ page }, testInfo) => ...`. We rewrite it so the run
// is robust regardless of how the model formatted the signature.
export function sanitizeTestCode(code: string): string {
  if (!code) return code;
  const fixedSignature = code.replace(/async\s*\(\s*\{([^})]*)\}\s*\)\s*=>/g, (match, inner: string) => {
    if (!/\btestInfo\b/.test(inner)) return match;
    const fixtures = inner.split(',').map((s) => s.trim()).filter((s) => s && s !== 'testInfo');
    return `async ({ ${fixtures.join(', ')} }, testInfo) =>`;
  });
  return fixedSignature.replace(
    /^\s*await page\.(getByText|getByLabel|getByRole|getByPlaceholder)\((?!\/.*(?:loading|please wait|fetching|syncing|refreshing|processing|preparing)|["'`](?:loading|loading records|loading data|please wait|fetching|syncing|refreshing|processing|preparing)["'`])[\s\S]*?\.waitFor\(\{\s*state:\s*['"]hidden['"][^}]*\}\)\.catch\(\(\)\s*=>\s*\{\}\);\s*$/gmi,
    '',
  );
}

function autoScreenshotFixtureSource(shotsDir: string) {
  return `
async function tfaiAttachFinalScreenshot(page: any, testInfo: any) {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    await fs.mkdir(${JSON.stringify(shotsDir)}, { recursive: true });
    const safeTitle = String(testInfo.title || 'test').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'test';
    const file = path.join(${JSON.stringify(shotsDir)}, \`final-\${testInfo.workerIndex || 0}-\${Date.now()}-\${safeTitle}.png\`);
    await page.screenshot({ path: file, fullPage: true });
    await testInfo.attach('step-999', { path: file, contentType: 'image/png' });
  } catch {
    // Screenshot capture is evidence-only; never turn a passing test into a failure.
  }
}
`;
}

/**
 * Console/pageerror + failed-network evidence collectors, installed per test by an auto fixture.
 * Bounded (caps + text truncation) so a chatty page can never bloat the results. Exported for tests.
 */
export function evidenceCaptureFixtureSource() {
  return `
function tfaiEvidenceCollectors(page: any, context: any) {
  const consoleEntries: any[] = [];
  const networkEntries: any[] = [];
  const push = (arr: any[], cap: number, e: any) => { if (arr.length < cap) arr.push(e); };
  const onConsole = (m: any) => {
    const t = m && m.type ? m.type() : 'log';
    if (t !== 'error' && t !== 'warning') return; // signal only — info/debug noise stays out
    push(consoleEntries, 200, { at: Date.now(), type: t, text: String(m.text ? m.text() : m).slice(0, 500) });
  };
  const onPageError = (e: any) => push(consoleEntries, 200, { at: Date.now(), type: 'pageerror', text: String((e && e.message) || e).slice(0, 800) });
  const onRequestFailed = (r: any) => push(networkEntries, 150, {
    at: Date.now(), kind: 'requestfailed', method: r.method(), url: String(r.url()).slice(0, 300),
    failure: r.failure() ? String(r.failure().errorText).slice(0, 200) : null, resourceType: r.resourceType(),
  });
  const onResponse = (resp: any) => {
    const status = resp.status();
    if (status < 400) return; // only failures — success traffic is not evidence
    push(networkEntries, 150, {
      at: Date.now(), kind: 'response', method: resp.request().method(), url: String(resp.url()).slice(0, 300),
      status, resourceType: resp.request().resourceType(),
    });
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  context.on('requestfailed', onRequestFailed);
  context.on('response', onResponse);
  return () => {
    try { page.off('console', onConsole); page.off('pageerror', onPageError); } catch {}
    try { context.off('requestfailed', onRequestFailed); context.off('response', onResponse); } catch {}
    return { consoleEntries, networkEntries };
  };
}
async function tfaiAttachEvidence(testInfo: any, stop: any) {
  try {
    const { consoleEntries, networkEntries } = stop();
    await testInfo.attach('console-log', { body: Buffer.from(JSON.stringify(consoleEntries)), contentType: 'application/json' });
    await testInfo.attach('network-log', { body: Buffer.from(JSON.stringify(networkEntries)), contentType: 'application/json' });
  } catch {
    // Evidence capture is best-effort; never turn a passing test into a failure.
  }
}
`;
}

/** True if the TypeScript source parses cleanly (esbuild transpile = real parser, no type checks). */
function isParseable(code: string): boolean {
  try { transformSync(code, { loader: 'ts', sourcemap: false }); return true; }
  catch { return false; }
}

/**
 * Repair a truncated/unterminated generated test. The LLM most commonly drops the
 * trailing closers of the test(...) call (e.g. ends with `}` instead of `});`),
 * which makes the file un-collectable. We brute-force a small set of closing-token
 * suffixes and return the first that parses. Returns null if nothing makes it valid.
 */
export function repairTestCode(code: string): string | null {
  if (isParseable(code)) return code;
  const base = code.replace(/\s+$/, '');
  const candidates = new Set<string>();
  const toks = [')', '}', ';'];
  // Single/sequence suffixes (handles the common `}` -> `});` truncation).
  for (const a of toks) {
    candidates.add(base + a);
    for (const b of toks) {
      candidates.add(base + a + b);
      for (const c of toks) {
        candidates.add(base + a + b + c);
        for (const d of toks) candidates.add(base + a + b + c + d);
      }
    }
  }
  for (const cand of candidates) if (isParseable(cand)) return cand;
  return null;
}

/**
 * Parse the Playwright JSON-reporter output into TestResult[] and materialize evidence attachments
 * (step-N screenshots, console-log/network-log JSON, merged step-log) into files under runDir.
 * Exported as a pure(ish) function so the evidence pipeline is testable without launching browsers.
 */
export async function parsePlaywrightResults(
  json: any,
  opts: { runDir: string; screenshotMode: 'off' | 'only-on-failure' | 'on' },
): Promise<{ tests: TestResult[]; passed: number; failed: number; skipped: number; durationMs: number }> {
  const tests: TestResult[] = [];
  const rawStepAttsByTest: any[][] = [];
  const rawLogAttsByTest: { console: any | null; network: any | null; stepLogs: any[] }[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const walk = (suites: any[], parentFile = '') => {
    for (const s of suites || []) {
      const file = s.file || parentFile;
      for (const spec of s.specs || []) {
        for (const t of spec.tests || []) {
          const last = (t.results || [])[(t.results || []).length - 1] || {};
          const status = (last.status || (spec.ok ? 'passed' : 'failed')) as TestResult['status'];
          if (status === 'passed') passed++;
          else if (status === 'skipped') skipped++;
          else failed++;
          const errMsg = last.error?.message || (last.errors && last.errors[0]?.message) || '';
          const atts = (last.attachments || []) as any[];
          const rawStepAtts = opts.screenshotMode === 'only-on-failure' && status === 'passed'
            ? []
            : atts
              .filter((a) => /^step-\d+$/i.test(String(a?.name || '')) && (a?.path || a?.body))
              .sort((a, b) => (parseInt(String(a.name).replace(/\D/g, ''), 10) || 0) - (parseInt(String(b.name).replace(/\D/g, ''), 10) || 0));
          const shot = atts.find((a) => a?.name === 'screenshot' && a?.path);
          const trace = atts.find((a) => a?.name === 'trace' && a?.path);
          rawStepAttsByTest.push(rawStepAtts);
          rawLogAttsByTest.push({
            console: atts.find((a) => a?.name === 'console-log' && (a?.path || a?.body)) || null,
            network: atts.find((a) => a?.name === 'network-log' && (a?.path || a?.body)) || null,
            stepLogs: atts.filter((a) => a?.name === 'step-log' && (a?.path || a?.body)),
          });
          tests.push({
            title: spec.title || t.title || 'test',
            file,
            status,
            durationMs: last.duration || 0,
            screenshotPath: shot?.path,
            stepScreenshotPaths: [],
            tracePath: trace?.path,
            error: errMsg ? String(errMsg).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 600) : undefined,
          });
        }
      }
      if (s.suites) walk(s.suites, file);
    }
  };
  walk(json.suites || []);

  const attachmentBuffer = (a: any): Buffer | null => {
    if (!a?.body) return null;
    return Buffer.isBuffer(a.body) ? a.body : Buffer.from(String(a.body), 'base64');
  };

  // Materialize per-step screenshots: testInfo.attach('step-N', { body }) stores
  // the PNG inline as base64 (no path), so write each body to a file and expose
  // its path. Path-based attachments are used as-is.
  const stepsDir = path.join(opts.runDir, 'step-shots');
  const logsDir = path.join(opts.runDir, 'evidence-logs');
  await fs.mkdir(stepsDir, { recursive: true }).catch(() => undefined);
  await fs.mkdir(logsDir, { recursive: true }).catch(() => undefined);
  for (let ti = 0; ti < tests.length; ti += 1) {
    const raw = rawStepAttsByTest[ti] || [];
    const paths: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const a = raw[k];
      if (a.path) { paths.push(a.path); continue; }
      const buf = attachmentBuffer(a);
      if (buf) {
        const fp = path.join(stepsDir, `t${ti}-step-${k + 1}.png`);
        const ok = await fs.writeFile(fp, buf).then(() => true).catch(() => false);
        if (ok) paths.push(fp);
      }
    }
    tests[ti].stepScreenshotPaths = paths;
    if (!tests[ti].screenshotPath && paths.length) tests[ti].screenshotPath = paths[paths.length - 1];

    // Console/network logs: one JSON attachment each per test (evidence fixture output).
    const logs = rawLogAttsByTest[ti] || { console: null, network: null, stepLogs: [] };
    const writeLog = async (a: any, name: string): Promise<string | undefined> => {
      if (!a) return undefined;
      if (a.path) return a.path;
      const buf = attachmentBuffer(a);
      if (!buf) return undefined;
      const fp = path.join(logsDir, `t${ti}-${name}.json`);
      return fs.writeFile(fp, buf).then(() => fp).catch(() => undefined);
    };
    tests[ti].consoleLogPath = await writeLog(logs.console, 'console');
    tests[ti].networkLogPath = await writeLog(logs.network, 'network');

    // Step log: MissionRunner attaches one small JSON entry per act(); merge into an ordered array.
    if (logs.stepLogs.length) {
      const entries: any[] = [];
      for (const a of logs.stepLogs) {
        const buf = a.path ? await fs.readFile(a.path).catch(() => null) : attachmentBuffer(a);
        if (!buf) continue;
        try { entries.push(JSON.parse(buf.toString('utf8'))); } catch { /* skip unparseable */ }
      }
      if (entries.length) {
        const fp = path.join(logsDir, `t${ti}-steps.json`);
        const ok = await fs.writeFile(fp, JSON.stringify(entries, null, 2)).then(() => true).catch(() => false);
        if (ok) tests[ti].stepLogPath = fp;
      }
    }
  }

  return { tests, passed, failed, skipped, durationMs: json.stats?.duration || 0 };
}

// Track running Playwright child processes per run so a user "Stop" can SIGKILL the
// in-flight execution (the heaviest, killable part of a run) instead of waiting it out.
const runChildren = new Map<string, Set<import('child_process').ChildProcess>>();

/** Kill any in-flight Playwright process(es) for a run. Called when the user stops a run. */
export function killRunProcesses(runId: string): number {
  const set = runChildren.get(runId);
  if (!set) return 0;
  let killed = 0;
  for (const child of set) {
    try { child.kill('SIGKILL'); killed += 1; } catch { /* already gone */ }
  }
  runChildren.delete(runId);
  return killed;
}

export async function executePlaywrightScripts(opts: {
  scripts: ScriptInput[];
  baseUrl?: string;
  runId?: string;
  timeoutMs?: number;
  screenshotMode?: 'off' | 'only-on-failure' | 'on';
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
  expectTimeoutMs?: number;
  /** Path to a Playwright storageState JSON so every test starts authenticated. */
  storageStatePath?: string;
  /**
   * sessionStorage to replay before each page loads. storageState only persists cookies +
   * localStorage, so SPAs that keep their auth token in sessionStorage (e.g. Core Platform)
   * appear logged-OUT under storageState alone. Replaying it via addInitScript restores auth.
   */
  sessionStorageState?: { origin: string; items: Record<string, string> };
  /** Run specs one-by-one while reusing one browser context/page across all tests. */
  singleSession?: boolean;
  /**
   * Emit the MissionRunner helper (mission-runner.ts) into the tests dir. Set by the deterministic compiler
   * path so compiled specs can `import { MissionRunner } from './mission-runner'`. DARK by default (off) — the
   * legacy LLM-authored path never sets it, so behavior is unchanged until the compiler is enabled.
   */
  emitMissionRunner?: boolean;
}): Promise<ExecutionResult> {
  const scripts = (opts.scripts || []).filter((s) => s && typeof s.code === 'string' && s.code.trim());
  const runId = opts.runId || `run-${Date.now()}`;
  const base: Omit<ExecutionResult, 'ok'> = { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, tests: [], runId };

  if (!scripts.length) {
    return { ok: false, ...base, error: 'No scripts to run.' };
  }

  const runDir = path.join(RUN_ROOT, runId.replace(/[^a-zA-Z0-9._-]/g, '-'));
  const testsDir = path.join(runDir, 'tests');
  const resultsFile = path.join(runDir, 'results.json');
  const screenshotMode = opts.screenshotMode || 'only-on-failure';
  const stepShotsDir = path.join(runDir, 'step-shots');
  await fs.mkdir(testsDir, { recursive: true });

  if (opts.singleSession) {
    const contextOptions = `{
      ${opts.baseUrl ? `baseURL: ${JSON.stringify(opts.baseUrl)},` : ''}
      ${opts.storageStatePath ? `storageState: ${JSON.stringify(opts.storageStatePath)},` : ''}
    }`;
    // Replay sessionStorage (storageState can't): set the captured auth token before any page
    // script runs, on the matching origin, only when not already present (don't clobber live writes).
    const sessionInit = opts.sessionStorageState
      ? `
      await sharedContext.addInitScript((data) => {
        try {
          if (window.location.origin === data.origin) {
            for (const k of Object.keys(data.items)) {
              if (window.sessionStorage.getItem(k) === null) window.sessionStorage.setItem(k, data.items[k]);
            }
          }
        } catch (e) { /* ignore */ }
      }, ${JSON.stringify(opts.sessionStorageState)});`
      : '';
    const finalScreenshotFixture = screenshotMode === 'on' ? autoScreenshotFixtureSource(stepShotsDir) : '';
    const sharedFixture = `import { test as base, expect, request, type BrowserContext, type Page } from '@playwright/test';
${finalScreenshotFixture}
${evidenceCaptureFixtureSource()}

let sharedContext: BrowserContext | undefined;
let sharedPage: Page | undefined;

export const test = base.extend<{ context: BrowserContext; page: Page; tfaiFinalScreenshot: void; tfaiEvidence: void }>({
  context: async ({ browser }, use) => {
    if (!sharedContext) {
      sharedContext = await browser.newContext(${contextOptions});${sessionInit}
    }
    await use(sharedContext);
  },
  page: async ({ context }, use) => {
    if (!sharedPage || sharedPage.isClosed()) sharedPage = await context.newPage();
    await use(sharedPage);
  },
  tfaiEvidence: [async ({ context, page }, use, testInfo) => {
    const stop = tfaiEvidenceCollectors(page, context);
    await use();
    await tfaiAttachEvidence(testInfo, stop);
  }, { auto: true }],
  ${screenshotMode === 'on' ? `tfaiFinalScreenshot: [async ({ page }, use, testInfo) => {
    await use();
    await tfaiAttachFinalScreenshot(page, testInfo);
  }, { auto: true }],` : ''}
});

export { expect, request };
export type { BrowserContext, Page } from '@playwright/test';
`;
    await fs.writeFile(path.join(runDir, 'shared-session.ts'), sharedFixture, 'utf8');
  } else if (screenshotMode === 'on' || opts.sessionStorageState) {
    // Parallel path (default re-run) still needs to (a) replay sessionStorage — `use.storageState` in the
    // config only restores cookies + localStorage, so an SPA that keeps its auth token in sessionStorage
    // (e.g. Core Platform) renders LOGGED OUT and every selector times out on the login page; and/or
    // (b) attach the final screenshot. Both are done per-context so parallel workers stay independent.
    const needsShot = screenshotMode === 'on';
    const sessionCtx = opts.sessionStorageState
      ? `  context: async ({ context }, use) => {
    // storageState (config) already set cookies + localStorage; add sessionStorage on top before any page loads.
    await context.addInitScript((data) => {
      try {
        if (window.location.origin === data.origin) {
          for (const k of Object.keys(data.items)) {
            if (window.sessionStorage.getItem(k) === null) window.sessionStorage.setItem(k, data.items[k]);
          }
        }
      } catch (e) { /* ignore */ }
    }, ${JSON.stringify(opts.sessionStorageState)});
    await use(context);
  },`
      : '';
    const shotFixture = needsShot
      ? `  tfaiFinalScreenshot: [async ({ page }, use, testInfo) => {
    await use();
    await tfaiAttachFinalScreenshot(page, testInfo);
  }, { auto: true }],`
      : '';
    const fixture = `import { test as base, expect, request } from '@playwright/test';
${needsShot ? autoScreenshotFixtureSource(stepShotsDir) : ''}
${evidenceCaptureFixtureSource()}
export const test = base.extend<{ ${needsShot ? 'tfaiFinalScreenshot: void; ' : ''}tfaiEvidence: void }>({
${sessionCtx}
  tfaiEvidence: [async ({ context, page }, use, testInfo) => {
    const stop = tfaiEvidenceCollectors(page, context);
    await use();
    await tfaiAttachEvidence(testInfo, stop);
  }, { auto: true }],
${shotFixture}
});

export { expect, request };
`;
    await fs.writeFile(path.join(runDir, 'tfai-fixtures.ts'), fixture, 'utf8');
  }

  // Validate & repair EACH script before writing. Playwright collects every spec file
  // at startup, so a single un-parseable file aborts collection for the WHOLE batch
  // (0 tests run). We esbuild-parse each file; auto-repair truncated ones; and quarantine
  // any that still won't parse — so the good scripts always run instead of all falling
  // back to "not executed".
  // Compiler path: emit the MissionRunner helper the compiled specs import. Dark unless opted in.
  if (opts.emitMissionRunner) {
    await fs.writeFile(path.join(testsDir, 'mission-runner.ts'), MISSION_RUNNER_SOURCE, 'utf8');
  }

  const seen = new Set<string>();
  const quarantined: string[] = [];
  let written = 0;
  for (let i = 0; i < scripts.length; i++) {
    let fn = sanitizeFilename(scripts[i].filename || scripts[i].title || '', i);
    while (seen.has(fn)) fn = fn.replace(/\.spec\.ts$/, `-${i}.spec.ts`);
    seen.add(fn);
    let code = sanitizeTestCode(scripts[i].code);
    if (opts.singleSession) {
      code = code.replace(/from\s+['"]@playwright\/test['"]/g, "from '../shared-session'");
    } else if (screenshotMode === 'on' || opts.sessionStorageState) {
      code = code.replace(/from\s+['"]@playwright\/test['"]/g, "from '../tfai-fixtures'");
    }
    if (!isParseable(code)) {
      const repaired = repairTestCode(code);
      if (repaired) {
        code = repaired;
      } else {
        quarantined.push(fn);
        continue; // skip the broken file — do NOT let it break collection for the rest
      }
    }
    await fs.writeFile(path.join(testsDir, fn), code, 'utf8');
    written += 1;
  }

  if (!written) {
    return { ok: false, ...base, error: `All ${scripts.length} generated script(s) had unrecoverable syntax errors and could not be run.` };
  }

  // Server-safe Chromium launch (headless Ubuntu/containers need --no-sandbox etc.);
  // optionally pin a system Chromium via PLAYWRIGHT_CHROMIUM_PATH.
  const execPath = chromiumExecutablePath();
  const launchOptions = `{ args: ${JSON.stringify(CHROMIUM_LAUNCH_ARGS)}${execPath ? `, executablePath: ${JSON.stringify(execPath)}` : ''} }`;
  // Generous defaults matched to a real client-rendered SPA: a data grid can legitimately
  // take 6-10s to fetch + render its rows, so a 5s expect flake-failed valid tests. Auto-waiting
  // assertions cost nothing when the element is already there, so a roomy ceiling only helps.
  const actionTimeoutMs = opts.actionTimeoutMs ?? 10000;
  const navigationTimeoutMs = opts.navigationTimeoutMs ?? 20000;
  const expectTimeoutMs = opts.expectTimeoutMs ?? 15000;
  const config = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: ${opts.singleSession ? 'false' : 'true'},
  ${opts.singleSession ? 'workers: 1,' : ''}
  retries: 0,
  timeout: 90000,
  expect: { timeout: ${expectTimeoutMs} },
  reporter: [['json', { outputFile: 'results.json' }]],
  outputDir: './artifacts',
  use: {
    ${opts.baseUrl ? `baseURL: ${JSON.stringify(opts.baseUrl)},` : ''}
    ${opts.storageStatePath ? `storageState: ${JSON.stringify(opts.storageStatePath)},` : ''}
    headless: true,
    launchOptions: ${launchOptions},
    screenshot: ${JSON.stringify(screenshotMode)},
    trace: 'retain-on-failure',
    // Bound individual actions/navigations so a single missing element fails fast
    // (and a soft-asserted script can keep going) instead of consuming the whole test budget.
    actionTimeout: ${actionTimeoutMs},
    navigationTimeout: ${navigationTimeoutMs},
  },
});
`;
  await fs.writeFile(path.join(runDir, 'playwright.config.ts'), config, 'utf8');

  const timeoutMs = opts.timeoutMs || 180000;

  return new Promise<ExecutionResult>((resolve) => {
    // shell:true + string command runs cross-platform (npx / npx.cmd) and avoids
    // arg-quoting issues; the config filename has no spaces.
    const child = spawn('npx playwright test --config playwright.config.ts', {
      cwd: runDir,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });

    // Register so a user "Stop" (killRunProcesses) can terminate this in-flight run.
    if (!runChildren.has(runId)) runChildren.set(runId, new Set());
    runChildren.get(runId)!.add(child);
    const unregister = () => { runChildren.get(runId)?.delete(child); };

    let stderr = '';
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.stdout?.on('data', () => { /* JSON goes to results.json */ });

    child.on('error', (err) => {
      clearTimeout(killer);
      unregister();
      resolve({ ok: false, ...base, error: err.message, stderrTail: stderr.slice(-1500) || undefined });
    });

    child.on('close', async () => {
      clearTimeout(killer);
      unregister();
      try {
        const raw = await fs.readFile(resultsFile, 'utf8');
        const json = JSON.parse(raw);
        const parsed = await parsePlaywrightResults(json, { runDir, screenshotMode });
        resolve({
          ok: parsed.failed === 0 && parsed.tests.length > 0,
          total: parsed.tests.length,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          durationMs: parsed.durationMs,
          tests: parsed.tests,
          runId,
          stderrTail: parsed.failed > 0 || parsed.tests.length === 0 ? stderr.slice(-1500) || undefined : undefined,
          quarantined: quarantined.length ? quarantined : undefined,
        });
      } catch {
        resolve({
          ok: false,
          ...base,
          error: 'No results were produced. The scripts may have failed to compile, found no tests, or the browser is not installed (run: npx playwright install chromium).',
          stderrTail: stderr.slice(-1500) || undefined,
        });
      }
    });
  });
}
