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
import { spawn } from 'child_process';

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
  if (!code || !/testInfo/.test(code)) return code;
  return code.replace(/async\s*\(\s*\{([^})]*)\}\s*\)\s*=>/g, (match, inner: string) => {
    if (!/\btestInfo\b/.test(inner)) return match;
    const fixtures = inner.split(',').map((s) => s.trim()).filter((s) => s && s !== 'testInfo');
    return `async ({ ${fixtures.join(', ')} }, testInfo) =>`;
  });
}

export async function executePlaywrightScripts(opts: {
  scripts: ScriptInput[];
  baseUrl?: string;
  runId?: string;
  timeoutMs?: number;
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
  await fs.mkdir(testsDir, { recursive: true });

  const seen = new Set<string>();
  for (let i = 0; i < scripts.length; i++) {
    let fn = sanitizeFilename(scripts[i].filename || scripts[i].title || '', i);
    while (seen.has(fn)) fn = fn.replace(/\.spec\.ts$/, `-${i}.spec.ts`);
    seen.add(fn);
    await fs.writeFile(path.join(testsDir, fn), sanitizeTestCode(scripts[i].code), 'utf8');
  }

  const config = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  timeout: 120000,
  reporter: [['json', { outputFile: 'results.json' }]],
  outputDir: './artifacts',
  use: {
    ${opts.baseUrl ? `baseURL: ${JSON.stringify(opts.baseUrl)},` : ''}
    headless: true,
    screenshot: 'on',
    trace: 'retain-on-failure',
    // Bound individual actions/navigations so a single missing element fails fast
    // (and a soft-asserted script can keep going) instead of consuming the whole test budget.
    actionTimeout: 15000,
    navigationTimeout: 30000,
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
      resolve({ ok: false, ...base, error: err.message, stderrTail: stderr.slice(-1500) || undefined });
    });

    child.on('close', async () => {
      clearTimeout(killer);
      try {
        const raw = await fs.readFile(resultsFile, 'utf8');
        const json = JSON.parse(raw);
        const tests: TestResult[] = [];
        const rawStepAttsByTest: any[][] = [];
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
                const rawStepAtts = atts
                  .filter((a) => /^step-\d+$/i.test(String(a?.name || '')) && (a?.path || a?.body))
                  .sort((a, b) => (parseInt(String(a.name).replace(/\D/g, ''), 10) || 0) - (parseInt(String(b.name).replace(/\D/g, ''), 10) || 0));
                const shot = atts.find((a) => a?.name === 'screenshot' && a?.path);
                rawStepAttsByTest.push(rawStepAtts);
                tests.push({
                  title: spec.title || t.title || 'test',
                  file,
                  status,
                  durationMs: last.duration || 0,
                  screenshotPath: shot?.path,
                  stepScreenshotPaths: [],
                  error: errMsg ? String(errMsg).replace(/\[[0-9;]*m/g, '').slice(0, 600) : undefined,
                });
              }
            }
            if (s.suites) walk(s.suites, file);
          }
        };
        walk(json.suites || []);

        // Materialize per-step screenshots: testInfo.attach('step-N', { body }) stores
        // the PNG inline as base64 (no path), so write each body to a file and expose
        // its path. Path-based attachments are used as-is.
        const stepsDir = path.join(runDir, 'step-shots');
        await fs.mkdir(stepsDir, { recursive: true }).catch(() => undefined);
        for (let ti = 0; ti < tests.length; ti += 1) {
          const raw = rawStepAttsByTest[ti] || [];
          const paths: string[] = [];
          for (let k = 0; k < raw.length; k += 1) {
            const a = raw[k];
            if (a.path) { paths.push(a.path); continue; }
            if (a.body) {
              const fp = path.join(stepsDir, `t${ti}-step-${k + 1}.png`);
              const buf = Buffer.isBuffer(a.body) ? a.body : Buffer.from(String(a.body), 'base64');
              const ok = await fs.writeFile(fp, buf).then(() => true).catch(() => false);
              if (ok) paths.push(fp);
            }
          }
          tests[ti].stepScreenshotPaths = paths;
          if (!tests[ti].screenshotPath && paths.length) tests[ti].screenshotPath = paths[paths.length - 1];
        }

        resolve({
          ok: failed === 0 && tests.length > 0,
          total: tests.length,
          passed,
          failed,
          skipped,
          durationMs: json.stats?.duration || 0,
          tests,
          runId,
          stderrTail: failed > 0 || tests.length === 0 ? stderr.slice(-1500) || undefined : undefined,
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
