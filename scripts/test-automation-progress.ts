import { strict as assert } from 'node:assert';
import { applyExecutionProgress, automationProgressPercent, finalizeExecutionProgress, mergeExecutionProgress } from '../core/shared/automationProgress';

assert.equal(automationProgressPercent('queued'), 5);
assert.equal(automationProgressPercent('dispatched'), 10);
assert.equal(automationProgressPercent('running', 0, 1, 'started'), 20);
assert.equal(automationProgressPercent('running', 0, 1, 'test_started'), 25);
assert.equal(automationProgressPercent('running', 1, 2, 'test_finished'), 50);
assert.equal(automationProgressPercent('running', 2, 2, 'test_finished'), 80);
assert.equal(automationProgressPercent('uploading', 2, 2), 90);
assert.equal(automationProgressPercent('done', 2, 2), 100);
assert.equal(automationProgressPercent('cancelled', 1, 2), 50);

const started = mergeExecutionProgress({}, { event: 'step_started', stepId: 's1', stepIndex: 1, stepTitle: 'Open page', stepStartedAt: 100 });
assert.deepEqual(started.executionSteps[0], { id: 's1', index: 1, title: 'Open page', status: 'Running', startedAt: 100, durationMs: 0 });
const finished = mergeExecutionProgress(started, { event: 'step_finished', stepId: 's1', stepIndex: 1, stepTitle: 'Open page', stepStartedAt: 100, stepDurationMs: 1250 });
assert.equal(finished.executionSteps[0].status, 'Passed');
assert.equal(finished.executionSteps[0].durationMs, 1250);

const terminal = finalizeExecutionProgress(started, 'failed', 'Timed out', 1500);
assert.equal(terminal.executionSteps[0].status, 'Failed');
assert.equal(terminal.executionSteps[0].durationMs, 1400);
assert.equal(terminal.executionSteps[0].error, 'Timed out');

// Positional fallback (hand-edited/recorded scripts — no caseSteps ids exist).
assert.deepEqual(applyExecutionProgress(
  [{ action: 'Open page', outcome: 'Not Run' }, { action: 'Submit', outcome: 'Not Run' }],
  [
    { id: 's1', index: 1, title: 'Open page', status: 'Passed', startedAt: 100, durationMs: 1250 },
    { id: 's2', index: 2, title: 'Submit', status: 'Failed', startedAt: 1400, durationMs: 600 },
  ],
), [
  { action: 'Open page', outcome: 'Passed', durationMs: 1250 },
  { action: 'Submit', outcome: 'Failed', durationMs: 600 },
]);

// Id match takes priority over position — a compiler-generated script's caseSteps correlate by real id,
// not by array index, and can arrive out of authored order (e.g. required-field completion inserted
// before the actual step it precedes).
assert.deepEqual(applyExecutionProgress(
  [{ id: 'case:0', action: 'Open page', outcome: 'Not Run' }, { id: 'case:1', action: 'Submit', outcome: 'Not Run' }],
  [],
  [
    { id: 'case:1', title: 'CLICK submit', status: 'Failed', startedAt: 1400, durationMs: 600 },
    { id: 'case:0', title: 'OPEN_MODULE page', status: 'Passed', startedAt: 100, durationMs: 1250 },
  ],
), [
  { id: 'case:0', action: 'Open page', outcome: 'Passed', durationMs: 1250 },
  { id: 'case:1', action: 'Submit', outcome: 'Failed', durationMs: 600 },
]);

// An authored step with no matching caseStep entry yet (still queued) stays Not Run, not misattributed
// to a same-index raw step the way the old positional match would have done.
assert.deepEqual(applyExecutionProgress(
  [{ id: 'case:0', action: 'Open page', outcome: 'Not Run' }, { id: 'case:1', action: 'Submit', outcome: 'Not Run' }],
  [],
  [{ id: 'case:0', title: 'OPEN_MODULE page', status: 'Running', startedAt: 100, durationMs: 0 }],
), [
  { id: 'case:0', action: 'Open page', outcome: 'Running', durationMs: 0 },
  { id: 'case:1', action: 'Submit', outcome: 'Not Run' },
]);

// A humanized step grouping multiple raw recorded actions (sourceStepIds) aggregates them: all
// passed -> Passed, any failed -> Failed, duration sums across the group.
assert.deepEqual(applyExecutionProgress(
  [{ action: 'Enter valid login credentials', sourceStepIds: ['step:0', 'step:1'], outcome: 'Not Run' }],
  [],
  [
    { id: 'step:0', title: 'Fill username', status: 'Passed', startedAt: 100, durationMs: 200 },
    { id: 'step:1', title: 'Fill password', status: 'Passed', startedAt: 300, durationMs: 150 },
  ],
), [
  { action: 'Enter valid login credentials', sourceStepIds: ['step:0', 'step:1'], outcome: 'Passed', durationMs: 350 },
]);
assert.equal(applyExecutionProgress(
  [{ action: 'Enter valid login credentials', sourceStepIds: ['step:0', 'step:1'], outcome: 'Not Run' }],
  [],
  [{ id: 'step:0', title: 'Fill username', status: 'Failed', startedAt: 100, durationMs: 200, error: 'timeout' }],
)[0].outcome, 'Failed');

// The failure reason rides along with the outcome (Reports/exports read it as Actual Result / Failure).
assert.equal(applyExecutionProgress(
  [{ id: 'case:0', action: 'Click Save', outcome: 'Not Run', error: '' }],
  [],
  [{ id: 'case:0', title: 'CLICK Save', status: 'Failed', startedAt: 100, durationMs: 200, error: 'Element not found' }],
)[0].error, 'Element not found');

// A step the script caught (login guards use .catch(() => {})) reports step.error, so it lands as
// Failed while running. When the test itself passes, the reporter says so and the step must recover —
// otherwise the execution list shows Failed for a step the case list shows as Passed.
const withCaughtError = mergeExecutionProgress(
  mergeExecutionProgress({}, { event: 'step_started', stepId: 's1', stepIndex: 1, stepTitle: 'locator.click', stepStartedAt: 10 }),
  { event: 'step_finished', stepId: 's1', stepIndex: 1, stepTitle: 'locator.click', stepDurationMs: 40, stepError: 'locator timeout' },
);
assert.equal(withCaughtError.executionSteps[0].status, 'Failed');
const recovered = mergeExecutionProgress(withCaughtError, { event: 'steps_recovered', stepIds: ['s1'], caseStepIds: [] });
assert.equal(recovered.executionSteps[0].status, 'Passed');
assert.equal(recovered.executionSteps[0].error, undefined);

// A genuine failure is never recovered: it is not in the reported id list.
const realFailure = mergeExecutionProgress(withCaughtError, { event: 'steps_recovered', stepIds: ['other'], caseStepIds: [] });
assert.equal(realFailure.executionSteps[0].status, 'Failed');

// Case steps recover the same way, and a run with neither list is untouched.
const caseStepFailed = mergeExecutionProgress({}, { event: 'case_step_finished', caseStepId: 'case:0', caseStepTitle: 'Log in', caseStepDurationMs: 20, caseStepError: 'caught' });
assert.equal(caseStepFailed.caseSteps[0].status, 'Failed');
assert.equal(mergeExecutionProgress(caseStepFailed, { event: 'steps_recovered', stepIds: [], caseStepIds: ['case:0'] }).caseSteps[0].status, 'Passed');
assert.deepEqual(mergeExecutionProgress({}, { event: 'steps_recovered', stepIds: ['s1'], caseStepIds: [] }), {});

console.log('automation progress checks passed');
