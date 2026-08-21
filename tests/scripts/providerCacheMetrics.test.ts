import assert from 'node:assert/strict';
import test from 'node:test';
import { providerCacheMetrics } from '../../server/ai/providers/types';

test('provider cache hit rate uses disjoint input categories', () => {
  const metrics = providerCacheMetrics({
    inputTokens: 200,
    outputTokens: 50,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    totalTokens: 1050,
    costUsd: 0,
  });
  assert.equal(metrics.reusableInputTokens, 1000);
  assert.equal(metrics.hitRate, 0.7);
  assert.equal(metrics.freshInputTokens, 200);
});

test('provider cache metrics are finite for an application-level cache hit', () => {
  assert.deepEqual(providerCacheMetrics(), {
    readTokens: 0,
    writeTokens: 0,
    freshInputTokens: 0,
    reusableInputTokens: 0,
    hitRate: 0,
  });
});

