import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityDiscoveryWebSearchMode, shouldUseConversationalFastPath } from '../../server/agent-runtime/goals/router';

test('enables cached hosted search only for capability discovery', () => {
  assert.equal(capabilityDiscoveryWebSearchMode('Find a Playwright skill for selector quality'), 'cached');
  assert.equal(capabilityDiscoveryWebSearchMode('Explain how Playwright selectors work'), 'disabled');
});

test('uses live search only when capability freshness is explicit', () => {
  assert.equal(capabilityDiscoveryWebSearchMode('Search for the latest MCP server for GitHub'), 'live');
  assert.equal(capabilityDiscoveryWebSearchMode('Install the first tool you find'), 'cached');
});

test('capability discovery bypasses the tool-less conversational route', () => {
  const prompt = 'Which skills should I use for browser testing?';
  assert.equal(shouldUseConversationalFastPath(prompt), true);
  assert.notEqual(capabilityDiscoveryWebSearchMode(prompt), 'disabled');
});
