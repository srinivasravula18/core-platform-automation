import assert from 'node:assert/strict';
import test from 'node:test';
import { buildParamSchema, profileById } from '../../server/features/vitals/testing/profiles';

test('local Vitals profiles reject unknown and out-of-bounds parameters', () => {
  const load = profileById('load-steady');
  assert.ok(load);
  assert.equal(buildParamSchema(load).safeParse({ vus: 0 }).success, false);
  assert.equal(buildParamSchema(load).safeParse({ vus: 5, unexpected: true }).success, false);
  assert.equal(buildParamSchema(load).safeParse({ vus: 5, duration: '30s' }).success, true);

  const activeScan = profileById('security-active');
  assert.ok(activeScan);
  assert.equal(buildParamSchema(activeScan).safeParse({ authorized: true, minutes: 61 }).success, false);
});
