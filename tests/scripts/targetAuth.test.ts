import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAccessToken } from '../../server/ai/tools/targetAuth';

test('target login returns only successful access tokens', async () => {
  const request = async () => new Response(JSON.stringify({ access_token: 'token-1' }), { status: 200 });
  assert.equal(await requestAccessToken('https://example.test', 'user', 'pass', request), 'token-1');
  await assert.rejects(
    requestAccessToken('https://example.test', 'user', 'bad', async () => new Response('{}', { status: 401 })),
    /Login failed \(401\)/,
  );
});
