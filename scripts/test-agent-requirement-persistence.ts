import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveUnderstanding } from '../server/agent-runtime/context/goalContext';
import { structureRequirementText } from '../server/features/requirements/requirementText';

const fullRequirement = `App creation is a metadata workflow.

1. Access and authorization
- Verify an authenticated administrator can create an app.
- Verify a non-admin cannot create an app.

2. Required fields
- Submit without Label and expect a required-field error.
- Submit without Parent App and expect a required-field error.`;

const resolved = resolveUnderstanding({
  prompt: 'give test cases for app creation',
  messages: [
    { agent: 'System', output: 'Done.' },
    { agent: 'System', output: `Approved understanding:\n${fullRequirement}` },
  ],
});
assert.equal(resolved, fullRequirement);

const structured = structureRequirementText(resolved);
assert.equal(structured.description, 'App creation is a metadata workflow.');
assert.deepEqual(structured.businessRules, [
  'Access and authorization: Verify an authenticated administrator can create an app.',
  'Access and authorization: Verify a non-admin cannot create an app.',
  'Required fields: Submit without Label and expect a required-field error.',
  'Required fields: Submit without Parent App and expect a required-field error.',
]);

const agentRoutes = readFileSync(new URL('../server/features/agent/routes.ts', import.meta.url), 'utf8');
const requirementService = readFileSync(new URL('../server/features/requirements/requirementService.ts', import.meta.url), 'utf8');
// A completed deep run now records a Requirement from its verified coverage, so the Requirements section
// reflects what the agent actually tested (populated alongside cases/suites/plans/runs).
assert.ok(agentRoutes.includes('async function persistAgentRequirementArtifact'));
assert.ok(agentRoutes.includes('await persistAgentRequirementArtifact(run)'));
assert.ok(agentRoutes.includes('Requirements.upsert'));
assert.ok(requirementService.includes('export async function confirmRequirementDraft'));
assert.ok(requirementService.includes('const requirement = await Requirements.upsert'));

console.log('agent requirement persistence: ok');
