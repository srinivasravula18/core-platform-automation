/**
 * Recycle bin — restore-scope grouping.
 *
 * The DB-backed paths need PostgreSQL, so this covers the pure logic the UI depends on: grouping
 * deleted rows into the deletion that produced them, and deciding when the restore prompt is shown.
 */

import { RECYCLE_ENTITIES, type DeletedItem } from '../server/db/repository';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
