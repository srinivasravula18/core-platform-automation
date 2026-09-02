import assert from 'node:assert/strict';
import test from 'node:test';
import { caseCountIssues } from '../../server/features/agent/workflow/nodes/authoring';
import { projectStateToLegacyRun } from '../../server/features/agent/workflow/runtime';

test('auto case count accepts the grounded cases available while explicit counts stay strict', () => {
  assert.deepEqual(caseCountIssues([{}], 0), []);
  assert.deepEqual(caseCountIssues([{}], 2), ['Expected exactly 2 test case(s), but received 1.']);
});

test('case authoring errors render as failed instead of skipped', () => {
  const run = projectStateToLegacyRun({
    runId: 'authoring-failure',
    status: 'failed',
    stage: 'finalize',
    cases: [],
    plansByCase: {},
    errors: [{ nodeName: 'generate_cases', message: 'Model output failed validation.', class: 'SCHEMA_INVALID_OUTPUT', retryable: true, maxAttempts: 2 }],
    evidence: { targetCatalog: [{ name: 'Save' }] },
    execution: { attempts: [] },
    request: { goal: 'Validate feature', requestedCaseCount: 0, reviewPolicy: 'auto', executionPolicy: 'auto' },
    mission: { targetUrl: 'https://example.test' },
    output: { reason: 'Model output failed validation.' },
  } as any);

  const caseWriter = run.messages.find((message: any) => message.agent === 'TestGenerationAgent');
  assert.equal(caseWriter.status, 'failed');
  assert.match(caseWriter.output, /Model output failed validation/);
});
