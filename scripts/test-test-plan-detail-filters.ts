import assert from 'node:assert/strict';
import { emptyTestPlanCaseFilters, matchesTestPlanCaseFilters, resultStatusesForTestCase } from '../src/lib/testPlanDetailFilters';

const testCase = {
  id: 'CASE-1',
  folderId: '',
  testPlanIds: ['PLAN-1', 'PLAN-CHILD'],
  testSuiteIds: ['SUITE-1'],
  status: 'Active',
  priority: 'High',
};
const suites = [{ id: 'SUITE-1', folderId: 'FOLDER-1' }];
const runs = [{ id: 'RUN-1', testPlanId: 'PLAN-1', caseIds: ['CASE-1'], testResults: [{ caseId: 'CASE-1', status: 'Failed' }] }];

assert.deepEqual(resultStatusesForTestCase(testCase, runs, 'PLAN-1'), ['Failed']);
for (const filters of [
  { folderIds: ['FOLDER-1'] },
  { runIds: ['RUN-1'] },
  { suiteIds: ['SUITE-1'] },
  { subPlanIds: ['PLAN-CHILD'] },
  { resultStatuses: ['Failed'] },
  { states: ['Active'] },
  { priorities: ['High'] },
]) {
  assert.equal(matchesTestPlanCaseFilters(testCase, 'PLAN-1', runs, suites, { ...emptyTestPlanCaseFilters(), ...filters }), true);
}
assert.equal(matchesTestPlanCaseFilters(testCase, 'PLAN-1', runs, suites, {
  ...emptyTestPlanCaseFilters(),
  resultStatuses: ['Passed'],
}), false);

console.log('test plan detail filters: ok');
