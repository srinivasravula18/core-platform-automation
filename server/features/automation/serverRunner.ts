/**
 * Server-side headless execution.
 *
 * Scheduled runs execute HERE (on the backend), headless, rather than on the user's local agent — so
 * a schedule fires reliably even when the agent/laptop is offline. We materialize the recording's
 * script into a throwaway Playwright workspace, run it headless capturing video + step screenshots +
 * trace, stream logs to the Executions view, then persist every artifact against the job.
 *
 * (Recording still happens locally — codegen needs a headed browser. Only execution runs server-side.)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { AutomationJobs, AutomationExecutionBatches, Recordings } from '../../db/repository';
import { setJobStatus, syncLinkedRun } from './jobService';
import { saveArtifact } from './artifactService';
import { emitEvent } from './eventsService';
import type { ArtifactKind } from './types';
import { parseAtomicSteps, wrapRecordedScriptSteps } from './stepGrouping';
import { mergeExecutionProgress } from '../../../core/shared/automationProgress';
import { playwrightFailure } from '../../../agent/src/playwrightFailure';
import { startPauseControl, type PauseControl } from '../../../agent/src/pauseControl';
import { pausePreludeSource } from '../../../agent/src/preludeSource';
import { closeOpenPausesForJob, listJobPauses, recordPause, registerLocalPauseResolver } from './pauseService';
import { isPauseResumeEnabled } from './flag';
import { normalizeBrowserPermissionSettings, type BrowserPermissionSettings } from '../../../core/shared/browserPermissions';
import { MISSION_RUNNER_SOURCE } from '../agent/compiler/missionRunner.template';
import { resolveCredentials } from '../credentials/credentialsService';
import { createAuthStorageState } from '../evidence/evidenceService';

const RUN_ROOT = path.resolve(process.cwd(), '.testflow-pw', 'automation');
const running = new Map<string, ReturnType<typeof spawn>>();
const PROGRESS_PREFIX = '@@TESTFLOW_PROGRESS@@';

/** Resolve Playwright's CLI entry directly from node_modules (no require/import.meta — the prod build
 *  is an esbuild CJS bundle, see mcpClient.ts's resolveMcpCli for the same convention and why). Spawning
 *  this directly via process.execPath, instead of `npx` under a shell, means child.pid is the REAL
 *  Playwright process (not a cmd.exe/npx.cmd wrapper) — required for cancelServerJob's taskkill to
 *  actually reach it and its browser children instead of only killing the wrapper. */
function resolvePlaywrightCli(): string {
  const candidate = path.join(process.cwd(), 'node_modules', 'playwright', 'cli.js');
  if (fs.existsSync(candidate)) return candidate;
  throw new Error('playwright CLI not found — run npm install. Looked in: ' + candidate);
}

const progressReporterSource = `
class TestFlowProgressReporter {
  constructor() { this.completed = 0; this.total = 0; this.stepCompleted = 0; this.stepTotal = Number(process.env.TESTFLOW_STEP_TOTAL) || 0; this.stepStarted = 0; this.stepIndexes = new Map(); }
  emit(event, test, status) { console.log('${PROGRESS_PREFIX}' + JSON.stringify({ event, completed: this.completed, total: this.total, currentTest: test ? test.title : '', testStatus: status || '', stepCompleted: this.stepCompleted, stepTotal: this.stepTotal })); }
  tracked(step) { return step.category === 'pw:api' || step.category === 'expect'; }
  title(step) { const title = String(step.title || ''); return title.includes('.fill(') || title.includes('.type(') ? title.slice(0, title.lastIndexOf('(') + 1) + '"***")' : title; }
  onBegin(_config, suite) { this.total = suite.allTests().length; this.emit('started'); }
  onTestBegin(test) { this.emit('test_started', test); }
  onTestEnd(test, result) { this.completed += 1; this.emit('test_finished', test, result.status); }
  onStepBegin(_test, _result, step) { if (!this.tracked(step)) return; const index = ++this.stepStarted; this.stepIndexes.set(step.id, index); this.stepTotal = Math.max(this.stepTotal, index); console.log('${PROGRESS_PREFIX}' + JSON.stringify({ event: 'step_started', stepId: step.id, stepIndex: index, stepCompleted: this.stepCompleted, stepTotal: this.stepTotal, stepTitle: this.title(step), stepStartedAt: Date.now() })); }
  onStepEnd(_test, _result, step) { if (!this.tracked(step)) return; this.stepCompleted += 1; console.log('${PROGRESS_PREFIX}' + JSON.stringify({ event: 'step_finished', stepId: step.id, stepIndex: this.stepIndexes.get(step.id) || this.stepCompleted, stepCompleted: this.stepCompleted, stepTotal: Math.max(this.stepTotal, this.stepCompleted), stepTitle: this.title(step), stepStartedAt: Date.now() - Number(step.duration || 0), stepDurationMs: Number(step.duration || 0), stepError: step.error ? String(step.error.message || step.error).slice(0, 1000) : '' })); }
}
module.exports = TestFlowProgressReporter;
`;

