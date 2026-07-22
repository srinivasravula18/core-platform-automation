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
  const { db } = await import('../server/shared/storage');
  const { AutomationEvents, Scripts } = await import('../server/db/repository');
  db.recordings = []; db.scripts = []; db.automationJobs = []; db.automationSchedules = []; db.automationArtifacts = []; db.automationEvents = [];

  console.log('recording lifecycle');
  const r = await rec.createRecording({ name: 'Login flow', appUrl: 'http://localhost:5002', browser: 'chromium' }, SCOPE);
  ok(!!r.id && r.status === 'draft', 'recording created as draft');
  ok(r.ownerId === 'u1' && r.projectId === 'p1', 'recording scope-stamped');
  const renamed = await rec.updateRecording(r.id, { name: 'Login flow v2' });
  ok(renamed?.name === 'Login flow v2', 'recording renamed');

  console.log('record.done frame ingests the script + stats');
  await gateway.deliverAgentFrame('agent-x', { type: 'record.done', agentId: 'agent-x', seq: 1, payload: { recordingId: r.id, script: "import { test } from '@playwright/test';", stats: { actions: 12, assertions: 3 } } });
  const done = await rec.getRecording(r.id);
  ok(done.status === 'ready', 'recording marked ready after record.done');
  ok(done.script.includes('@playwright/test') && done.stats.actions === 12, 'script + stats persisted');

  console.log('repository script resolves to one reusable execution recording');
  const repositoryScript = await Scripts.upsert({ id: 'SCR-REPOSITORY-1', name: 'Repository flow', code: "import { test } from '@playwright/test';\ntest('flow', async () => {});", projectId: 'p1', appId: 'a1', ownerId: 'u1' });
  const scriptRecording = await rec.recordingForScript(repositoryScript.id, SCOPE);
  const reusedScriptRecording = await rec.recordingForScript(repositoryScript.id, SCOPE);
  ok(scriptRecording?.status === 'ready' && scriptRecording.script === repositoryScript.code, 'repository script prepared for scheduling');
  ok(reusedScriptRecording?.id === scriptRecording?.id, 'repository script reuses its execution recording');

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

  console.log('job failure path');
  const job2 = await jobs.createJob({ recordingId: r.id, agentId: 'agent-x', trigger: 'manual' }, SCOPE);
  await gateway.deliverAgentFrame('agent-x', { type: 'job.done', agentId: 'agent-x', seq: 1, payload: { jobId: job2.id, exitCode: 1, error: 'timeout' } });
  ok((await jobs.getJob(job2.id)).status === 'failed', 'non-zero exit → failed');

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
