import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesTagQuery, resolveTagQuery } from '../../core/shared/tagQuery';

test('tag queries normalize markers and case across client and server callers', () => {
  const items = [{ id: 'a', tags: ['@Smoke', '#Checkout'] }, { id: 'b', tags: ['slow'] }];
  assert.equal(matchesTagQuery(items[0].tags, { all: ['smoke'], any: ['checkout'], not: ['slow'] }), true);
  assert.deepEqual(resolveTagQuery(items, { any: ['#SMOKE'] }).map((item) => item.id), ['a']);
  assert.deepEqual(resolveTagQuery(items, {}), []);
});
