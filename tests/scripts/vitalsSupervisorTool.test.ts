import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSupervisorTools } from '../../server/ai/supervisor';

test('main Agent Console exposes the read-only Vitals tool', () => {
  const tool = buildSupervisorTools({ role: 'viewer' }).find((entry) => entry.spec.name === 'query_vitals');
  assert.ok(tool);
  assert.deepEqual((tool.spec.parameters.properties as Record<string, { enum?: string[] }>).scopeKind.enum, ['all', 'server', 'sandbox']);
});
