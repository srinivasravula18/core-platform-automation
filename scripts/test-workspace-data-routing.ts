import assert from 'node:assert/strict';
import {
  isWorkspaceDataQuestion, queryWorkspaceTool, quickWorkspaceAnswer, scriptsFromAgentRuns,
} from '../server/ai/tools/registry';
import { Agents, AutomationArtifacts, AutomationJobs, Settings } from '../server/db/repository';

assert.equal(isWorkspaceDataQuestion('tell me which script created the app called Validation test app'), true);
assert.equal(isWorkspaceDataQuestion('what fields are on the app creation page?'), false);
assert.equal(isWorkspaceDataQuestion('check once again', [
  { content: 'which script created Validation test app?' },
]), true);
for (const question of [
  'how many folders are in my workspace?',
  'list the automation agents',
  'show my recordings',
  'how many automation jobs are there?',
  'list the schedules',
  'how many uploaded automation artifacts exist?',
  'which settings are configured?',
]) {
  assert.equal(isWorkspaceDataQuestion(question), true, question);
}

const workspaceKinds = ((queryWorkspaceTool.spec.parameters as any).properties.kind.enum || []) as string[];
for (const kind of ['folders', 'automation_agents', 'recordings', 'jobs', 'schedules', 'automation_artifacts', 'settings']) {
  assert.equal(workspaceKinds.includes(kind), true, kind);
}
assert.equal(workspaceKinds.includes('credentials'), false);

const originalAgentsList = Agents.list;
const originalArtifactsList = AutomationArtifacts.list;
const originalJobsList = AutomationJobs.list;
const originalSettingsGet = Settings.getKVs;
try {
  Agents.list = async () => [
    { id: 'A-1', name: 'Local One', ownerId: 'USER-1' },
    { id: 'A-2', name: 'Local Two', ownerId: 'USER-1' },
    { id: 'A-3', name: 'Other User', ownerId: 'USER-2' },
  ];
  assert.equal(
    await quickWorkspaceAnswer('how many automation agents?', { userId: 'USER-1' }),
    'There are 2 automation agents in the workspace.',
  );

  AutomationArtifacts.list = async () => [
    { id: 'ART-1', jobId: 'JOB-1', filename: 'trace.zip' },
    { id: 'ART-2', jobId: 'JOB-2', filename: 'video.webm' },
  ];
  AutomationJobs.list = async () => [
    { id: 'JOB-1', ownerId: 'USER-1' },
    { id: 'JOB-2', ownerId: 'USER-2' },
  ];
  const artifacts = await queryWorkspaceTool.execute(
    { kind: 'automation_artifacts' },
    { userId: 'USER-1' } as any,
  ) as any[];
  assert.deepEqual(artifacts.map((item) => item.id), ['ART-1']);

  Settings.getKVs = async () => ({
    theme: 'dark',
    siteCredentials: [{ username: 'hidden', password: 'hidden' }],
    openaiApiKey: 'hidden',
  });
  const settings = await queryWorkspaceTool.execute({ kind: 'settings' }, {} as any) as any[];
  assert.deepEqual(settings.map((item) => item.id), ['theme']);
  assert.equal(JSON.stringify(settings).includes('hidden'), false);
  assert.equal(
    await quickWorkspaceAnswer('how many settings are configured?'),
    'There is 1 setting in the workspace.',
  );
} finally {
  Agents.list = originalAgentsList;
  AutomationArtifacts.list = originalArtifactsList;
  AutomationJobs.list = originalJobsList;
  Settings.getKVs = originalSettingsGet;
}

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
