import assert from 'node:assert/strict';
import { casesForPlan, casesForRun, executionRunUpdate, manualRunSelection, scriptsForCases, scriptsForRun } from '../src/lib/manualTestRun';

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
assert.deepEqual(manualRunSelection('P1', []), { planIds: ['P1'], caseIds: [] });
assert.deepEqual(casesForRun({ planIds: ['P1'] }, cases, suites).map(({ id }) => id), ['C1', 'C2']);
assert.deepEqual(scriptsForRun({ agentRunId: 'A1' }, [], [{ id: 'X1', agentRunId: 'A1', code: 'one' }]).map(({ id }) => id), ['X1']);
assert.deepEqual(
  executionRunUpdate({ ok: true, total: 1, passed: 1, tests: [{ title: 'First', status: 'passed' }] }).steps[0].outcome,
  'Passed',
);
console.log('PASS: manual runs use current plan cases, linked scripts, and real execution outcomes.');
