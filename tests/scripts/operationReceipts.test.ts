import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginOperationReceipt,
  buildOperationIdentity,
  clearOperationReceiptsForTests,
  completeOperationReceipt,
} from '../../server/ai/agent-runtime/operationReceipts';

const base = {
  ctx: { workspaceId: 'workspace-a', userId: 'user-a', role: 'admin', projectId: 'project-a', appId: 'app-a', userMessage: 'Create the account' },
  operationId: 'createAccount', method: 'POST', targetType: '/accounts', pathParams: {}, query: {}, body: { name: 'Acme', accountNumber: 'A-1' },
};

test('identical create/update payloads share one idempotency receipt inside a scope', async () => {
  const previous = process.env.DISABLE_POSTGRES;
  process.env.DISABLE_POSTGRES = 'true';
  clearOperationReceiptsForTests();
  try {
    const first = await beginOperationReceipt(base);
    assert.equal(first.acquired, true);
    const receipt = await completeOperationReceipt(first.receipt.idempotencyKey, { id: 'account-1' }, { item: { id: 'account-1', name: 'Acme' } });
    assert.equal(receipt.resourceId, 'account-1');
    const repeated = await beginOperationReceipt(base);
    assert.equal(repeated.acquired, false);
    assert.equal(repeated.receipt.status, 'completed');
    assert.equal(repeated.receipt.resourceId, 'account-1');
  } finally {
    if (previous === undefined) delete process.env.DISABLE_POSTGRES;
    else process.env.DISABLE_POSTGRES = previous;
  }
});

test('scope changes isolate receipts and explicit another requests use the turn id', () => {
  assert.notEqual(buildOperationIdentity(base).idempotencyKey, buildOperationIdentity({ ...base, ctx: { ...base.ctx, userId: 'user-b' } }).idempotencyKey);
  const repeat = { ...base, ctx: { ...base.ctx, userMessage: 'Create another account', requestId: 'turn-a' } };
  assert.notEqual(buildOperationIdentity(repeat).idempotencyKey, buildOperationIdentity({ ...repeat, ctx: { ...repeat.ctx, requestId: 'turn-b' } }).idempotencyKey);
  assert.equal(buildOperationIdentity(repeat).idempotencyKey, buildOperationIdentity(repeat).idempotencyKey);
});

