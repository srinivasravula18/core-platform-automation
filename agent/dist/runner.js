/**
 * Local test execution.
 *
 * On job.dispatch the agent materializes a throwaway workspace (config + spec), runs
 * `npx playwright test`, streams log lines to the cloud, parses the JSON/JUnit reporters for a
 * pass/fail summary, then uploads artifacts (trace.zip, video, screenshots, reports). Everything runs
 * on the user's machine; only results + artifacts go back up.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { uploadArtifact } from './cloud.js';
import { collectArtifacts } from './artifacts.js';
import { chromiumChannel } from './browsers.js';
function configTemplate(engine) {
    const browserName = ['chromium', 'firefox', 'webkit'].includes(engine) ? engine : 'chromium';
    // Use system Chrome when bundled Chromium is absent (same resolution as the recorder).
    const channel = browserName === 'chromium' ? chromiumChannel() : undefined;
    return `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60000,
  reporter: [['list'], ['json', { outputFile: 'results.json' }], ['junit', { outputFile: 'results.xml' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  // Capture on every run (not just failures) so each execution has step snapshots, a full video of
  // every action, and a trace to download. 'on' screenshots at each test end; the video + trace carry
  // the per-action detail.
  use: { browserName: '${browserName}',${channel ? ` channel: '${channel}',` : ''} headless: true, trace: 'on', video: 'on', screenshot: 'on' },
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
        fs.writeFileSync(path.join(runDir, 'playwright.config.ts'), configTemplate(job.browser));
        fs.writeFileSync(path.join(runDir, 'tests', 'recording.spec.ts'), job.script || '');
        this.log.info({ jobId: job.jobId, browser: job.browser }, 'job started');
        this.send('job.progress', { jobId: job.jobId, phase: 'running' });
        const exitCode = await this.execute(job, runDir);
        if (this.cancelled.has(job.jobId)) {
            this.cancelled.delete(job.jobId);
            this.send('job.done', { jobId: job.jobId, exitCode: 130, summary: {}, error: 'Cancelled.' });
            return;
        }
        const summary = this.parseSummary(runDir);
        this.send('job.progress', { jobId: job.jobId, phase: 'uploading' });
        await this.uploadAll(job.jobId, runDir).catch((err) => this.log.error({ err: err?.message }, 'artifact upload failed'));
        this.send('job.done', { jobId: job.jobId, exitCode, summary, error: exitCode === 0 ? '' : 'Test run reported failures.' });
        this.log.info({ jobId: job.jobId, exitCode, summary }, 'job finished');
    }
    execute(job, runDir) {
        return new Promise((resolve) => {
            const child = spawn('npx', ['playwright', 'test', '--config', 'playwright.config.ts'], {
                cwd: runDir,
                shell: process.platform === 'win32',
                env: { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never' },
            });
            this.running.set(job.jobId, child);
            const onLine = (buf) => String(buf).split('\n').filter(Boolean).forEach((line) => this.send('job.log', { jobId: job.jobId, line }));
            child.stdout?.on('data', onLine);
            child.stderr?.on('data', onLine);
            child.once('close', (code) => { this.running.delete(job.jobId); resolve(code ?? 1); });
            child.once('error', (err) => { this.log.error({ err: err.message }, 'runner spawn error'); this.running.delete(job.jobId); resolve(1); });
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
    async uploadAll(jobId, runDir) {
        const artifacts = collectArtifacts(runDir);
        for (const a of artifacts) {
            await uploadArtifact(this.config, jobId, a.kind, a.path, a.filename)
                .catch((err) => this.log.warn({ file: a.filename, err: err?.message }, 'artifact upload retry exhausted'));
        }
    }
}
//# sourceMappingURL=runner.js.map