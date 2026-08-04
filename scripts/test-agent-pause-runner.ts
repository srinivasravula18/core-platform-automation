import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Runner } from '../agent/src/runner';
import { setPauseResumeV1 } from '../server/features/automation/flag';

process.env.DISABLE_POSTGRES = '1';
setPauseResumeV1(1);
const scratch = path.resolve(process.cwd(), 'agent', 'playwright', 'pause-runner-test');
fs.mkdirSync(scratch, { recursive: true });

const uploads = http.createServer((_req, res) => res.writeHead(200).end());
await new Promise<void>((resolve) => uploads.listen(0, '127.0.0.1', resolve));
const port = (uploads.address() as AddressInfo).port;
const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
const log = { info() {}, warn() {}, error() {}, debug() {} } as any;
let runner: Runner;
const send = (type: string, payload: Record<string, unknown>) => {
  frames.push({ type, payload });
  if (type === 'job.paused') {
    assert.equal(payload.request && (payload.request as any).prompt, 'Enter the OTP');
    assert.equal(runner.isAwaitingUser(), true);
    if (frames.filter((frame) => frame.type === 'job.paused').length === 1) runner.advertiseOpenPauses();
    setImmediate(() => runner.resolvePause('pause-run', {
      pauseId: String(payload.pauseId), attempt: Number(payload.attempt), outcome: 'resolved', value: '123456', resolvedBy: 'test',
    }));
  }
};
try {
  runner = new Runner(log, scratch, { cloudUrl: `http://127.0.0.1:${port}`, agentToken: 'test' }, send);
  await runner.run({
    jobId: 'pause-run', recordingId: 'recording-1', browser: 'chromium', environment: 'test', appUrl: '',
    pauseResume: true,
    script: `import { test, expect } from '@playwright/test';
test('resumes a pause', async () => {
  const otp = await tf.pause({ id: 'otp', kind: 'input', prompt: 'Enter the OTP', timeoutMs: 5000 });
  expect(otp).toBe('123456');
});`,
  });

  const done = frames.find((frame) => frame.type === 'job.done');
  assert.equal(done?.payload.exitCode, 0);
  assert.equal(frames.filter((frame) => frame.type === 'job.paused').length, 2, 'open pause is re-advertised after reconnect');
  assert.equal(frames.filter((frame) => frame.payload.event === 'pause_resolved').length, 1, 'duplicate resume is idempotent');
  assert.equal(runner.openPauses().length, 0);
  assert.equal(JSON.stringify(frames).includes('123456'), false, 'pause value must never enter frames');
  assert.match(fs.readFileSync(path.join(scratch, 'runs', 'pause-run', 'playwright.config.ts'), 'utf8'), /timeout: 0/);
} finally {
  await new Promise<void>((resolve, reject) => uploads.close((error) => error ? reject(error) : resolve()));
}

process.chdir(scratch);
const { db } = await import('../server/shared/storage');
const { AutomationJobs, Recordings } = await import('../server/db/repository');
const pauseService = await import('../server/features/automation/pauseService');
const { runJobOnServer } = await import('../server/features/automation/serverRunner');
db.automationJobs = []; db.automationJobPauses = []; db.recordings = []; db.automationArtifacts = []; db.automationEvents = [];
await Recordings.upsert({
  id: 'server-recording', name: 'Server pause', browser: 'chromium', ownerId: 'u1', projectId: 'p1', appId: 'a1',
  script: `import { test, expect } from '@playwright/test';
test('server resumes a pause', async () => {
  const otp = await tf.pause({ id: 'server-otp', kind: 'input', prompt: 'Server OTP', timeoutMs: 5000 });
  expect(otp).toBe('987654');
});`,
});
await AutomationJobs.upsert({ id: 'server-pause-run', recordingId: 'server-recording', agentId: '', status: 'queued', ownerId: 'u1', projectId: 'p1', appId: 'a1', summary: {} });
const serverRun = runJobOnServer('server-pause-run');
let serverPause: any;
for (let i = 0; i < 250 && !serverPause; i++) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  serverPause = (await pauseService.listJobPauses('server-pause-run'))[0];
}
assert.ok(serverPause, 'server runner must advertise its pause');
assert.ok((await pauseService.resolvePause('server-pause-run', 'server-otp', { outcome: 'resolved', value: '987654' }, 'u1')).pause);
await serverRun;
assert.equal((await AutomationJobs.get('server-pause-run'))?.status, 'done');
assert.equal(JSON.stringify(await pauseService.listJobPauses('server-pause-run')).includes('987654'), false);
console.log('agent pause runner checks passed');
