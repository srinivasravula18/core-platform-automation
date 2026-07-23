import assert from 'node:assert/strict';
import { caseSuiteAssignment, relatedCasesForSuite } from '../src/lib/suiteCaseSelection';

const cases = [
  { id: 'TC-1', folderId: 'F-1', testSuiteId: 'PARENT-1' },
  { id: 'TC-2', folderId: 'F-1', testSuiteIds: ['PARENT-2'] },
  { id: 'TC-3', folderId: 'F-2', testSuiteId: 'PARENT-1' },
];

assert.deepEqual(relatedCasesForSuite(cases, 'F-1', 'PARENT-1').map((item) => item.id), ['TC-1']);
assert.deepEqual(relatedCasesForSuite(cases, 'F-1', '').map((item) => item.id), ['TC-1', 'TC-2']);
assert.deepEqual(caseSuiteAssignment(cases[0], 'SUITE-NEW'), {
  testSuiteId: 'SUITE-NEW',
  testSuiteIds: ['PARENT-1', 'SUITE-NEW'],
  folderId: 'F-1',
});
console.log('manual suite case selection: ok');
