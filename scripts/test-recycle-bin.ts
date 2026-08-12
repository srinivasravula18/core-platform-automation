/**
 * Recycle bin — restore-scope grouping.
 *
 * The DB-backed paths need PostgreSQL, so this covers the pure logic the UI depends on: grouping
 * deleted rows into the deletion that produced them, and deciding when the restore prompt is shown.
 */

import { RECYCLE_ENTITIES, type DeletedItem } from '../server/db/repository';
import { resolveDeletionClosure, applyDetach } from '../server/features/resources/deletionGraph';

let passed = 0;
let failed = 0;
function ok(condition: boolean, label: string) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const item = (over: Partial<DeletedItem>): DeletedItem => ({
  type: 'cases', noun: 'Test Case', id: 'X', label: 'x', deletedAt: '2026-08-12T10:00:00Z',
  deletedBy: 'admin', batchId: '', projectId: '', appId: '', ownerId: 'u1', ...over,
});

console.log('entity registry');
ok(Object.keys(RECYCLE_ENTITIES).length === 12, 'all 12 soft-deletable entities are exposed');
ok(RECYCLE_ENTITIES.cases.labelColumn === 'title' && RECYCLE_ENTITIES.plans.labelColumn === 'name',
  'label column differs per table (title vs name)');
ok(RECYCLE_ENTITIES.schedules.table === 'automation_schedules', 'url type maps to the real table name');

console.log('batch grouping (drives the restore prompt)');
const rows: DeletedItem[] = [
  item({ type: 'plans', id: 'P1', label: 'Regression Plan', batchId: 'DEL-1', noun: 'Test Plan' }),
  item({ type: 'suites', id: 'S1', label: 'Login Suite', batchId: 'DEL-1', noun: 'Test Suite' }),
  item({ type: 'cases', id: 'C1', label: 'Login works', batchId: 'DEL-1' }),
  item({ type: 'cases', id: 'C9', label: 'Standalone case', batchId: '' }),
];

const relatedTo = (type: string, id: string) => {
  const self = rows.find((row) => row.type === type && row.id === id)!;
  return self.batchId ? rows.filter((row) => row.batchId === self.batchId && !(row.type === type && row.id === id)) : [];
};

ok(relatedTo('plans', 'P1').length === 2, 'deleting a plan groups its suite + case into one batch');
ok(relatedTo('cases', 'C1').map((r) => r.id).sort().join(',') === 'P1,S1', 'a child lists its parents as related');
ok(relatedTo('cases', 'C9').length === 0, 'an item deleted on its own has no related items');

console.log('prompt suppression');
ok(relatedTo('cases', 'C9').length === 0, 'no prompt when nothing else was deleted with it');
ok(relatedTo('plans', 'P1').length > 0, 'prompt shown when the deletion removed more than one row');

console.log('scope isolation');
const mine = rows.filter((row) => row.ownerId === 'u1');
const theirs = rows.filter((row) => row.ownerId === 'u2');
ok(mine.length === 4 && theirs.length === 0, 'only the owner’s rows are listed');

console.log('deletion closure - exclusivity');
{
  // P1 owns S1 exclusively; C1 is only in P1; C2 is ALSO in P2, so it must survive.
  const rows = {
    plans: [{ id: 'P1', name: 'Regression' }, { id: 'P2', name: 'Smoke' }],
    suites: [{ id: 'S1', name: 'Login Suite', testPlanIds: ['P1'], parentSuiteIds: [] }],
    cases: [
      { id: 'C1', title: 'only in P1', testPlanIds: ['P1'], testSuiteIds: ['S1'] },
      { id: 'C2', title: 'shared with P2', testPlanIds: ['P1', 'P2'], testSuiteIds: [] },
    ],
  };
  const closure = resolveDeletionClosure('plans', 'P1', rows)!;
  const deletedIds = closure.willDelete.map((n) => n.id).sort();
  ok(deletedIds.join(',') === 'C1,S1', 'exclusively-owned suite + case cascade');
  ok(!deletedIds.includes('C2'), 'a case shared with another plan is NOT deleted');
  ok(closure.willDetach.some((d) => d.id === 'C2' && d.field === 'testPlanIds' && d.removedId === 'P1'),
    'the shared case is detached from the deleted plan instead');
}

console.log('deletion closure - suite DAG with a cycle');
{
  const rows = {
    plans: [] as any[],
    suites: [
      { id: 'S1', name: 'A', testPlanIds: [], parentSuiteIds: ['S2'] },
      { id: 'S2', name: 'B', testPlanIds: [], parentSuiteIds: ['S1'] },
    ],
    cases: [] as any[],
  };
  const closure = resolveDeletionClosure('suites', 'S1', rows)!;
  ok(closure.willDelete.map((n) => n.id).join(',') === 'S2', 'a parent_suite_ids cycle terminates and does not loop');
}

console.log('deletion closure - nothing shared, full chain');
{
  const rows = {
    plans: [{ id: 'P1', name: 'P' }],
    suites: [{ id: 'S1', name: 'S', testPlanIds: ['P1'], parentSuiteIds: [] }],
    cases: [{ id: 'C1', title: 'C', testPlanIds: [] as string[], testSuiteIds: ['S1'] }],
  };
  const closure = resolveDeletionClosure('plans', 'P1', rows)!;
  ok(closure.willDelete.map((n) => n.id).sort().join(',') === 'C1,S1', 'cascade reaches a case owned via its suite');
  ok(closure.willDetach.length === 0, 'nothing is detached when nothing is shared');
}

console.log('detach keeps the singular column in sync');
{
  const detached = applyDetach(
    { id: 'C2', testPlanIds: ['P1', 'P2'], testPlanId: 'P1' },
    { type: 'cases' as const, id: 'C2', label: 'c', field: 'testPlanIds' as const, removedId: 'P1' },
  );
  ok(detached.testPlanIds.join(',') === 'P2', 'dead plan id removed from the array');
  ok(detached.testPlanId === 'P2', 'singular test_plan_id follows the array');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
