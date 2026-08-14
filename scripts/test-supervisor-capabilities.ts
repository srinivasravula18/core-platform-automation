import assert from 'node:assert/strict';
import { buildSupervisorTools, hasCodebaseEvidence, INTENT_TOOLS } from '../server/ai/supervisor';
import { canReusePriorCodeGrounding } from '../server/features/agent/routes';
import { shouldPrepareTestScope, shouldUseConversationalFastPath } from '../server/agent-runtime/goals/router';
import { boundTraceValue } from '../server/ai/tracer';

const names = new Set(INTENT_TOOLS.map((tool) => tool.kind));
for (const required of ['create_plan', 'create_suite', 'draft_requirement', 'create_cases', 'prepare_test_scope', 'create_run']) {
  assert(names.has(required), `Supervisor is missing ${required}`);
}
assert.equal(names.size, INTENT_TOOLS.length, 'Supervisor tool names must be unique');
assert(buildSupervisorTools({ workspaceId: 'default' }).some((tool) => tool.spec.name === 'check_url'), 'Supervisor must expose the URL-health tool named in its prompt');
assert.equal(shouldUseConversationalFastPath('What is regression testing?'), true, 'general questions should use one authenticated SDK turn');
assert.equal(shouldUseConversationalFastPath('How does the List View page work?'), false, 'product questions must keep grounded tools');
assert.equal(shouldPrepareTestScope('Test creating an account in CRM'), true, 'explicit test commands should enter scope review without an LLM routing turn');
assert.equal(shouldPrepareTestScope('What tests cover account creation?'), false, 'coverage questions are not live-test commands');
const bounded: any = boundTraceValue({ value: 'x'.repeat(100) }, 20);
assert.equal(bounded.truncated, true, 'oversized trace fields must be bounded before writing');
assert.equal(hasCodebaseEvidence([{ name: 'search_codebase', result: { matchCount: 0 } }]), false, 'an empty search must not be presented as code-grounded');
assert.equal(hasCodebaseEvidence([{ name: 'search_codebase', result: { matchCount: 1 } }]), true, 'a matching search is code evidence');
assert.equal(canReusePriorCodeGrounding('codebase', 'x'.repeat(120)), false, 'a reviewed chat summary must be checked against the repository again');
assert.equal(canReusePriorCodeGrounding('requirement', 'x'.repeat(120)), true, 'a dedicated source-grounded requirement may be reused');

console.log(`Supervisor capability contract passed (${names.size} tools).`);
