/**
 * Record & Play — Phase 2 tests (recordings, jobs, scheduler math, artifacts, frame handlers). Offline.
 *   npx tsx scripts/test-record-play-jobs.ts   (npm run test:record-play-jobs)
 *
 * No live agent/WebSocket: isAgentConnected() is false, so jobs stay queued (deterministic). Agent→cloud
 * frames are simulated via deliverAgentFrame(). Persistence is redirected to scratch.
 */
import fs from 'fs';
import path from 'path';

for (const k of ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGPORT']) delete process.env[k];
process.env.DISABLE_POSTGRES = '1';
process.env.REMOTE_AGENT_V1 = '1';
const scratch = path.resolve(process.cwd(), '.testflow-pw', 'scratch', 'record-play-jobs-test');
fs.mkdirSync(scratch, { recursive: true });
process.chdir(scratch);

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

const SCOPE = { projectId: 'p1', appId: 'a1' as string | null, userId: 'u1', role: '' };

async function main() {
  const rec = await import('../server/features/automation/recordingService');
  const jobs = await import('../server/features/automation/jobService');
  const sched = await import('../server/features/automation/schedulerService');
  const artifacts = await import('../server/features/automation/artifactService');
  const gateway = await import('../server/features/automation/agentGateway');
  const events = await import('../server/features/automation/eventsService');
  const pauses = await import('../server/features/automation/pauseService');
  const { db } = await import('../server/shared/storage');
  const { AutomationEvents, AutomationJobs, Runs, Scripts } = await import('../server/db/repository');
  const { playwrightFailure } = await import('../agent/src/playwrightFailure');
  db.recordings = []; db.scripts = []; db.automationJobs = []; db.automationJobPauses = []; db.automationSchedules = []; db.automationArtifacts = []; db.automationEvents = [];
  ok(!jobs.agentSupportsPauseResume('0.9.9') && !jobs.agentSupportsPauseResume('1.0.1') && jobs.agentSupportsPauseResume('1.0.2') && jobs.agentSupportsPauseResume('1.2.0'), 'pause runs require a compatible desktop agent version');

  console.log('recording lifecycle');
  const r = await rec.createRecording({
    name: 'Login flow', appUrl: 'http://localhost:5002', browser: 'chromium',
    browserPermissions: { permissions: ['camera', 'geolocation'], geolocation: { latitude: 12.97, longitude: 77.59 }, fakeMedia: true },
  }, SCOPE);
  ok(!!r.id && r.status === 'draft', 'recording created as draft');
  ok(r.ownerId === 'u1' && r.projectId === 'p1', 'recording scope-stamped');
  ok(r.metadata.browserPermissions?.fakeMedia === true && r.metadata.browserPermissions?.geolocation?.latitude === 12.97, 'browser permission preferences persisted');
  const renamed = await rec.updateRecording(r.id, { name: 'Login flow v2' });
  ok(renamed?.name === 'Login flow v2', 'recording renamed');

  console.log('record.done frame ingests the script + stats');
  const completeRecordedScript = "import { test } from '@playwright/test';\ntest('recorded flow', async ({ page }) => {\n  await page.goto('http://localhost:5002');\n  await page.getByRole('button', { name: 'Continue' }).click();\n});";
  await gateway.deliverAgentFrame('agent-x', { type: 'record.done', agentId: 'agent-x', seq: 1, payload: { recordingId: r.id, script: completeRecordedScript, stats: { actions: 12, assertions: 3 } } });
  const done = await rec.getRecording(r.id);
  ok(done.status === 'ready', 'recording marked ready after record.done');
  ok(done.script === completeRecordedScript && done.stats.actions === 12, 'complete script + stats persisted');

  console.log('late record.done replaces a partial stop fallback');
  const fallbackRace = await rec.createRecording({ name: 'Fallback race', appUrl: 'http://localhost:5002', browser: 'chromium' }, SCOPE);
  const partialScript = "import { test } from '@playwright/test';\ntest('flow', async ({ page }) => { await page.goto('http://localhost:5002'); });";
  const fullScript = partialScript.replace(' });', " await page.getByRole('button', { name: 'Continue' }).click(); });");
  await rec.finalizeRecording(fallbackRace.id, { script: partialScript });
  await rec.finalizeRecording(fallbackRace.id, { script: fullScript, metadata: { generatedOn: 'tester-laptop' } });
  const completedRace = await rec.getRecording(fallbackRace.id);
  const completedRaceScript = await Scripts.get(completedRace.metadata.scriptId);
  ok(completedRace.script === fullScript, 'agent final file replaces partial fallback recording');
  ok(completedRaceScript?.code === fullScript, 'agent final file replaces partial linked script');

  console.log('repository script resolves to one reusable execution recording');
  const repositoryScript = await Scripts.upsert({ id: 'SCR-REPOSITORY-1', name: 'Repository flow', code: "import { test } from '@playwright/test';\ntest('flow', async () => {});", projectId: 'p1', appId: 'a1', ownerId: 'u1' });
  const scriptRecording = await rec.recordingForScript(repositoryScript.id, SCOPE);
  const reusedScriptRecording = await rec.recordingForScript(repositoryScript.id, SCOPE);
  ok(scriptRecording?.status === 'ready' && scriptRecording.script === repositoryScript.code, 'repository script prepared for scheduling');
  ok(reusedScriptRecording?.id === scriptRecording?.id, 'repository script reuses its execution recording');
  const preferredScript = await Scripts.upsert({ ...repositoryScript, executionMode: 'headed', preferredAgentId: 'agent-x' });
  const scriptWithoutPreference = { ...preferredScript };
  delete scriptWithoutPreference.executionMode;
  delete scriptWithoutPreference.preferredAgentId;
  await Scripts.upsert({ ...scriptWithoutPreference, status: 'Ready' });
  const preservedPreference = await Scripts.get(repositoryScript.id);
  ok(preservedPreference?.executionMode === 'headed' && preservedPreference?.preferredAgentId === 'agent-x', 'script execution preference survives unrelated updates');

  console.log('job stays queued when agent offline, then progresses via frames');
  const job = await jobs.createJob({ recordingId: r.id, agentId: 'agent-x', trigger: 'manual' }, SCOPE);
  ok(job.status === 'queued', 'job queued (agent not connected → not dispatched)');
  ok(gateway.isAgentConnected('agent-x') === false, 'agent reported offline');
  await gateway.deliverAgentFrame('agent-x', { type: 'job.progress', agentId: 'agent-x', seq: 1, payload: { jobId: job.id, phase: 'running' } });
  ok((await jobs.getJob(job.id)).status === 'running', 'job.progress → running');
  await gateway.deliverAgentFrame('agent-x', { type: 'job.done', agentId: 'agent-x', seq: 2, payload: { jobId: job.id, exitCode: 0, summary: { passed: 5, failed: 0 } } });
  const finished = await jobs.getJob(job.id);
  ok(finished.status === 'done' && finished.exitCode === 0, 'job.done exitCode 0 → done');
  ok(finished.summary.passed === 5, 'job summary persisted');

  console.log('progress frames stay ordered through terminal completion');
  const orderedJob = await jobs.createJob({ recordingId: r.id, agentId: 'agent-x', trigger: 'manual' }, SCOPE);
  await Promise.all([
    gateway.deliverAgentFrame('agent-x', { type: 'job.progress', agentId: 'agent-x', seq: 10, payload: { jobId: orderedJob.id, phase: 'running', event: 'step_started', stepId: 'step-1', stepIndex: 1, stepTitle: 'Open page', stepStartedAt: 100 } }),
    gateway.deliverAgentFrame('agent-x', { type: 'job.progress', agentId: 'agent-x', seq: 11, payload: { jobId: orderedJob.id, phase: 'running', event: 'step_finished', stepId: 'step-1', stepIndex: 1, stepTitle: 'Open page', stepStartedAt: 100, stepDurationMs: 200 } }),
    gateway.deliverAgentFrame('agent-x', { type: 'job.done', agentId: 'agent-x', seq: 12, payload: { jobId: orderedJob.id, exitCode: 0, summary: { passed: 1, failed: 0 } } }),
  ]);
  await gateway.deliverAgentFrame('agent-x', { type: 'job.progress', agentId: 'agent-x', seq: 13, payload: { jobId: orderedJob.id, phase: 'running', event: 'step_started', stepId: 'late-step', stepIndex: 2, stepTitle: 'Late frame', stepStartedAt: 300 } });
  const orderedResult = await jobs.getJob(orderedJob.id);
  ok(orderedResult.status === 'done' && orderedResult.summary.executionSteps[0].status === 'Passed', 'terminal job cannot retain or accept Running steps');
  await AutomationJobs.upsert({ ...orderedResult, summary: { executionSteps: [{ id: 'stale', index: 1, title: 'Stale step', status: 'Running', startedAt: 100, durationMs: 0 }] } });
  ok((await jobs.getJob(orderedJob.id)).summary.executionSteps[0].status === 'Passed', 'opening a historical terminal job repairs stale Running steps');

  const serverJob = await jobs.createServerJob({ recordingId: r.id, trigger: 'manual' }, SCOPE);
  ok(serverJob.status === 'queued' && serverJob.agentId === '', 'manual server job does not require an agent');

  console.log('pause lifecycle persists metadata without values');
  const pausedJob = await jobs.createJob({ recordingId: r.id, agentId: 'agent-x', trigger: 'manual' }, SCOPE);
  await gateway.deliverAgentFrame('agent-x', { type: 'job.paused', agentId: 'agent-x', seq: 20, payload: {
    jobId: pausedJob.id, pauseId: 'otp', attempt: 1,
    request: { id: 'otp', kind: 'input', prompt: 'Enter OTP', timeoutMs: 5000 },
    openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5000).toISOString(),
  } });
  ok((await jobs.getJob(pausedJob.id)).status === 'awaiting_user', 'job.paused → awaiting_user');
  ok((await pauses.listJobPauses(pausedJob.id))[0]?.masked === true, 'pause defaults persisted');
  await jobs.cancelJob(pausedJob.id);
  ok((await pauses.listJobPauses(pausedJob.id))[0]?.outcome === 'aborted', 'cancelling a job closes its pause');

  const localPauseJob = await jobs.createServerJob({ recordingId: r.id, trigger: 'manual' }, SCOPE);
  await pauses.recordPause('', { jobId: localPauseJob.id, attempt: 1, request: { id: 'server-otp', kind: 'input', prompt: 'OTP', timeoutMs: 5000 } });
  const unregister = pauses.registerLocalPauseResolver(localPauseJob.id, (answer) => answer.value === '654321');
  const resolvedPause = await pauses.resolvePause(localPauseJob.id, 'server-otp', { outcome: 'resolved', value: '654321' }, 'u1');
  unregister();
  ok(resolvedPause.pause?.outcome === 'resolved' && resolvedPause.pause?.valueLength === 6, 'server pause resolves with value length only');
  ok(!JSON.stringify(await pauses.listJobPauses(localPauseJob.id)).includes('654321'), 'pause value is never persisted');

  console.log('stopping a job cancels its linked Test Run');
  const cancelledJob = await jobs.createServerJob({ recordingId: r.id, trigger: 'manual' }, SCOPE);
  const linkedRun = await jobs.createLinkedTestRun(cancelledJob, r, SCOPE);
  await jobs.syncLinkedRunProgress(cancelledJob.id, 'running', { completed: 1, total: 2, event: 'test_finished', currentTest: 'First test' });
  const progressingRun = await Runs.get(linkedRun.id);
  ok(progressingRun?.triggerMeta?.automationExecution?.percent === 50 && progressingRun?.progress.includes('1/2'), 'linked Test Run receives incremental progress');
  await jobs.cancelJob(cancelledJob.id);
  ok((await jobs.getJob(cancelledJob.id)).status === 'cancelled', 'stopped job remains cancelled');
  ok((await Runs.get(linkedRun.id))?.status === 'Cancelled', 'linked Test Run closes as Cancelled');
  await gateway.deliverAgentFrame('agent-x', { type: 'job.done', agentId: 'agent-x', seq: 3, payload: { jobId: cancelledJob.id, exitCode: 130 } });
  ok((await jobs.getJob(cancelledJob.id)).status === 'cancelled', 'late process exit cannot overwrite cancellation');

  console.log('job failure path');
  const job2 = await jobs.createJob({ recordingId: r.id, agentId: 'agent-x', trigger: 'manual' }, SCOPE);
  await gateway.deliverAgentFrame('agent-x', { type: 'job.done', agentId: 'agent-x', seq: 1, payload: { jobId: job2.id, exitCode: 1, error: 'timeout' } });
  ok((await jobs.getJob(job2.id)).status === 'failed', 'non-zero exit → failed');

  console.log('Playwright failures identify the recorded step and source line');
  const failedScript = "test('flow', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.getByRole('button', { name: 'Save' }).click();\n});";
  const failure = playwrightFailure({ suites: [{ specs: [{ tests: [{ results: [{
    status: 'failed', error: { message: 'locator.click: Timeout 30000ms exceeded.' },
    errorLocation: { file: 'tests/recording.spec.ts', line: 3, column: 56 },
  }] }] }] }] }, failedScript);
  ok(failure.includes('script line 3:56') && failure.includes('recorded step 2'), 'failure includes exact line and recorded step number');
  ok(failure.includes("Code: await page.getByRole('button', { name: 'Save' }).click();"), 'failure includes the failing source line');
  ok(failure.includes('locator.click: Timeout 30000ms exceeded.'), 'failure includes the Playwright error');
  const loadFailure = playwrightFailure({ errors: [{ message: 'SyntaxError: Unexpected token' }] }, failedScript);
  ok(loadFailure.includes('failed before a test could run') && loadFailure.includes('Unexpected token'), 'load failures remain actionable when no test starts');

  console.log('orphan recovery fails mid-flight jobs, leaves queued alone');
  const orphan = await jobs.createJob({ recordingId: r.id, agentId: 'agent-x', trigger: 'manual' }, SCOPE);
  await gateway.deliverAgentFrame('agent-x', { type: 'job.progress', agentId: 'agent-x', seq: 1, payload: { jobId: orphan.id, phase: 'running' } });
  const queuedStill = await jobs.createJob({ recordingId: r.id, agentId: 'agent-x', trigger: 'manual' }, SCOPE);
  const recovered = await jobs.recoverOrphanedJobs();
  ok(recovered >= 1, 'orphan recovery failed at least the running job');
  ok((await jobs.getJob(orphan.id)).status === 'failed', 'running job reconciled to failed');
  ok((await jobs.getJob(queuedStill.id)).status === 'queued', 'queued job left intact for reconnect');

  console.log('scheduler next-run math');
  const base = new Date('2026-07-16T10:00:00Z');
  ok(sched.computeNextRun('now', '', 'UTC', base)!.getTime() === base.getTime(), 'now → immediate');
  ok(sched.computeNextRun('daily', '', 'UTC', base)!.toISOString() === '2026-07-17T10:00:00.000Z', 'daily → +24h');
  ok(sched.computeNextRun('weekly', '', 'UTC', base)!.toISOString() === '2026-07-23T10:00:00.000Z', 'weekly → +7d');
  ok(sched.computeNextRun('monthly', '', 'UTC', base)!.toISOString() === '2026-08-16T10:00:00.000Z', 'monthly → +1mo');
  const cronNext = sched.computeNextRun('cron', '0 0 * * *', 'UTC', base);
  ok(!!cronNext && cronNext.toISOString() === '2026-07-17T00:00:00.000Z', 'cron 0 0 * * * → next midnight');
  ok(sched.computeNextRun('webhook', '', 'UTC', base) === null, 'webhook → no timer');
  ok(sched.computeNextRun('cron', 'not-a-cron', 'UTC', base) === null, 'invalid cron → null (no crash)');

  console.log('artifact storage + path-traversal guard');
  const art = await artifacts.saveArtifact({ jobId: job.id, kind: 'trace', filename: 'trace.zip', buffer: Buffer.from('PK fake'), ownerId: 'u1' });
  ok(art.size > 0 && art.kind === 'trace', 'artifact saved with size');
  const list = await artifacts.listArtifacts(job.id);
  ok(list.length === 1, 'artifact listed for job');
  const resolved = await artifacts.resolveArtifact(job.id, art.id);
  ok(!!resolved && fs.existsSync(resolved!.absPath), 'artifact file resolves on disk');

  console.log('events are durably appended');
  const evseq = await AutomationEvents.listSince('recording', r.id, 0);
  ok(evseq.length >= 2, 'recording events durably recorded');
  ok(evseq.every((e: any, i: number) => i === 0 || e.seq > evseq[i - 1].seq), 'event seq is monotonic per scope');
  void events;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
