import assert from 'node:assert/strict';
import { isWorkspaceDataQuestion, scriptsFromAgentRuns } from '../server/ai/tools/registry';

assert.equal(isWorkspaceDataQuestion('tell me which script created the app called Validation test app'), true);
assert.equal(isWorkspaceDataQuestion('what fields are on the app creation page?'), false);
assert.equal(isWorkspaceDataQuestion('check once again', [
  { content: 'which script created Validation test app?' },
]), true);

const scripts = scriptsFromAgentRuns([{
  id: 'RUN-1',
  ownerId: 'USER-1',
  projectId: 'PROJECT-1',
  playwright_scripts: [{
    filename: 'create-validation-app.spec.ts',
    code: "await page.getByLabel('Label').fill('Validation test app');",
  }],
}]);

assert.equal(scripts.length, 1);
assert.equal(scripts[0].agentRunId, 'RUN-1');
assert.equal(scripts[0].ownerId, 'USER-1');
assert.match(scripts[0].code, /Validation test app/);
console.log('workspace data routing: ok');
