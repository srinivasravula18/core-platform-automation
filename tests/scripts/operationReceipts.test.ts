import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../server/db/pool';
import {
  beginOperationReceipt,
  beginExternalOperationReceipt,
  buildOperationIdentity,
  clearOperationReceiptsForTests,
  completeOperationReceipt,
  failOperationReceipt,
  restartExternalOperationReceipt,
  setOperationReceiptResource,
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

test('external receipts detect conflicts, attach a run, and retain it on completion', async () => {
  const previous = process.env.DISABLE_POSTGRES;
  process.env.DISABLE_POSTGRES = 'true';
  clearOperationReceiptsForTests();
  try {
    const first = await beginExternalOperationReceipt({ namespace: 'gylin', externalKey: 'story:sha', operation: 'gylin.run', request: { storyId: 'S-1' }, ttlMs: 1_000_000 });
    assert.equal(first.acquired, true);
    await setOperationReceiptResource(first.receipt.idempotencyKey, 'tf-run-1');
    const running = await beginExternalOperationReceipt({ namespace: 'gylin', externalKey: 'story:sha', operation: 'gylin.run', request: { storyId: 'S-1' }, ttlMs: 1_000_000 });
    assert.equal(running.acquired, false);
    assert.equal(running.receipt.resourceId, 'tf-run-1');
    const conflict = await beginExternalOperationReceipt({ namespace: 'gylin', externalKey: 'story:sha', operation: 'gylin.run', request: { storyId: 'S-2' }, ttlMs: 1_000_000 });
    assert.notEqual(conflict.requestHash, conflict.receipt.requestHash);
    const completed = await completeOperationReceipt(first.receipt.idempotencyKey, { runId: 'tf-run-1', status: 'passed' }, {});
    assert.equal(completed.resourceId, 'tf-run-1');
  } finally {
    if (previous === undefined) delete process.env.DISABLE_POSTGRES;
    else process.env.DISABLE_POSTGRES = previous;
  }
});

test('failed external receipts without a run can restart with the same request', async () => {
  const previous = process.env.DISABLE_POSTGRES;
  process.env.DISABLE_POSTGRES = 'true';
  clearOperationReceiptsForTests();
  try {
    const first = await beginExternalOperationReceipt({ namespace: 'gylin', externalKey: 'retry-key', operation: 'gylin.run', request: { storyId: 'S-1' }, ttlMs: 1_000_000 });
    await failOperationReceipt(first.receipt.idempotencyKey, new Error('temporary failure'));
    const restarted = await restartExternalOperationReceipt(first.receipt.idempotencyKey, first.requestHash, 1_000_000);
    assert.equal(restarted.acquired, true);
    assert.equal(restarted.receipt.status, 'running');
    assert.deepEqual(restarted.receipt.verification, { attempt: 2 });
  } finally {
    if (previous === undefined) delete process.env.DISABLE_POSTGRES;
    else process.env.DISABLE_POSTGRES = previous;
  }
});

test('external receipt uses valid JSONB in PostgreSQL', { skip: !process.env.DATABASE_URL }, async () => {
  const receipt = await beginExternalOperationReceipt({ namespace: 'gylin-pg-test', externalKey: String(Date.now()), operation: 'gylin.run', request: { storyId: 'PG-1' }, ttlMs: 60_000 });
  try { assert.deepEqual(receipt.receipt.verification, { attempt: 1 }); }
  finally { await query('DELETE FROM agent_operation_receipts WHERE idempotency_key=$1', [receipt.receipt.idempotencyKey]); }
});

test('scope changes isolate receipts and explicit another requests use the turn id', () => {
  assert.notEqual(buildOperationIdentity(base).idempotencyKey, buildOperationIdentity({ ...base, ctx: { ...base.ctx, userId: 'user-b' } }).idempotencyKey);
  const repeat = { ...base, ctx: { ...base.ctx, userMessage: 'Create another account', requestId: 'turn-a' } };
  assert.notEqual(buildOperationIdentity(repeat).idempotencyKey, buildOperationIdentity({ ...repeat, ctx: { ...repeat.ctx, requestId: 'turn-b' } }).idempotencyKey);
  assert.equal(buildOperationIdentity(repeat).idempotencyKey, buildOperationIdentity(repeat).idempotencyKey);
});
