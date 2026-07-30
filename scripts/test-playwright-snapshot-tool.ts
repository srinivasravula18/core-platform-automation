import assert from 'node:assert/strict';
import { capabilityFor } from '../server/ai/policy';
import { playwrightYamlSnapshotTool } from '../server/ai/tools/playwrightSnapshot';
import { isDestructiveBrowserAction, isModelSafeMcpTool, playwrightMcpCapabilitiesForGoal } from '../server/features/agent/mcpInspector';

assert.equal(playwrightYamlSnapshotTool.spec.name, 'playwright_yaml_snapshot');
assert.deepEqual(capabilityFor(playwrightYamlSnapshotTool), { effect: 'write', permissions: ['agent:execute'] });
assert.deepEqual((playwrightYamlSnapshotTool.spec.parameters as any).required, ['goal']);
assert.equal(isDestructiveBrowserAction({ element: 'Delete account', ref: 'e12' }), true);
assert.equal(isDestructiveBrowserAction({ element: 'Save and next', ref: 'e13' }), false);
assert.equal(isModelSafeMcpTool('browser_take_screenshot'), true);
assert.equal(isModelSafeMcpTool('browser_run_code_unsafe'), false);
assert.equal(isModelSafeMcpTool('browser_cookie_list'), false);
assert.deepEqual(playwrightMcpCapabilitiesForGoal('Verify offline PDF report'), ['testing', 'network', 'pdf']);

console.log('Playwright MCP snapshot tool checks passed');
