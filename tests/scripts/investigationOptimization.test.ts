import assert from 'node:assert/strict';
import test from 'node:test';
import { runInvestigationNode } from '../../server/features/agent/workflow/nodes/investigation';
import { routeAfterExecuteTests } from '../../server/features/agent/workflow/testRunGraph';

test('zero failures skip investigation and failures share one compact classification call', async () => {
  const previous = process.env.AGENT_INVESTIGATE;
  process.env.AGENT_INVESTIGATE = 'true';
  try {
    assert.equal(routeAfterExecuteTests({ runId: 'run-pass', execution: { aggregate: { failed: 0 } } } as any), 'finalize');

    let calls = 0;
    const summary = await runInvestigationNode({
      runId: 'run-fail',
      tests: [
        { title: 'Create account', status: 'failed', error: 'locator #save was not found', screenshotPath: '/evidence/create.png' },
        { title: 'Update account', status: 'failed', error: 'request timed out', tracePath: '/evidence/update.zip' },
      ],
      cases: [],
      compiledSources: {},
      caseTitleById: {},
      deps: {
        classifyBatch: async (contexts) => {
          calls += 1;
          assert.equal(contexts.length, 2);
          assert.deepEqual(contexts.map((context) => context.evidenceRefs), [['/evidence/create.png'], ['/evidence/update.zip']]);
          return contexts.map(() => ({
            classification: 'functional' as const,
            rootCauseArea: 'account flow',
            confidence: 0.8,
            observations: [],
            suggestedAreas: [],
          }));
        },
      },
    });

    assert.equal(calls, 1);
    assert.equal(summary.llmCalls, 1);
    assert.equal(summary.findings.length, 2);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INVESTIGATE;
    else process.env.AGENT_INVESTIGATE = previous;
  }
});
