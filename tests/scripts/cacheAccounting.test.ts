import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCodexUsage } from '../../server/ai/codex/runtime';
import { addUsage, type AgentRunResult } from '../../server/ai/tools/types';

test('normalizes Codex cache categories without double-counting writes', () => {
  assert.deepEqual(normalizeCodexUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }, 'gpt-5.6', false), {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, costUsd: 0,
  });
  assert.equal(normalizeCodexUsage({ inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 25 }, 'gpt-5.6', false).inputTokens, 35);
  assert.equal(normalizeCodexUsage({ inputTokens: 10, cachedInputTokens: -1, cacheWriteInputTokens: -2 }, 'gpt-5.6', false).cacheReadTokens, 0);
  assert.equal(normalizeCodexUsage({ inputTokens: 10, cachedInputTokens: 8, cacheWriteInputTokens: 8 }, 'gpt-5.6', false).inputTokens, 0);
  assert.equal(normalizeCodexUsage({ inputTokens: 2_136, outputTokens: 75, totalTokens: 51_107 }, 'gpt-5.6', false).totalTokens, 2_211);
});

test('aggregate run usage retains cache categories and zero-input hit rates stay safe', () => {
  const usage: AgentRunResult['totalUsage'] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
  addUsage(usage, normalizeCodexUsage({ inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 25, outputTokens: 20, totalTokens: 120 }, 'gpt-5.6', false));
  assert.deepEqual(usage, { inputTokens: 35, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 25, totalTokens: 120, costUsd: 0 });
  const hitRate = (read: number, input: number) => input ? (read / input) * 100 : 0;
  assert.equal(hitRate(usage.cacheReadTokens, usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens), 40);
  assert.equal(hitRate(0, 0), 0);
});
