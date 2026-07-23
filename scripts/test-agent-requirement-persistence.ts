import assert from 'node:assert/strict';
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

console.log('agent requirement persistence: ok');
