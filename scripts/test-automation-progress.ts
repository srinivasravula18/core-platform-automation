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

console.log('automation progress checks passed');
