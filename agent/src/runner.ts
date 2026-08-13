/**
 * Local test execution.
 *
 * On job.dispatch the agent materializes a throwaway workspace (config + spec), runs
 * `npx playwright test`, streams log lines to the cloud, parses the JSON/JUnit reporters for a
 * pass/fail summary, then uploads artifacts (trace.zip, video, screenshots, reports). Everything runs
 * on the user's machine; only results + artifacts go back up.
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import type { Logger } from 'pino';
import type { AgentConfig } from './config.js';
import { uploadArtifact } from './cloud.js';
import type { ArtifactKind } from './artifacts.js';
import { collectArtifacts } from './artifacts.js';
import { chromiumChannel } from './browsers.js';
import { playwrightFailure } from './playwrightFailure.js';
import { startPauseControl, type OpenPause, type PauseControl, type PauseControlAnswer } from './pauseControl.js';
import { pausePreludeSource, videoTailPreludeSource } from './preludeSource.js';
import { browserPermissionPrelude, normalizeBrowserPermissionSettings, type BrowserPermissionSettings } from './browserPermissions.js';

export interface Job {
  jobId: string;
  recordingId: string;
  script: string;
  browser: string;
  environment: string;
  appUrl: string;
  headed?: boolean;
  stepTotal?: number;
  pauseResume?: boolean;
  browserPermissions?: BrowserPermissionSettings;
}

export type SendFrame = (type: string, payload: Record<string, unknown>) => void;
const PROGRESS_PREFIX = '@@TESTFLOW_PROGRESS@@';
const require = createRequire(import.meta.url);
const playwrightCli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');

export function bundledTestRuntime(source: string): string {
  return source.replace(/(['"])@playwright\/test\1/g, '$1playwright/test$1');
}

const progressReporterSource = `
class TestFlowProgressReporter {
  constructor() { this.completed = 0; this.total = 0; this.stepCompleted = 0; this.stepTotal = Number(process.env.TESTFLOW_STEP_TOTAL) || 0; this.stepStarted = 0; this.stepIndexes = new Map(); this.erroredStepIds = []; this.erroredCaseStepIds = []; }
  emit(event, test, status) { console.log('${PROGRESS_PREFIX}' + JSON.stringify({ event, completed: this.completed, total: this.total, currentTest: test ? test.title : '', testStatus: status || '', stepCompleted: this.stepCompleted, stepTotal: this.stepTotal })); }
  tracked(step) { return step.category === 'pw:api' || step.category === 'expect'; }
  title(step) { const title = String(step.title || ''); return title.includes('.fill(') || title.includes('.type(') ? title.slice(0, title.lastIndexOf('(') + 1) + '"***")' : title; }
  // Compiler-emitted steps are wrapped in test.step('[id] label', ...) so the id round-trips through
  // Playwright's step title (its reporter API has no field for arbitrary step metadata) — parsed back
  // out here and reported on its own event stream, separate from the raw per-action one above, so it
  // can correlate to the authored case step without touching the already-working raw step display.
  caseStep(step) {
    if (step.category !== 'test.step') return null;
    const m = /^\\[([^\\]]+)\\]\\s*(.*)$/.exec(String(step.title || ''));
    return m ? { id: m[1], label: m[2] } : null;
  }
  onBegin(_config, suite) { this.total = suite.allTests().length; this.emit('started'); }
  onTestBegin(test) { this.emit('test_started', test); }
  // A step whose error the script caught (the generated login guards use .catch(() => {})) still carries
  // step.error, which showed passing steps as Failed while the case step and the test itself passed.
  // The verdict is only knowable at test end: if the test passed, those errors were recovered.
  onTestEnd(test, result) {
    this.completed += 1;
    if (result.status === 'passed' && (this.erroredStepIds.length || this.erroredCaseStepIds.length)) {
      console.log('${PROGRESS_PREFIX}' + JSON.stringify({ event: 'steps_recovered', stepIds: this.erroredStepIds, caseStepIds: this.erroredCaseStepIds }));
    }
    this.erroredStepIds = []; this.erroredCaseStepIds = [];
    this.emit('test_finished', test, result.status);
  }
  onStepBegin(_test, _result, step) {
    const cs = this.caseStep(step);
    if (cs) { console.log('${PROGRESS_PREFIX}' + JSON.stringify({ event: 'case_step_started', caseStepId: cs.id, caseStepTitle: cs.label, caseStepStartedAt: Date.now() })); return; }
    if (!this.tracked(step)) return;
    const index = ++this.stepStarted; this.stepIndexes.set(step.id, index); this.stepTotal = Math.max(this.stepTotal, index);
    console.log('${PROGRESS_PREFIX}' + JSON.stringify({ event: 'step_started', stepId: step.id, stepIndex: index, stepCompleted: this.stepCompleted, stepTotal: this.stepTotal, stepTitle: this.title(step), stepStartedAt: Date.now() }));
  }
  onStepEnd(_test, _result, step) {
    const cs = this.caseStep(step);
    if (cs) { if (step.error) this.erroredCaseStepIds.push(cs.id); console.log('${PROGRESS_PREFIX}' + JSON.stringify({ event: 'case_step_finished', caseStepId: cs.id, caseStepTitle: cs.label, caseStepStartedAt: Date.now() - Number(step.duration || 0), caseStepDurationMs: Number(step.duration || 0), caseStepError: step.error ? String(step.error.message || step.error).slice(0, 1000) : '' })); return; }
    if (!this.tracked(step)) return;
    this.stepCompleted += 1;
    if (step.error) this.erroredStepIds.push(step.id);
    console.log('${PROGRESS_PREFIX}' + JSON.stringify({ event: 'step_finished', stepId: step.id, stepIndex: this.stepIndexes.get(step.id) || this.stepCompleted, stepCompleted: this.stepCompleted, stepTotal: Math.max(this.stepTotal, this.stepCompleted), stepTitle: this.title(step), stepStartedAt: Date.now() - Number(step.duration || 0), stepDurationMs: Number(step.duration || 0), stepError: step.error ? String(step.error.message || step.error).slice(0, 1000) : '' }));
  }
}
module.exports = TestFlowProgressReporter;
`;

function progressFromLine(line: string): any | null {
  const at = line.indexOf(PROGRESS_PREFIX);
  if (at < 0) return null;
  try { return JSON.parse(line.slice(at + PROGRESS_PREFIX.length)); } catch { return null; }
}

export function configTemplate(engine: string, headed: boolean, hasPauses = false, settings: BrowserPermissionSettings = { permissions: [] }): string {
  const browserName = ['chromium', 'firefox', 'webkit'].includes(engine) ? engine : 'chromium';
  // Use system Chrome when bundled Chromium is absent (same resolution as the recorder).
  const channel = browserName === 'chromium' ? chromiumChannel() : undefined;
  const chromiumArgs = browserName === 'chromium'
    ? [...(headed ? ['--start-maximized'] : []), ...(settings.fakeMedia ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : [])]
    : [];
  const launchOptions = chromiumArgs.length ? `, launchOptions: { args: ${JSON.stringify(chromiumArgs)} }` : '';
  const geolocation = settings.geolocation ? `, geolocation: ${JSON.stringify(settings.geolocation)}` : '';
  return `import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  // No per-test ceiling — a script runs until its own steps finish (or the user cancels it) — but each
  // ACTION is bounded: with both unset, a step waiting on an element that never appears hangs the whole
  // run instead of failing, which is what blocked flows midway with no error.
  timeout: 0,
  expect: { timeout: 15000 },
  reporter: [['./progress-reporter.cjs'], ['list'], ['json', { outputFile: 'results.json' }], ['junit', { outputFile: 'results.xml' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  // Capture on every run (not just failures) so each execution has step snapshots, a full video of
  // every action, and a trace to download. 'on' screenshots at each test end; the video + trace carry
  // the per-action detail.
  use: { browserName: '${browserName}',${channel ? ` channel: '${channel}',` : ''} headless: ${headed ? 'false' : 'true'},${headed ? ' viewport: null,' : ''} actionTimeout: 30000, navigationTimeout: 60000, trace: 'on', video: 'on', screenshot: 'on'${geolocation}${launchOptions} },
});
`;
}

export class Runner {
  private cancelled = new Set<string>();
  private running = new Map<string, import('child_process').ChildProcess>();
  private pauseControls = new Map<string, PauseControl>();

  constructor(private log: Logger, private workDir: string, private config: AgentConfig, private send: SendFrame) {}

  isBusy(): boolean {
    return this.running.size > 0;
  }

  isAwaitingUser(): boolean {
    return [...this.pauseControls.values()].some((control) => control.openPauses().length > 0);
  }

  openPauses(): OpenPause[] {
    return [...this.pauseControls.values()].flatMap((control) => control.openPauses());
  }

  advertiseOpenPauses(): void {
    for (const pause of this.openPauses()) this.send('job.paused', { ...pause });
  }

  resolvePause(jobId: string, answer: PauseControlAnswer): boolean {
    const control = this.pauseControls.get(jobId);
    const wasOpen = control?.openPauses().some((pause) => pause.pauseId === answer.pauseId && pause.attempt === answer.attempt) ?? false;
    const resolved = control?.resolve(answer.pauseId, answer) ?? false;
    if (resolved && wasOpen) this.send('job.progress', { jobId, phase: 'running', event: 'pause_resolved', pauseId: answer.pauseId, outcome: answer.outcome });
    return resolved;
  }

  cancelPause(jobId: string, pauseId: string, attempt = 1, resolvedBy = 'cloud'): boolean {
    return this.resolvePause(jobId, { pauseId, attempt, outcome: 'aborted', resolvedBy });
  }

  cancel(jobId: string): void {
    this.cancelled.add(jobId);
    for (const pause of this.pauseControls.get(jobId)?.openPauses() || []) this.cancelPause(jobId, pause.pauseId, pause.attempt, 'job_cancelled');
    const child = this.running.get(jobId);
    if (child?.pid) {
      if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
  }

  async run(job: Job): Promise<void> {
    const runDir = path.join(this.workDir, 'runs', job.jobId.replace(/[^a-zA-Z0-9._-]/g, '_'));
    const hasPauses = job.pauseResume === true && /\btf\.pause\s*\(/.test(job.script || '');
    const browserPermissions = normalizeBrowserPermissionSettings(job.browserPermissions);
    const control = hasPauses ? await startPauseControl(job.jobId, (pause) => this.send('job.paused', { ...pause })) : undefined;
    if (control) this.pauseControls.set(job.jobId, control);
    let exitCode = 1;
    let output: string[] = [];
    try {
      fs.mkdirSync(path.join(runDir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(runDir, 'playwright.config.ts'), configTemplate(job.browser, !!job.headed, hasPauses, browserPermissions));
      fs.writeFileSync(path.join(runDir, 'progress-reporter.cjs'), progressReporterSource);
      fs.writeFileSync(path.join(runDir, 'tests', 'recording.spec.ts'), `${browserPermissionPrelude(browserPermissions, job.appUrl)}${videoTailPreludeSource}${hasPauses ? pausePreludeSource : ''}${bundledTestRuntime(job.script || '')}`);
      this.log.info({ jobId: job.jobId, browser: job.browser, headed: !!job.headed, pauses: hasPauses }, 'job started');
      this.send('job.progress', { jobId: job.jobId, phase: 'running' });
      ({ exitCode, output } = await this.execute(job, runDir, control));
    } finally {
      this.pauseControls.delete(job.jobId);
      await control?.close();
    }

    if (this.cancelled.has(job.jobId)) {
      this.cancelled.delete(job.jobId);
      this.send('job.done', { jobId: job.jobId, exitCode: 130, summary: {}, error: 'Cancelled.' });
      return;
    }

    const summary = this.parseSummary(runDir);
    const outputFailure = output.join('\n').slice(-4000);
    const failure = exitCode === 0 ? '' : this.parseFailure(runDir, job.script) || (outputFailure ? `Execution failed.\nRunner output:\n${outputFailure}` : '');
    this.send('job.progress', { jobId: job.jobId, phase: 'uploading' });
    this.send('job.done', { jobId: job.jobId, exitCode, summary, error: failure || (exitCode === 0 ? '' : 'Test run reported failures.') });
    // Execution is complete before evidence transfer. Report the result immediately so the Test Run
    // does not remain Running while potentially slow screenshots, traces, and videos upload.
    void this.uploadAll(job.jobId, runDir).catch((err) => this.log.error({ err: err?.message }, 'artifact upload failed'));
    this.log.info({ jobId: job.jobId, exitCode, summary }, 'job finished');
  }

  private execute(job: Job, runDir: string, control?: PauseControl): Promise<{ exitCode: number; output: string[] }> {
    return new Promise((resolve) => {
      const output: string[] = [];
      const child = spawn(process.execPath, [playwrightCli, 'test', '--config', 'playwright.config.ts'], {
        cwd: runDir,
        env: {
          ...process.env,
          PLAYWRIGHT_HTML_OPEN: 'never',
          TESTFLOW_STEP_TOTAL: String(job.stepTotal || 0),
          ...(control ? { TESTFLOW_CONTROL_URL: control.url, TESTFLOW_CONTROL_KEY: control.key, TESTFLOW_JOB_ID: job.jobId } : {}),
        },
      });
      this.running.set(job.jobId, child);
      const onLine = (line: string) => {
        const progress = progressFromLine(line);
        if (progress) this.send('job.progress', { jobId: job.jobId, phase: 'running', ...progress });
        else { output.push(line); if (output.length > 30) output.shift(); this.send('job.log', { jobId: job.jobId, line }); }
      };
      if (child.stdout) createInterface({ input: child.stdout }).on('line', onLine);
      if (child.stderr) createInterface({ input: child.stderr }).on('line', onLine);
      child.once('close', (code) => { this.running.delete(job.jobId); resolve({ exitCode: code ?? 1, output }); });
      child.once('error', (err) => { this.log.error({ err: err.message }, 'runner spawn error'); this.running.delete(job.jobId); resolve({ exitCode: 1, output: [...output, `Runner error: ${err.message}`] }); });
    });
  }

  private parseSummary(runDir: string): Record<string, any> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8'));
      const stats = raw.stats || {};
      const tests: any[] = [];
      // Same per-test screenshot correlation as the server runner (serverRunner.ts parseSummary) —
      // Playwright attaches one PNG per test result when screenshot:'on', filename matches the
      // uploaded artifact, so the report can look it up by test title.
      const testScreenshots: Record<string, string> = {};
      const visit = (suite: any) => {
        for (const spec of suite?.specs || []) for (const test of spec.tests || []) {
          const result = test.results?.[test.results.length - 1] || {};
          tests.push({ title: spec.title || test.title || 'Playwright test', status: result.status || 'skipped', error: result.error?.message || result.error || '', durationMs: Number(result.duration) || 0 });
          const shot = (result.attachments || []).find((a: any) => a.name === 'screenshot' && a.path);
          if (shot) testScreenshots[spec.title || test.title || ''] = path.basename(shot.path);
        }
        for (const child of suite?.suites || []) visit(child);
      };
      visit(raw);
      return {
        expected: stats.expected || 0,
        unexpected: stats.unexpected || 0,
        passed: stats.expected || 0,
        failed: stats.unexpected || 0,
        flaky: stats.flaky || 0,
        skipped: stats.skipped || 0,
        durationMs: Math.round(stats.duration || 0),
        tests,
        testScreenshots,
      };
    } catch {
      return {};
    }
  }

  private parseFailure(runDir: string, script: string): string {
    try {
      return playwrightFailure(JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8')), script);
    } catch {
      return '';
    }
  }

  private async uploadAll(jobId: string, runDir: string): Promise<void> {
    const artifacts = collectArtifacts(runDir);
    for (const a of artifacts) {
      await uploadArtifact(this.config, jobId, a.kind as ArtifactKind, a.path, a.filename)
        .catch((err) => this.log.warn({ file: a.filename, err: err?.message }, 'artifact upload retry exhausted'));
    }
  }
}
