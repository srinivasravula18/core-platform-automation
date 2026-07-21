/**
 * Phase 2 verification: when an automation job finishes, the linked Test Run (matched by
 * trigger_meta.automationJobId) mirrors the job's real pass/fail/duration.
 * Run isolated: DISABLE_POSTGRES=true tsx scripts/test-automation-run-sync.ts   (from a scratch cwd)
 */
import assert from 'node:assert';
import { syncLinkedRun } from '../server/features/automation/jobService';
import { Runs } from '../server/db/repository';

async function main() {
  const jobId = 'JOB-TEST-1';
  await Runs.upsert({
    id: 'RUN-TEST-1', name: 'Login flow', caseIds: ['TC-XXXX'], status: 'Running',
    triggerType: 'automation', triggerMeta: { automationJobId: jobId, agentId: 'a1' },
    ownerId: 'u1',
  });

  // Passing run.
  await syncLinkedRun(jobId, 'done', { passed: 2, failed: 1, skipped: 0, durationMs: 5000 });
  let run = await Runs.get('RUN-TEST-1');
  assert.strictEqual(run.status, 'Completed', 'done → Completed');
  assert.strictEqual(run.passed, 2, 'passed mirrored');
  assert.strictEqual(run.failed, 1, 'failed mirrored');
  assert.strictEqual(run.totalExecutions, 3, 'total = passed+failed+skipped');
  assert.strictEqual(run.executionTime, '5s', 'duration mirrored');

  // Failing run.
  await syncLinkedRun(jobId, 'failed', { passed: 0, failed: 3 });
  run = await Runs.get('RUN-TEST-1');
  assert.strictEqual(run.status, 'Failed', 'failed → Failed');

  // Unknown job id must be a no-op (no throw, no stray run created).
  const before = (await Runs.list()).length;
  await syncLinkedRun('JOB-DOES-NOT-EXIST', 'done', { passed: 1 });
  assert.strictEqual((await Runs.list()).length, before, 'unknown job id is a no-op');

  console.log('PASS: automation job.done syncs the linked Test Run.');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
