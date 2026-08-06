import { strict as assert } from 'node:assert';
import { PAUSE_DEFAULT_TIMEOUT_MS, normalizePauseRequest, pauseAttemptKey } from '../core/shared/pause';
import { startPauseControl } from '../agent/src/pauseControl';

const input = normalizePauseRequest({ id: ' otp ', kind: 'input', prompt: ' Code ' });
assert.equal(input.id, 'otp');
assert.equal(input.prompt, 'Code');
assert.equal(input.timeoutMs, PAUSE_DEFAULT_TIMEOUT_MS);
assert.equal(input.masked, true);
assert.equal(input.onTimeout, 'fail');
assert.equal(input.requiresHeaded, false);
assert.equal(normalizePauseRequest({ id: 'captcha', kind: 'manual_action', prompt: 'Complete captcha' }).requiresHeaded, true);
assert.equal(pauseAttemptKey('job', 'otp', 1), '["job","otp",1]');
assert.notEqual(pauseAttemptKey('job:a', 'otp', 1), pauseAttemptKey('job', 'a:otp', 1));

const control = await startPauseControl('job-1');
const headers = { 'content-type': 'application/json', 'x-testflow-control-key': control.key };
const opened = await fetch(`${control.url}/pause/open`, {
  method: 'POST', headers, body: JSON.stringify({ id: 'otp', kind: 'input', prompt: 'Enter OTP', timeoutMs: 30 }),
});
assert.equal(opened.status, 201);
const pause = await opened.json() as { token: string };
const reopened = await fetch(`${control.url}/pause/open`, {
  method: 'POST', headers, body: JSON.stringify({ id: 'otp', kind: 'input', prompt: 'Enter OTP', timeoutMs: 30 }),
});
assert.equal((await reopened.json() as { token: string }).token, pause.token);
const expired = await fetch(`${control.url}/pause/wait?token=${pause.token}`, { headers });
assert.equal((await expired.json() as { outcome: string }).outcome, 'expired');

const opened2 = await fetch(`${control.url}/pause/open`, {
  method: 'POST', headers, body: JSON.stringify({ id: 'approval', kind: 'manual_action', prompt: 'Approve', timeoutMs: 1000 }),
});
assert.equal(opened2.status, 201);
const answer = { pauseId: 'approval', attempt: 1, outcome: 'resolved' as const, resolvedBy: 'user-1' };
assert.equal(control.resolve('approval', answer), true);
assert.equal(control.resolve('approval', answer), true);
assert.equal(control.resolve('approval', { ...answer, resolvedBy: 'user-2' }), false);

await control.close();
console.log('pause contract checks passed');
