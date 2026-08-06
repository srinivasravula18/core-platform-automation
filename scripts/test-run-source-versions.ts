import assert from 'node:assert/strict';
import { runSourceVersionChanges } from '../src/lib/runSourceVersions';

const run = {
  createdAt: '2026-01-01T00:00:00.000Z',
  triggerMeta: { sourceVersions: {
    plans: [{ id: 'P1', name: 'Plan', version: 1, snapshot: { name: 'Plan', status: 'Draft' } }],
    suites: [{ id: 'S1', name: 'Suite', version: 2, snapshot: { name: 'Suite', priority: 'Low' } }],
    cases: [{ id: 'C1', name: 'Case', version: 3, revision: 2, snapshot: { title: 'Case', steps: [{ action: 'Old' }] } }],
  } },
};

const changes = runSourceVersionChanges(run, {
  plans: [{ id: 'P1', name: 'Plan', status: 'Approved', metadata: { version: 2 } }],
  suites: [{ id: 'S1', name: 'Suite', priority: 'Low', metadata: { version: 2 } }],
  cases: [{ id: 'C1', title: 'Case', steps: [{ action: 'New' }], currentRevision: 3, metadata: { version: 4 } }],
});

assert.deepEqual(changes.map((change) => change.kind), ['Plan', 'Case']);
assert.deepEqual(changes[0].fields, ['Status']);
assert.equal(changes[1].versionText, '@v2 → @v3');
assert.deepEqual(changes[1].fields, ['Steps']);
console.log('Run source version checks passed.');
