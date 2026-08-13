import assert from 'node:assert/strict';
import { hasCodebaseEvidence, hasSupervisorToolCall, INTENT_TOOLS } from '../server/ai/supervisor';
import { canReusePriorCodeGrounding } from '../server/features/agent/routes';

const names = new Set(INTENT_TOOLS.map((tool) => tool.kind));
for (const required of ['create_plan', 'create_suite', 'draft_requirement', 'create_cases', 'prepare_test_scope', 'create_run']) {
  assert(names.has(required), `Supervisor is missing ${required}`);
}
assert.equal(names.size, INTENT_TOOLS.length, 'Supervisor tool names must be unique');
assert.equal(hasSupervisorToolCall([{ index: 0, text: 'unsupported', toolCalls: [] }]), false, 'plain text must not pass the Supervisor acceptance gate');
assert.equal(hasSupervisorToolCall([{ index: 0, toolCalls: [{ id: '1', name: 'prepare_test_scope', arguments: {} }] }]), true, 'a capability call must pass the Supervisor acceptance gate');
assert.equal(hasCodebaseEvidence([{ name: 'search_codebase', result: { matchCount: 0 } }]), false, 'an empty search must not be presented as code-grounded');
assert.equal(hasCodebaseEvidence([{ name: 'search_codebase', result: { matchCount: 1 } }]), true, 'a matching search is code evidence');
assert.equal(canReusePriorCodeGrounding('codebase', 'x'.repeat(120)), false, 'a reviewed chat summary must be checked against the repository again');
assert.equal(canReusePriorCodeGrounding('requirement', 'x'.repeat(120)), true, 'a dedicated source-grounded requirement may be reused');

console.log(`Supervisor capability contract passed (${names.size} tools).`);
