import assert from 'node:assert/strict';
import {
  normalizeTagQuery,
  isEmptyTagQuery,
  matchesTagQuery,
  resolveTagQuery,
  computeDrift,
  readGroupDefinition,
} from '../server/features/resources/tagComposition';

// ----- normalize: strips @/#, lowercases, dedups, drops empties -----
const nq = normalizeTagQuery({ all: ['@Sanity', 'sanity', ''], any: ['#Module:Billing'], not: null });
assert.deepEqual(nq.all, ['sanity']);
assert.deepEqual(nq.any, ['module:billing']);
assert.deepEqual(nq.not, []);

// ----- empty query matches nothing (composition must be explicit) -----
assert.ok(isEmptyTagQuery({}));
assert.ok(isEmptyTagQuery(normalizeTagQuery({})));
assert.ok(!matchesTagQuery(['@sanity'], {}), 'empty query never matches');
assert.deepEqual(resolveTagQuery([{ tags: ['@sanity'] }], {}), []);

// ----- all / any / not semantics (marker + case insensitive) -----
const q = normalizeTagQuery({ all: ['sanity'], any: ['module:billing', 'module:auth'], not: ['wip'] });
assert.ok(matchesTagQuery(['@Sanity', '@module:billing'], q), 'all + one any, no not');
assert.ok(!matchesTagQuery(['@module:billing'], q), 'missing required all tag');
assert.ok(!matchesTagQuery(['@sanity'], q), 'has all but no any match');
assert.ok(!matchesTagQuery(['@sanity', '@module:auth', '@wip'], q), 'excluded by not');

// ----- resolveTagQuery filters a list -----
const cases = [
  { id: 'C1', tags: ['@sanity', '@module:billing'] },
  { id: 'C2', tags: ['@sanity', '@module:auth'] },
  { id: 'C3', tags: ['@sanity', '@module:auth', '@wip'] }, // excluded by not
  { id: 'C4', tags: ['@module:billing'] },                 // missing sanity
];
assert.deepEqual(resolveTagQuery(cases, q).map((c) => c.id), ['C1', 'C2']);

// ----- drift: new = matched − accepted − dismissed; stale = accepted − matched -----
const d = computeDrift({ matchedIds: ['C1', 'C2', 'C5'], acceptedIds: ['C1', 'C9'], dismissedIds: ['C5'] });
assert.deepEqual(d.newMatchIds.sort(), ['C2'], 'C5 dismissed, C1 accepted → only C2 is new');
assert.deepEqual(d.staleIds.sort(), ['C9'], 'C9 accepted but no longer matches');

// dismissing everything new → no notification
const none = computeDrift({ matchedIds: ['C1', 'C2'], acceptedIds: ['C1'], dismissedIds: ['C2'] });
assert.deepEqual(none.newMatchIds, []);

// ----- readGroupDefinition normalizes stored shape + defaults -----
assert.deepEqual(readGroupDefinition({}).tagQuery, { all: [], any: [], not: [] });
assert.deepEqual(readGroupDefinition({ definition: { dismissed: ['C5'] } }).dismissed, ['C5']);
const rd = readGroupDefinition({ definition: { tagQuery: { all: ['@Sanity'] } } });
assert.deepEqual(rd.tagQuery.all, ['sanity']);

console.log('tag-composition: all assertions passed');
