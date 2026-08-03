import assert from 'node:assert/strict';
import { casesForPlan, casesForRun, getRunStats, manualRunSelection, runExecutionState, runnableCases, scriptsForCases, scriptsForRun } from '../src/lib/manualTestRun';
import { agentRunStatusForList, isActiveTestRun, isClosedTestRun, isPendingReviewTestRun, isStaleManualTestRun } from '../core/shared/testRunStatus';

const suites = [
  { id: 'S1', testPlanId: 'P1' },
  { id: 'S2', parentSuite: 'S1' },
  { id: 'S3', testPlanId: 'P2' },
];
const cases = [
  { id: 'C1', title: 'First', testSuiteId: 'S1', agentRunId: 'A1' },
  { id: 'C2', title: 'Second', testSuiteId: 'S2', agentRunId: 'A1' },
  { id: 'C3', title: 'Other', testSuiteId: 'S3' },
];
assert.deepEqual(casesForPlan(cases, suites, 'P1').map(({ id }) => id), ['C1', 'C2']);
assert.deepEqual(scriptsForCases(cases.slice(0, 2), [
  { id: 'X1', caseId: 'C1', code: 'one' },
  { id: 'X2', agentRunId: 'A1', title: 'Second', code: 'two' },
]).map(({ id }) => id), ['X1', 'X2']);
assert.deepEqual(manualRunSelection('P1', ['C1']), { planIds: [], caseIds: ['C1'] });
assert.deepEqual(manualRunSelection('', ['C1', 'C3']), { planIds: [], caseIds: ['C1', 'C3'] });
assert.deepEqual(manualRunSelection('P1', []), { planIds: ['P1'], caseIds: [] });
assert.deepEqual(casesForRun({ planIds: ['P1'] }, cases, suites).map(({ id }) => id), ['C1', 'C2']);
assert.deepEqual(casesForRun({ caseIds: ['C3'] }, cases, suites).map(({ id }) => id), ['C3']);
assert.deepEqual(casesForRun({ id: 'R1', caseIds: ['C3'] }, cases, suites, [{ id: 'P1', runIds: ['R1'] }]).map(({ id }) => id), ['C1', 'C2', 'C3']);
assert.deepEqual(scriptsForRun({ agentRunId: 'A1' }, [], [{ id: 'X1', agentRunId: 'A1', code: 'one' }]).map(({ id }) => id), ['X1']);
assert.deepEqual(runnableCases(
  [{ id: 'C1', folderId: 'F1' }, { id: 'C2', folderId: 'F1' }, { id: 'C3', folderId: 'F2' }],
  [{ id: 'X1', caseId: 'C1', code: 'one' }],
).map(({ id }) => id), ['C1']);
assert.deepEqual(runExecutionState({
  status: 'Running',
  progress: 'Completed 2/4 scripts',
  triggerMeta: { manualExecution: { completed: 2, total: 4 } },
}), {
  running: true,
  total: 4,
  completed: 2,
  percent: 50,
  label: 'Completed 2/4 scripts',
});
assert.equal(runExecutionState({ status: 'In Progress' }).running, true);
assert.deepEqual(
  getRunStats({ totalExecutions: 1, passed: 1, failed: 0, steps: [{ outcome: 'Failed' }] }),
  { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0, retest: 0, untested: 0, completed: 100 },
  'explicit zero counters replace stale outcomes after a successful rerun',
);
assert.equal(isActiveTestRun({ status: 'In Progress' }), true);
assert.equal(isActiveTestRun({ status: 'Review Required' }), true);
assert.equal(agentRunStatusForList('completed'), 'Completed — Pending Review');
assert.equal(isPendingReviewTestRun({ status: agentRunStatusForList('completed') }), true);
assert.equal(isActiveTestRun({ status: agentRunStatusForList('completed') }), true);
assert.equal(agentRunStatusForList('failed'), 'Failed — Pending Review');
assert.equal(isActiveTestRun({ status: agentRunStatusForList('failed') }), true);
assert.equal(isClosedTestRun({ status: 'Completed' }), true);
assert.equal(isClosedTestRun({ status: 'Closed' }), true);
assert.equal(isClosedTestRun({ status: 'Failed' }), true);
assert.equal(isStaleManualTestRun({
  status: 'Running',
  triggerMeta: { manualExecution: { attemptId: 'attempt-1', heartbeatAt: '2026-01-01T00:00:00.000Z' } },
}, Date.parse('2026-01-01T00:16:00.000Z')), true);
assert.equal(isStaleManualTestRun({
  status: 'Running',
  triggerMeta: { automationJobId: 'job-1' },
}, Date.parse('2026-01-01T00:16:00.000Z')), false);
console.log('PASS: manual runs use current plan cases, linked scripts, and real execution outcomes.');