function progressFromLine(line: string): any | null {
  const at = line.indexOf(PROGRESS_PREFIX);
  if (at < 0) return null;
  try { return JSON.parse(line.slice(at + PROGRESS_PREFIX.length)); } catch { return null; }
}

export function browserPermissionPrelude(settings: BrowserPermissionSettings, appUrl: string): string {
  if (!settings.permissions.length && !settings.acceptDialogs) return '';
  let origin = '';
  try { origin = new URL(appUrl).origin; } catch { /* grant for the isolated context below */ }
  const grant = settings.permissions.length
    ? `await context.grantPermissions(${JSON.stringify(settings.permissions)}${origin ? `, { origin: ${JSON.stringify(origin)} }` : ''});`
    : '';
  const dialogs = settings.acceptDialogs ? `page.on('dialog', (dialog) => { void dialog.accept().catch(() => {}); });` : '';
  return `import { test as __testflowBrowserSetup } from '@playwright/test';\n__testflowBrowserSetup.beforeEach(async ({ context, page }) => { ${grant} ${dialogs} });\n`;
}

export function configTemplate(engine: string, hasPauses = false, settings: BrowserPermissionSettings = { permissions: [] }, storageStatePath = ''): string {
  const browserName = ['chromium', 'firefox', 'webkit'].includes(engine) ? engine : 'chromium';
  const fakeMediaArgs = browserName === 'chromium' && settings.fakeMedia
    ? `, launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }`
    : '';
  const geolocation = settings.geolocation ? `, geolocation: ${JSON.stringify(settings.geolocation)}` : '';
  return `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: ${hasPauses ? 0 : 60000},
  reporter: [['./progress-reporter.cjs'], ['list'], ['json', { outputFile: 'results.json' }], ['junit', { outputFile: 'results.xml' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: { browserName: '${browserName}', headless: true, trace: 'on', video: 'on', screenshot: 'on'${storageStatePath ? `, storageState: ${JSON.stringify(storageStatePath)}` : ''}${geolocation}${fakeMediaArgs} },
});
`;
}

export function authSessionPrelude(sessionStorage?: { origin: string; items: Record<string, string> }): string {
  if (!sessionStorage || !Object.keys(sessionStorage.items || {}).length) return '';
  return `import { test as __testflowAuthSetup } from '@playwright/test';\n__testflowAuthSetup.beforeEach(async ({ context }) => { await context.addInitScript((data) => { if (window.location.origin === data.origin) for (const key of Object.keys(data.items)) if (window.sessionStorage.getItem(key) === null) window.sessionStorage.setItem(key, data.items[key]); }, ${JSON.stringify(sessionStorage)}); });\n`;
}

export function needsManagedAuth(recording: any): boolean {
  // Record & Play scripts include the user's recorded login actions/values. Repository scripts
  // (including Agent Console scripts) instead rely on a fresh authenticated session.
  return recording?.metadata?.source !== 'recordplay' && !Object.hasOwn(recording?.metadata || {}, 'browserPermissions');
}

function classify(file: string): ArtifactKind {
  const l = file.toLowerCase();
  if (l.endsWith('.zip')) return 'trace';
  if (l.endsWith('.webm') || l.endsWith('.mp4')) return 'video';
  if (l.endsWith('.png') || l.endsWith('.jpg') || l.endsWith('.jpeg')) return 'screenshot';
  if (l.endsWith('.xml')) return 'junit';
  if (l.endsWith('.html')) return 'html';
  return 'log';
}

function walk(dir: string, acc: string[]): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
}

function collectArtifacts(runDir: string): Array<{ kind: ArtifactKind; path: string; filename: string }> {
  const files: string[] = [];
  walk(path.join(runDir, 'test-results'), files);
  for (const f of ['results.json', 'results.xml']) { const p = path.join(runDir, f); if (fs.existsSync(p)) files.push(p); }
  const html = path.join(runDir, 'playwright-report', 'index.html');
  if (fs.existsSync(html)) files.push(html);
  return files.map((p) => ({ kind: classify(p), path: p, filename: path.basename(p) }));
}

