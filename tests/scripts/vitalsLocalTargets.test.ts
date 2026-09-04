import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedTarget, sandboxTargets } from '../../server/features/vitals/testing/targetPolicy';

test('local Vitals targets normalize URLs and label a running sandbox as pentest-eligible', () => {
  assert.equal(isAllowedTarget('http://127.0.0.1:4100/', ['http://127.0.0.1:4100']), true);
  assert.equal(isAllowedTarget('http://127.0.0.1:4101', ['http://127.0.0.1:4100']), false);
  assert.deepEqual(sandboxTargets([{ name: 'CRM sandbox', hostname: 'host', server: 'host', service_port: 4100 }], 'host'), [
    { url: 'http://127.0.0.1:4100', label: 'CRM sandbox', source: 'sandbox', pentestAllowed: true },
  ]);
});
