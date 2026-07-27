import assert from 'node:assert/strict';
import { runPlaywrightRequest } from '../server/features/playwright/routes';

await assert.rejects(
  runPlaywrightRequest({
    scripts: [{ filename: 'agent.spec.ts', code: 'test("agent script", async () => {});' }],
    baseUrl: '',
    runId: 'agent-run',
    requireAuth: true,
  }),
  /Authentication is required, but this test run has no target URL/,
);

console.log('PASS: agent-authored Test Run scripts are blocked until authentication is prepared.');