function parseSummary(runDir: string): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8'));
    const s = raw.stats || {};
    const tests: any[] = [];
    const visit = (suite: any) => {
      for (const spec of suite?.specs || []) for (const test of spec.tests || []) {
        const result = test.results?.[test.results.length - 1] || {};
        tests.push({ title: spec.title || test.title || 'Playwright test', status: result.status || 'skipped', error: result.error?.message || result.error || '', durationMs: Number(result.duration) || 0 });
      }
      for (const child of suite?.suites || []) visit(child);
    };
    visit(raw);
    return { passed: s.expected || 0, failed: s.unexpected || 0, flaky: s.flaky || 0, skipped: s.skipped || 0, durationMs: Math.round(s.duration || 0), tests } as any;
  } catch { return {}; }
}

function parseFailure(runDir: string, script: string): string {
  try { return playwrightFailure(JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8')), script); }
  catch { return ''; }
}

/** Execute a queued job's recording headless on the server. Resolves when the run + upload finish. */
export async function runJobOnServer(jobId: string): Promise<void> {
  const job = await AutomationJobs.get(jobId);
  if (!job) return;
  const rec = job.recordingId ? await Recordings.get(job.recordingId) : null;
  // A data-driven batch job carries its own per-row MATERIALIZED script (row values already resolved
  // + fresh unique tokens baked in); scheduled/plain runs carry none, so fall back to the recording.
  const scriptSource = String((job as any).script || '').trim() || String(rec?.script || '');
  if (!scriptSource) {
    await setJobStatus(jobId, 'failed', { error: 'No script to run.', finishedAt: new Date().toISOString() });
    return;
  }
  const hasPauses = isPauseResumeEnabled() && /\btf\.pause\s*\(/.test(scriptSource);
  const browserPermissions = normalizeBrowserPermissionSettings(rec?.metadata?.browserPermissions);
  if (hasPauses && /\btf\.pause\s*\(\s*\{[\s\S]*?kind\s*:\s*['"]manual_action['"]/.test(scriptSource)) {
    await setJobStatus(jobId, 'failed', { error: 'This script requires a headed run for a manual browser action.', finishedAt: new Date().toISOString() });
    return;
  }

  let control: PauseControl | undefined;
  let unregisterResolver = () => {};
  if (hasPauses) {
    control = await startPauseControl(jobId, (pause) => {
      void recordPause('', pause).then(async (saved) => {
        if (!saved) return;
        const current = await AutomationJobs.get(jobId);
        const prior = current?.summary || {};
        await setJobStatus(jobId, 'awaiting_user', { summary: { ...prior, pauseCount: (await listJobPauses(jobId)).length, assisted: true } });
      });
    });
    unregisterResolver = registerLocalPauseResolver(jobId, (answer) => control!.resolve(answer.pauseId, answer));
  }

  const runDir = path.join(RUN_ROOT, jobId.replace(/[^a-zA-Z0-9._-]/g, '_'));
  fs.mkdirSync(path.join(runDir, 'tests'), { recursive: true });
  const credentials = needsManagedAuth(rec)
    ? resolveCredentials({ targetUrl: rec?.appUrl || '', ownerId: job.ownerId || undefined })
    : null;
  let storageStatePath = '';
  let sessionStorageState: { origin: string; items: Record<string, string> } | undefined;
  if (credentials?.username && credentials.password) {
    const auth = await createAuthStorageState(rec?.appUrl || '', credentials, path.join(runDir, 'auth.json'));
    if (!auth.ok && !auth.sessionStorage) {
      await setJobStatus(jobId, 'failed', { error: `Authentication setup failed before script execution${auth.reason ? `: ${auth.reason}` : '.'}`, finishedAt: new Date().toISOString() });
      return;
    }
    storageStatePath = path.join(runDir, 'auth.json');
    sessionStorageState = auth.sessionStorage;
  }
  fs.writeFileSync(path.join(runDir, 'playwright.config.ts'), configTemplate(rec?.browser || 'chromium', hasPauses, browserPermissions, storageStatePath));
  fs.writeFileSync(path.join(runDir, 'progress-reporter.cjs'), progressReporterSource);
  if (/from\s+['"]\.\/mission-runner['"]/.test(scriptSource)) fs.writeFileSync(path.join(runDir, 'tests', 'mission-runner.ts'), MISSION_RUNNER_SOURCE);
  fs.writeFileSync(path.join(runDir, 'tests', 'recording.spec.ts'), `${browserPermissionPrelude(browserPermissions, rec?.appUrl || '')}${authSessionPrelude(sessionStorageState)}${hasPauses ? pausePreludeSource : ''}${wrapRecordedScriptSteps(scriptSource)}`);

  await setJobStatus(jobId, 'running', { startedAt: new Date().toISOString() });
  const log = (line: string) => emitEvent({ scopeType: 'job', scopeId: jobId, type: 'job.log', ownerId: job.ownerId, data: { line } });
  const output: string[] = [];

  let progressWrites = Promise.resolve();
  let exitCode: number;
  try {
    exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [resolvePlaywrightCli(), 'test', '--config', 'playwright.config.ts'], {
        cwd: runDir,
        env: {
          ...process.env,
          PLAYWRIGHT_HTML_OPEN: 'never',
          TESTFLOW_STEP_TOTAL: String(parseAtomicSteps(scriptSource).length),
          ...(control ? { TESTFLOW_CONTROL_URL: control.url, TESTFLOW_CONTROL_KEY: control.key, TESTFLOW_JOB_ID: jobId } : {}),
        },
      });
      running.set(jobId, child);
      const onLine = (line: string) => {
        const progress = progressFromLine(line);
        if (!progress) { output.push(line); if (output.length > 30) output.shift(); void log(line); return; }
        progressWrites = progressWrites.then(async () => {
          const current = await AutomationJobs.get(jobId);
          if (!current || current.status === 'cancelled') return;
          await setJobStatus(jobId, 'running', { summary: mergeExecutionProgress(current.summary || {}, progress) });
        });
      };
      if (child.stdout) createInterface({ input: child.stdout }).on('line', onLine);
      if (child.stderr) createInterface({ input: child.stderr }).on('line', onLine);
      child.once('close', (code) => { running.delete(jobId); resolve(code ?? 1); });
      child.once('error', (err) => { output.push(`Runner error: ${err.message}`); void log(output.at(-1)!); running.delete(jobId); resolve(1); });
    });
  } finally {
    unregisterResolver();
    await control?.close();
  }
  await progressWrites;

  if ((await AutomationJobs.get(jobId))?.status === 'cancelled') return;

  await setJobStatus(jobId, 'uploading');
  for (const a of collectArtifacts(runDir)) {
    try { await saveArtifact({ jobId, kind: a.kind, filename: a.filename, buffer: fs.readFileSync(a.path), ownerId: job.ownerId }); }
    catch (err: any) { void log(`artifact save failed (${a.filename}): ${err?.message}`); }
  }

  if ((await AutomationJobs.get(jobId))?.status === 'cancelled') return;

  const summary = parseSummary(runDir);
  const status = exitCode === 0 ? 'done' : 'failed';
  const current = await AutomationJobs.get(jobId);
  const outputFailure = output.join('\n').slice(-4000);
  const failure = exitCode === 0 ? '' : parseFailure(runDir, scriptSource) || (outputFailure ? `Execution failed.\nRunner output:\n${outputFailure}` : 'Test run reported failures.');
  // setJobStatus finalizes and persists the real merged summary — use ITS return value, not the raw
  // per-process `summary`, which never carries the accumulated executionSteps/caseSteps (same fix as
  // the agent-dispatched job.done path in jobService.ts).
  const saved = await setJobStatus(jobId, status, { exitCode, summary: { ...(current?.summary || {}), ...summary }, error: failure, finishedAt: new Date().toISOString() });
  await closeOpenPausesForJob(jobId);
  // Keep server-scheduled execution in parity with agent execution: the linked Test Run is what
  // powers durable dashboard/test-management outcome views.
  await syncLinkedRun(jobId, status, saved?.summary || summary);
}

/**
 * Execute a whole data-driven BATCH headless on the server (no desktop agent). Rows run SEQUENTIALLY
 * so stop-on-failure stays meaningful and the host never spawns N headless browsers at once. Each
 * row's job already holds its materialized per-row script, so no agent is needed to run it.
 */
export async function runBatchOnServer(batchId: string): Promise<void> {
  const batch = await AutomationExecutionBatches.get(batchId);
  if (!batch) return;
  const queued = (await AutomationJobs.list())
    .filter((j: any) => j.batchId === batchId && j.status === 'queued')
    .sort((a: any, b: any) => new Date(a.queuedAt || 0).getTime() - new Date(b.queuedAt || 0).getTime());
  for (const job of queued) {
    const cur = await AutomationJobs.get(job.id);
    if (!cur || cur.status !== 'queued') continue; // already cancelled (e.g. by stop-on-failure) — skip
    await runJobOnServer(job.id);
    if (batch.stopOnFailure) {
      const finished = await AutomationJobs.get(job.id);
      if (finished?.status === 'failed') break; // the job.done handler cancels the remaining rows
    }
  }
}

/** Cancel a server-side run in flight. */
export function cancelServerJob(jobId: string): void {
  const child = running.get(jobId);
  if (child?.pid) {
    if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
}
