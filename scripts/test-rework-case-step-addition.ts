import assert from 'node:assert/strict';
import { addedStepRequirementSatisfied, generateValidCaseRework, requestsAdditionalCaseStep } from '../server/features/agent/reworkCaseValidation';

assert.equal(requestsAdditionalCaseStep('Add one more step to cancel the form.'), true);
assert.equal(requestsAdditionalCaseStep('Include cancellation as a new step.'), true);
assert.equal(requestsAdditionalCaseStep('Add validation to step 3.'), false);
assert.equal(addedStepRequirementSatisfied('Add a step.', [1, 2, 3], [1, 2, 3]), false);
assert.equal(addedStepRequirementSatisfied('Add a step.', [1, 2, 3], [1, 2, 3, 4]), true);
assert.equal(addedStepRequirementSatisfied('Rewrite step 3.', [1, 2, 3], [1, 2, 3]), true);

let attempts = 0;
const corrected = await generateValidCaseRework('Add a step.', [1, 2, 3], async (isRetry) => {
  attempts += 1;
  return { steps: isRetry ? [1, 2, 3, 4] : [1, 2, 3] };
});
assert.equal(attempts, 2);
assert.deepEqual(corrected?.steps, [1, 2, 3, 4]);

const rejected = await generateValidCaseRework('Add a step.', [1, 2, 3], async () => ({ steps: [1, 2, 3] }));
assert.equal(rejected, null);

console.log('rework add-step validation and retry: ok');
