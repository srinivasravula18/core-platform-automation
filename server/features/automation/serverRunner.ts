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
import { AutomationJobs, Recordings } from '../../db/repository';
import { setJobStatus } from './jobService';
import { saveArtifact } from './artifactService';
import { emitEvent } from './eventsService';
import type { ArtifactKind } from './types';

const RUN_ROOT = path.resolve(process.cwd(), '.testflow-pw', 'automation');
const running = new Map<string, ReturnType<typeof spawn>>();

function configTemplate(engine: string): string {
  const browserName = ['chromium', 'firefox', 'webkit'].includes(engine) ? engine : 'chromium';
  return `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60000,
  reporter: [['list'], ['json', { outputFile: 'results.json' }], ['junit', { outputFile: 'results.xml' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: { browserName: '${browserName}', headless: true, trace: 'on', video: 'on', screenshot: 'on' },
});
`;
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
    return { passed: s.expected || 0, failed: s.unexpected || 0, flaky: s.flaky || 0, skipped: s.skipped || 0, durationMs: Math.round(s.duration || 0) };
  } catch { return {}; }
}

/** Execute a queued job's recording headless on the server. Resolves when the run + upload finish. */
export async function runJobOnServer(jobId: string): Promise<void> {
  const job = await AutomationJobs.get(jobId);
  if (!job) return;
  const rec = job.recordingId ? await Recordings.get(job.recordingId) : null;
  if (!rec || !rec.script) {
    await setJobStatus(jobId, 'failed', { error: 'Recording has no script to run.', finishedAt: new Date().toISOString() });
    return;
  }

  const runDir = path.join(RUN_ROOT, jobId.replace(/[^a-zA-Z0-9._-]/g, '_'));
  fs.mkdirSync(path.join(runDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'playwright.config.ts'), configTemplate(rec.browser));
  fs.writeFileSync(path.join(runDir, 'tests', 'recording.spec.ts'), rec.script);

  await setJobStatus(jobId, 'running', { startedAt: new Date().toISOString() });
  const log = (line: string) => emitEvent({ scopeType: 'job', scopeId: jobId, type: 'job.log', ownerId: job.ownerId, data: { line } });

  const exitCode: number = await new Promise((resolve) => {
    const child = spawn('npx', ['playwright', 'test', '--config', 'playwright.config.ts'], {
      cwd: runDir, shell: process.platform === 'win32', env: { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never' },
    });
    running.set(jobId, child);
    const onLine = (b: Buffer) => String(b).split('\n').filter(Boolean).forEach((l) => void log(l));
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.once('close', (code) => { running.delete(jobId); resolve(code ?? 1); });
    child.once('error', (err) => { void log(`runner error: ${err.message}`); running.delete(jobId); resolve(1); });
  });

  await setJobStatus(jobId, 'uploading');
  for (const a of collectArtifacts(runDir)) {
    try { await saveArtifact({ jobId, kind: a.kind, filename: a.filename, buffer: fs.readFileSync(a.path), ownerId: job.ownerId }); }
    catch (err: any) { void log(`artifact save failed (${a.filename}): ${err?.message}`); }
  }

  const summary = parseSummary(runDir);
  await setJobStatus(jobId, exitCode === 0 ? 'done' : 'failed', { exitCode, summary, error: exitCode === 0 ? '' : 'Test run reported failures.', finishedAt: new Date().toISOString() });
}

/** Cancel a server-side run in flight. */
export function cancelServerJob(jobId: string): void {
  const child = running.get(jobId);
  if (child?.pid) {
    if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
}
