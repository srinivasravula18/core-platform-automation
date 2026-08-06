import assert from 'node:assert/strict';
import { entityIdFromResult, verifyToolMutation } from '../server/ai/verification';
import { redactSecrets } from '../server/ai/memory/artifactMemory';
import { serializePrompt } from '../server/ai/tracer';

assert.equal(entityIdFromResult({ record: { id: 'ACC-1' } }), 'ACC-1');
assert.equal(entityIdFromResult({ response: { id: 42 } }), '42');
assert.equal(entityIdFromResult({}), '');

const unsupported = await verifyToolMutation('save_form', {}, {}, {});
assert.equal(unsupported.status, 'unsupported');
assert.equal(unsupported.ok, false);
assert.deepEqual(redactSecrets({ username: 'qa', password: 'secret' }), { username: 'qa', password: '[REDACTED]' });
assert.doesNotMatch(serializePrompt('SYSTEM SECRET', [{ role: 'user', content: 'USER SECRET' }]), /SYSTEM SECRET|USER SECRET/);

console.log('Agent mutation verification checks passed');
