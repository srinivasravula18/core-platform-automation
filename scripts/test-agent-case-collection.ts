import assert from 'node:assert/strict';
import { reviewedCasesForRun, syncReviewedCases } from '../server/features/agent/caseCollection';

const run: any = {
  generated_cases: [{ id: 'TC-9' }],
  all_generated_cases: [{ id: 'TC-1' }, { id: 'TC-9' }],
};

assert.deepEqual(reviewedCasesForRun(run).map((testCase) => testCase.id), ['TC-1', 'TC-9']);
syncReviewedCases(run, [{ id: 'TC-1' }, { id: 'TC-2' }]);
assert.deepEqual(run.generated_cases, run.all_generated_cases);
assert.equal(reviewedCasesForRun(run).length, 2);
console.log('agent case collection checks passed');
