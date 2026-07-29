import assert from 'node:assert/strict';
import { buildTestPlanHierarchy } from '../src/lib/testPlanHierarchy';

const plans = [
  { id: 'PLAN-1', name: 'Parent' },
  { id: 'PLAN-2', name: 'Sibling' },
  { id: 'PLAN-1-1', name: 'Child', parentPlanId: 'PLAN-1' },
  { id: 'PLAN-1-1-1', name: 'Grandchild', parentPlanId: 'PLAN-1-1' },
];

const expanded = buildTestPlanHierarchy(plans);
assert.deepEqual(expanded.map(({ plan, depth }) => [plan.id, depth]), [
  ['PLAN-1', 0],
  ['PLAN-1-1', 1],
  ['PLAN-1-1-1', 2],
  ['PLAN-2', 0],
]);
assert.equal(expanded[0].hasChildren, true);
assert.deepEqual(buildTestPlanHierarchy(plans, new Set(['PLAN-1'])).map(({ plan }) => plan.id), ['PLAN-1', 'PLAN-2']);

const cyclic = [
  { id: 'A', parentPlanId: 'B' },
  { id: 'B', parentPlanId: 'A' },
];
assert.deepEqual(buildTestPlanHierarchy(cyclic).map(({ plan }) => plan.id).sort(), ['A', 'B']);

console.log('test plan hierarchy: ok');
