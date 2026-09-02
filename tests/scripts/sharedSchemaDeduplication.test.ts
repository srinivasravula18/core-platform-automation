import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkflowError, workflowErrorSchema } from '../../server/features/agent/workflow/errors';
import { ruleSchema } from '../../server/features/vitals/alerts';
import { matcherSchema } from '../../server/features/vitals/metricsQuery';

test('workflow error parsing uses the exported schema contract', () => {
  const error = {
    class: 'NETWORK_TRANSIENT',
    message: 'connection reset',
    retryable: true,
    maxAttempts: 3,
  };

  assert.deepEqual(parseWorkflowError(error), workflowErrorSchema.parse(error));
  assert.equal(parseWorkflowError({ ...error, class: 'UNKNOWN' }), null);
});

test('alert rules reuse the metric matcher schema', () => {
  const matcher = { label: 'service', value: 'api' };
  assert.deepEqual(ruleSchema.shape.labelMatchers.parse([matcher]), matcherSchema.array().parse([matcher]));
  assert.deepEqual(ruleSchema.shape.labelMatchers.parse([]), []);
});
