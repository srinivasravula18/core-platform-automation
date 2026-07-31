import assert from 'node:assert/strict';
import {
  MANUAL_OUTCOMES,
  isManualOutcome,
  rollupCaseOutcome,
  computeRunRollup,
} from '../core/shared/manualRun';
import { collectManualResultEvidence } from '../core/shared/runEvidence';

// ----- outcome vocabulary -----
assert.ok(isManualOutcome('Passed'));
assert.ok(isManualOutcome('Blocked'));
assert.ok(!isManualOutcome('Bogus'));
assert.ok(!isManualOutcome(''));
assert.equal(MANUAL_OUTCOMES[0], 'Not Run');

// ----- case-level roll-up (worst-wins; N/A ignored) -----
assert.equal(rollupCaseOutcome([]), 'Not Run');
assert.equal(rollupCaseOutcome([{ outcome: 'Not Run' }, { outcome: 'Not Run' }]), 'Not Run');
assert.equal(rollupCaseOutcome([{ outcome: 'Passed' }, { outcome: 'Passed' }]), 'Passed');
assert.equal(rollupCaseOutcome([{ outcome: 'Passed' }, { outcome: 'Failed' }]), 'Failed');
assert.equal(rollupCaseOutcome([{ outcome: 'Passed' }, { outcome: 'Blocked' }]), 'Blocked');
assert.equal(rollupCaseOutcome([{ outcome: 'Passed' }, { outcome: 'Retest' }]), 'Retest');
assert.equal(rollupCaseOutcome([{ outcome: 'Passed' }, { outcome: 'Not Applicable' }]), 'Passed');
assert.equal(rollupCaseOutcome([{ outcome: 'Not Applicable' }, { outcome: 'Not Applicable' }]), 'Not Applicable');
assert.equal(rollupCaseOutcome([{ outcome: 'Passed' }, { outcome: 'Not Run' }]), 'Paused', 'partially executed → Paused');
// Failed dominates Blocked/Retest regardless of order.
assert.equal(rollupCaseOutcome([{ outcome: 'Blocked' }, { outcome: 'Failed' }, { outcome: 'Retest' }]), 'Failed');

// ----- run-level roll-up -----
assert.deepEqual(computeRunRollup([]), { passed: 0, failed: 0, totalExecutions: 0, status: 'Not Started', state: 'Not Started', progress: '0/0 evaluated' });
{
  const r = computeRunRollup([{ outcome: 'Not Run' }, { outcome: 'Not Run' }]);
  assert.equal(r.status, 'Not Started');
  assert.equal(r.progress, '0/2 evaluated');
}
{
  const r = computeRunRollup([{ outcome: 'Passed' }, { outcome: 'Not Run' }]);
  assert.equal(r.status, 'In Progress');
  assert.equal(r.state, 'In Progress');
  assert.equal(r.passed, 1);
  assert.equal(r.progress, '1/2 evaluated');
}
{
  const r = computeRunRollup([{ outcome: 'Passed' }, { outcome: 'Passed' }]);
  assert.equal(r.status, 'Passed');
  assert.equal(r.state, 'Completed');
  assert.equal(r.passed, 2);
}
{
  const r = computeRunRollup([{ outcome: 'Passed' }, { outcome: 'Failed' }]);
  assert.equal(r.status, 'Failed');
  assert.equal(r.failed, 1);
}
{
  // all cases evaluated, some blocked but none failed → Blocked
  const r = computeRunRollup([{ outcome: 'Passed' }, { outcome: 'Blocked' }]);
  assert.equal(r.status, 'Blocked');
}

// ----- manual evidence collection -----
const evidence = collectManualResultEvidence([
  { caseId: 'TC-1', caseTitle: 'Login', stepResults: [
    { action: 'open', outcome: 'Passed', screenshots: ['/evidence/a.png'] },
    { action: 'submit', outcome: 'Failed', screenshots: ['/evidence/b.png', '/evidence/b.png'] },
  ] },
  { caseId: 'TC-2', caseTitle: 'Logout', stepResults: [{ action: 'click', outcome: 'Passed', screenshots: [] }] },
]);
assert.equal(evidence.length, 2, 'dedupes duplicate urls');
assert.deepEqual(evidence.map((e) => e.url), ['/evidence/a.png', '/evidence/b.png']);
assert.equal(evidence[0].caseId, 'TC-1');
assert.equal(evidence[1].stepLabel, 'Step 2');

// ----- RunCaseResults repo (JSON mode, no PG) -----
async function repoChecks() {
  delete process.env.DATABASE_URL;
  delete process.env.PGHOST;
  const { RunCaseResults } = await import('../server/db/repository');
  await RunCaseResults.upsert({ runId: 'RUN-X', caseId: 'TC-1', caseTitle: 'Login', outcome: 'Not Run', stepResults: [{ action: 'a', outcome: 'Not Run' }] });
  await RunCaseResults.upsert({ runId: 'RUN-X', caseId: 'TC-2', caseTitle: 'Logout', outcome: 'Not Run', stepResults: [] });
  let list = await RunCaseResults.listForRun('RUN-X');
  assert.equal(list.length, 2, 'two seeded results');
  // upsert is idempotent per (run, case)
  await RunCaseResults.upsert({ runId: 'RUN-X', caseId: 'TC-1', outcome: 'Passed' });
  list = await RunCaseResults.listForRun('RUN-X');
  assert.equal(list.length, 2, 'still two rows after re-upsert');
  const tc1 = await RunCaseResults.get('RUN-X', 'TC-1');
  assert.equal(tc1.outcome, 'Passed');
  await RunCaseResults.removeForRun('RUN-X');
  assert.equal((await RunCaseResults.listForRun('RUN-X')).length, 0, 'cleared');
}

repoChecks()
  .then(() => console.log('manual runner checks passed'))
  .catch((err) => { console.error(err); process.exit(1); });
