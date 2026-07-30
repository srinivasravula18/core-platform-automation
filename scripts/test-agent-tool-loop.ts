import assert from 'node:assert/strict';
import { maxToolIterations, ToolProgressTracker } from '../server/ai/toolProgress';

const repeated = new ToolProgressTracker();
assert.equal(repeated.recordAttempt('query', { b: 2, a: 1 }), null);
assert.equal(repeated.recordAttempt('query', { a: 1, b: 2 }), null);
assert.equal(repeated.recordAttempt('query', { b: 2, a: 1 }), 'repeated_call');

const failures = new ToolProgressTracker();
for (let i = 0; i < 4; i += 1) assert.equal(failures.recordOutcome(false), null);
assert.equal(failures.recordOutcome(false), 'consecutive_failures');
assert.equal(failures.recordOutcome(true), null);
assert.equal(failures.recordOutcome(false), null);

process.env.AGENT_MAX_TOOL_ITERATIONS = '500';
assert.equal(maxToolIterations(), 64);
assert.equal(maxToolIterations(7), 7);
process.env.AGENT_MAX_TOOL_ITERATIONS = 'invalid';
assert.equal(maxToolIterations(), 64);

console.log('agent tool-loop checks passed');
