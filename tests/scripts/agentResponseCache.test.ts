import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentCacheIdentity,
  clearAgentCacheForTests,
  completedResultCachePolicy,
  completedDeepScopeCachePolicy,
  DEEP_SCOPE_CACHE_NAMESPACE,
  invalidateCompletedAgentResults,
  readCompletedAgentResult,
  storeCompletedAgentResult,
} from '../../server/ai/agent-runtime/responseCache';

const scope = {
  userMessage: 'How many active accounts are available?',
  workspaceId: 'workspace-a',
  userId: 'user-a',
  role: 'admin',
  projectId: 'project-a',
  appId: 'app-a',
  targets: [{ id: 'app-a', name: 'CRM', baseUrl: 'https://example.test/' }],
  model: 'codex:gpt-test',
};

const result = {
  finalText: 'There are three active accounts.',
  steps: [],
  toolResults: [],
  accepted: true,
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, costUsd: 0.01 },
};

test('normalizes equivalent read requests and isolates security scope', () => {
  assert.equal(
    buildAgentCacheIdentity(scope).cacheKey,
    buildAgentCacheIdentity({ ...scope, userMessage: '  HOW many active accounts are available?  ', targets: [{ ...scope.targets[0], baseUrl: 'https://example.test' }] }).cacheKey,
  );
  assert.notEqual(buildAgentCacheIdentity(scope).cacheKey, buildAgentCacheIdentity({ ...scope, userId: 'user-b' }).cacheKey);
  assert.notEqual(buildAgentCacheIdentity(scope).cacheKey, buildAgentCacheIdentity({ ...scope, appId: 'app-b' }).cacheKey);
});

test('never reuses mutation or explicit freshness requests', () => {
  assert.equal(completedResultCachePolicy('Create an Account').reusable, false);
  assert.equal(completedResultCachePolicy('Update account 123').reusable, false);
  assert.equal(completedResultCachePolicy('Show the latest accounts').reusable, false);
  assert.equal(completedResultCachePolicy(scope.userMessage).reusable, true);
});

test('reuses reviewed test scopes safely, except corrections and freshness requests', () => {
  assert.equal(completedDeepScopeCachePolicy('Create end-to-end tests for Accounts').reusable, true);
  assert.equal(completedDeepScopeCachePolicy('Create end-to-end tests for Accounts', 'Include approval').reusable, false);
  assert.equal(completedDeepScopeCachePolicy('Run the current end-to-end tests').reusable, false);
});

test('stores and reads a completed result across conversation-independent keys', async () => {
  clearAgentCacheForTests();
  await storeCompletedAgentResult(scope, result, 30_000);
  const cached = await readCompletedAgentResult(scope);
  assert.equal(cached?.result.finalText, result.finalText);
  assert.equal(cached?.result.usage.totalTokens, 15);
});

test('keeps reviewed scopes separate from supervisor results', () => {
  assert.notEqual(
    buildAgentCacheIdentity(scope).cacheKey,
    buildAgentCacheIdentity({ ...scope, namespace: DEEP_SCOPE_CACHE_NAMESPACE }).cacheKey,
  );
});

test('a successful scoped mutation can invalidate prior read results', async () => {
  const previous = process.env.DISABLE_POSTGRES;
  process.env.DISABLE_POSTGRES = 'true';
  clearAgentCacheForTests();
  try {
    await storeCompletedAgentResult(scope, result, 30_000);
    assert.ok(await readCompletedAgentResult(scope));
    await invalidateCompletedAgentResults(buildAgentCacheIdentity(scope).scopeHash);
    assert.equal(await readCompletedAgentResult(scope), null);
  } finally {
    if (previous === undefined) delete process.env.DISABLE_POSTGRES;
    else process.env.DISABLE_POSTGRES = previous;
  }
});
