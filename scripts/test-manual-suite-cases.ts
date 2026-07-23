import assert from 'node:assert/strict';
import {
  caseSuiteAssignment,
  orderSuitesByHierarchy,
  relatedCasesForSuite,
  suiteHierarchyDepth,
  suiteModuleName,
  suitePlanIds,
} from '../src/lib/suiteCaseSelection';

const cases = [
  { id: 'TC-1', folderId: 'F-1', testSuiteId: 'PARENT-1' },
  { id: 'TC-2', folderId: 'F-1', testSuiteIds: ['PARENT-2'] },
  { id: 'TC-3', folderId: 'F-2', testSuiteId: 'PARENT-1' },
];

assert.deepEqual(relatedCasesForSuite(cases, 'F-1', 'PARENT-1').map((item) => item.id), ['TC-1', 'TC-3']);
assert.deepEqual(relatedCasesForSuite(cases, 'F-1', '').map((item) => item.id), ['TC-1', 'TC-2']);
assert.deepEqual(caseSuiteAssignment(cases[0], 'SUITE-NEW'), {
  testSuiteId: 'SUITE-NEW',
  testSuiteIds: ['PARENT-1', 'SUITE-NEW'],
  folderId: 'F-1',
});
assert.equal(suiteModuleName({ module: 'QA Assistant', folderId: 'F-1' }, [{ id: 'F-1', name: 'App Creation' }]), 'App Creation');
assert.equal(suiteModuleName({ module: 'Payments', folderId: 'F-1' }, [{ id: 'F-1', name: 'App Creation' }]), 'Payments');
const suites = [
  { id: 'CHILD', name: 'Child', parentSuite: 'PARENT' },
  { id: 'GRANDCHILD', name: 'Grandchild', parentSuite: 'CHILD' },
  { id: 'PARENT', name: 'Parent' },
  { id: 'ROOT-2', name: 'Second root' },
];
assert.deepEqual(orderSuitesByHierarchy(suites).map((suite) => suite.id), ['PARENT', 'CHILD', 'GRANDCHILD', 'ROOT-2']);
assert.equal(suiteHierarchyDepth(suites[1], suites), 2);
assert.deepEqual(suitePlanIds({ testPlanId: 'PLAN-1' }), ['PLAN-1']);
assert.deepEqual(suitePlanIds({ testPlanId: 'PLAN-1', testPlanIds: ['PLAN-1', 'PLAN-2'] }), ['PLAN-1', 'PLAN-2']);
console.log('manual suite case selection: ok');
