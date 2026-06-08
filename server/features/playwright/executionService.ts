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
    await fs.writeFile(path.join(testsDir, fn), scripts[i].code, 'utf8');
  }

  const config = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  timeout: 60000,
  reporter: [['json', { outputFile: 'results.json' }]],
  outputDir: './artifacts',
  use: {
    ${opts.baseUrl ? `baseURL: ${JSON.stringify(opts.baseUrl)},` : ''}
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
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
                tests.push({
                  title: spec.title || t.title || 'test',
                  file,
                  status,
                  durationMs: last.duration || 0,
                  error: errMsg ? String(errMsg).replace(/\[[0-9;]*m/g, '').slice(0, 600) : undefined,
                });
              }
            }
            if (s.suites) walk(s.suites, file);
          }
        };
        walk(json.suites || []);

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
