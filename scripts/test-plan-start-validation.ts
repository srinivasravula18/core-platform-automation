import assert from 'node:assert/strict';
import { normalizeDateKey, planDateWarnings, planStartConflict } from '../core/shared/testPlanStart';

const today = '2026-07-27';

assert.equal(planStartConflict({}, today), 'missing-dates');
assert.equal(planStartConflict({ endDate: '2026-07-28' }, today), 'missing-dates');
assert.equal(planStartConflict({ startDate: today, endDate: '2026-07-28' }, today), null);
assert.equal(planStartConflict({ startDate: '2026-07-28', endDate: '2026-08-01' }, today), 'future-start');
assert.equal(planStartConflict({ startDate: '2026-07-01', endDate: '2026-07-26' }, today), 'past-end');
assert.equal(planStartConflict({ startDate: '2026-07-28', endDate: '2026-07-27' }, today), 'invalid-range');
assert.deepEqual(planDateWarnings({ startDate: '2026-07-28', endDate: '2026-07-26' }, today), ['future-start', 'past-end']);
assert.deepEqual(planDateWarnings({ startDate: today, endDate: '2026-07-28' }, today), []);
assert.equal(normalizeDateKey('2026-07-27T00:00:00.000Z'), today);
assert.equal(normalizeDateKey(new Date(2026, 6, 27)), today);

console.log('test-plan start validation: ok');
