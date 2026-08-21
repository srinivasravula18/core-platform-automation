import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolLoopGuard } from '../../server/ai/agent-runtime/tool-loop-guard';
import { allowsTargetMutation } from '../../server/ai/agent-runtime/policy';

test('stops an identical tool request on its third attempt', () => {
  const guard = createToolLoopGuard();
  assert.equal(guard.before('read_target', { id: '1' }), undefined);
  assert.equal(guard.before('read_target', { id: '1' }), undefined);
  assert.match(guard.before('read_target', { id: '1' }) || '', /three times/i);
});

test('resets consecutive failures after a successful tool call', () => {
  const guard = createToolLoopGuard();
  for (let i = 0; i < 4; i++) assert.equal(guard.after(true), undefined);
  assert.equal(guard.after(false), undefined);
  for (let i = 0; i < 4; i++) assert.equal(guard.after(true), undefined);
  assert.match(guard.after(true) || '', /five consecutive/i);
});

test('target mutation policy excludes destructive and control routes', () => {
  assert.equal(allowsTargetMutation('POST', '/api/items'), true);
  assert.equal(allowsTargetMutation('DELETE', '/api/items/1'), false);
  assert.equal(allowsTargetMutation('POST', '/api/auth/login'), false);
});
