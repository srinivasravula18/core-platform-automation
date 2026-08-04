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
import { uploadArtifact } from './cloud.js';
import { collectArtifacts } from './artifacts.js';
import { chromiumChannel } from './browsers.js';
import { playwrightFailure } from './playwrightFailure.js';
const PROGRESS_PREFIX = '@@TESTFLOW_PROGRESS@@';
const require = createRequire(import.meta.url);
const playwrightCli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
export function bundledTestRuntime(source) {
    return source.replace(/(['"])@playwright\/test\1/g, '$1playwright/test$1');
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
function progressFromLine(line) {
    const at = line.indexOf(PROGRESS_PREFIX);
    if (at < 0)
        return null;
    try {
        return JSON.parse(line.slice(at + PROGRESS_PREFIX.length));
    }
    catch {
        return null;
    }
}
function configTemplate(engine, headed) {
    const browserName = ['chromium', 'firefox', 'webkit'].includes(engine) ? engine : 'chromium';
    // Use system Chrome when bundled Chromium is absent (same resolution as the recorder).
    const channel = browserName === 'chromium' ? chromiumChannel() : undefined;
    return `import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60000,
  reporter: [['./progress-reporter.cjs'], ['list'], ['json', { outputFile: 'results.json' }], ['junit', { outputFile: 'results.xml' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  // Capture on every run (not just failures) so each execution has step snapshots, a full video of
  // every action, and a trace to download. 'on' screenshots at each test end; the video + trace carry
  // the per-action detail.
  use: { browserName: '${browserName}',${channel ? ` channel: '${channel}',` : ''} headless: ${headed ? 'false' : 'true'}, trace: 'on', video: 'on', screenshot: 'on' },
});
`;
}
export class Runner {
    log;
    workDir;
    config;
    send;
    cancelled = new Set();
    running = new Map();
    constructor(log, workDir, config, send) {
        this.log = log;
        this.workDir = workDir;
        this.config = config;
        this.send = send;
    }
    isBusy() {
        return this.running.size > 0;
    }
    cancel(jobId) {
        this.cancelled.add(jobId);
        const child = this.running.get(jobId);
        if (child?.pid) {
            if (process.platform === 'win32')
                spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
            else
                child.kill('SIGTERM');
        }
    }
    async run(job) {
        const runDir = path.join(this.workDir, 'runs', job.jobId.replace(/[^a-zA-Z0-9._-]/g, '_'));
        fs.mkdirSync(path.join(runDir, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(runDir, 'playwright.config.ts'), configTemplate(job.browser, !!job.headed));
        fs.writeFileSync(path.join(runDir, 'progress-reporter.cjs'), progressReporterSource);
        fs.writeFileSync(path.join(runDir, 'tests', 'recording.spec.ts'), bundledTestRuntime(job.script || ''));
        this.log.info({ jobId: job.jobId, browser: job.browser, headed: !!job.headed }, 'job started');
        this.send('job.progress', { jobId: job.jobId, phase: 'running' });
        const { exitCode, output } = await this.execute(job, runDir);
        if (this.cancelled.has(job.jobId)) {
            this.cancelled.delete(job.jobId);
            this.send('job.done', { jobId: job.jobId, exitCode: 130, summary: {}, error: 'Cancelled.' });
            return;
        }
        const summary = this.parseSummary(runDir);
        const outputFailure = output.join('\n').slice(-4000);
        const failure = exitCode === 0 ? '' : this.parseFailure(runDir, job.script) || (outputFailure ? `Execution failed.\nRunner output:\n${outputFailure}` : '');
        this.send('job.progress', { jobId: job.jobId, phase: 'uploading' });
        await this.uploadAll(job.jobId, runDir).catch((err) => this.log.error({ err: err?.message }, 'artifact upload failed'));
        this.send('job.done', { jobId: job.jobId, exitCode, summary, error: failure || (exitCode === 0 ? '' : 'Test run reported failures.') });
        this.log.info({ jobId: job.jobId, exitCode, summary }, 'job finished');
    }
    execute(job, runDir) {
        return new Promise((resolve) => {
            const output = [];
            const child = spawn(process.execPath, [playwrightCli, 'test', '--config', 'playwright.config.ts'], {
                cwd: runDir,
                env: { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never', TESTFLOW_STEP_TOTAL: String(job.stepTotal || 0) },
            });
            this.running.set(job.jobId, child);
            const onLine = (line) => {
                const progress = progressFromLine(line);
                if (progress)
                    this.send('job.progress', { jobId: job.jobId, phase: 'running', ...progress });
                else {
                    output.push(line);
                    if (output.length > 30)
                        output.shift();
                    this.send('job.log', { jobId: job.jobId, line });
                }
            };
            if (child.stdout)
                createInterface({ input: child.stdout }).on('line', onLine);
            if (child.stderr)
                createInterface({ input: child.stderr }).on('line', onLine);
            child.once('close', (code) => { this.running.delete(job.jobId); resolve({ exitCode: code ?? 1, output }); });
            child.once('error', (err) => { this.log.error({ err: err.message }, 'runner spawn error'); this.running.delete(job.jobId); resolve({ exitCode: 1, output: [...output, `Runner error: ${err.message}`] }); });
        });
    }
    parseSummary(runDir) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8'));
            const stats = raw.stats || {};
            return {
                expected: stats.expected || 0,
                unexpected: stats.unexpected || 0,
                passed: stats.expected || 0,
                failed: stats.unexpected || 0,
                flaky: stats.flaky || 0,
                skipped: stats.skipped || 0,
                durationMs: Math.round(stats.duration || 0),
            };
        }
        catch {
            return {};
        }
    }
    parseFailure(runDir, script) {
        try {
            return playwrightFailure(JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8')), script);
        }
        catch {
            return '';
        }
    }
    async uploadAll(jobId, runDir) {
        const artifacts = collectArtifacts(runDir);
        for (const a of artifacts) {
            await uploadArtifact(this.config, jobId, a.kind, a.path, a.filename)
                .catch((err) => this.log.warn({ file: a.filename, err: err?.message }, 'artifact upload retry exhausted'));
        }
    }
}
//# sourceMappingURL=runner.js.map