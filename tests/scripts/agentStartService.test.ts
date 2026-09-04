import assert from 'node:assert/strict';
import test from 'node:test';
import { startResolvedRun } from '../../server/features/agent/startService';

test('resolved runs use the existing graph with the complete trusted input', async () => {
  const calls: any[] = [];
  const runId = await startResolvedRun({
    runId: 'run-1',
    projectId: 'project-1',
    appId: 'app-1',
    ownerId: 'owner-1',
    targetUrl: 'https://app.example.test/path',
    prompt: 'Validate checkout',
    understanding: '  Checkout requires payment.  ',
    conversationId: 'conversation-1',
    requestedCaseCount: 3,
    reviewPolicy: 'manual',
    executionPolicy: 'auto',
    mission: {
      platformType: 'web',
      platform: 'RUNTIME',
      runtimeSurface: null,
      applicationId: 'app-1',
      moduleId: null,
      tabId: null,
      targetUrl: 'https://app.example.test/path',
      executionScope: 'checkout',
    },
    credential: { username: 'resolved-user', password: 'resolved-password' },
    modelOverrides: { provider: 'openai', model: 'test-model', effort: 'medium' },
    safeMetadata: { status: 'running', source: 'agent-console' },
    priorVerifiedElements: [{ selector: '#checkout' }],
  }, {
    announceStart: async (input: any) => { calls.push({ announce: input }); return {} as any; },
    startGraph: async (input: any) => { calls.push({ graph: input }); },
  });

  assert.equal(runId, 'run-1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].announce.context, 'Checkout requires payment.');
  assert.deepEqual(calls[1].graph, {
    runId: 'run-1',
    workspaceId: 'project-1',
    projectId: 'project-1',
    requestedBy: 'owner-1',
    goal: 'Validate checkout',
    understanding: 'Checkout requires payment.',
    conversationId: 'conversation-1',
    requestedCaseCount: 3,
    reviewPolicy: 'manual',
    executionPolicy: 'auto',
    mission: {
      platformType: 'web',
      platform: 'RUNTIME',
      runtimeSurface: null,
      applicationId: 'app-1',
      moduleId: null,
      tabId: null,
      targetUrl: 'https://app.example.test/path',
      executionScope: 'checkout',
    },
    credential: { username: 'resolved-user', password: 'resolved-password' },
    modelOverrides: { provider: 'openai', model: 'test-model', effort: 'medium' },
    legacyRunSeed: {
      status: 'running',
      source: 'agent-console',
      id: 'run-1',
      app_url: 'https://app.example.test/path',
      projectId: 'project-1',
      appId: 'app-1',
      ownerId: 'owner-1',
      prompt: 'Validate checkout',
    },
    seedCases: undefined,
    avoidCaseTitles: undefined,
    graphDeps: { priorVerifiedElements: [{ selector: '#checkout' }] },
  });
});
