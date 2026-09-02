import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBalancedJson, parseEmbeddedJson } from '../../server/shared/embeddedJson';
import { withTimeout } from '../../server/ai/tools/mcpClient';
import { prepareSse } from '../../server/shared/sse';

test('balanced JSON extraction preserves nested containers and escaped quotes', () => {
  const content = 'prefix {"message":"brace } and \\"quote\\"","items":[{"id":1}]} suffix';
  assert.deepEqual(extractBalancedJson(content), {
    json: '{"message":"brace } and \\"quote\\"","items":[{"id":1}]}',
    unterminated: false,
  });
  assert.deepEqual(parseEmbeddedJson(content), { message: 'brace } and "quote"', items: [{ id: 1 }] });
});

test('embedded JSON parsing skips malformed leading candidates and reports truncation', () => {
  assert.deepEqual(parseEmbeddedJson('broken { then valid {"ok":true}'), { ok: true });
  assert.deepEqual(extractBalancedJson('prefix {"items":[1,2]'), { json: null, unterminated: true });
  assert.equal(parseEmbeddedJson('plain text only'), null);
});

test('withTimeout preserves values, errors, and the configured timeout message', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 20, 'late'), 'ok');
  await assert.rejects(withTimeout(Promise.reject(new Error('source')), 20, 'late'), /source/);
  await assert.rejects(withTimeout(new Promise(() => undefined), 5, 'timed out'), /timed out/);
});

test('prepareSse emits the established proxy-safe response headers and primer', () => {
  const headers = new Map<string, string>();
  const writes: string[] = [];
  let flushed = false;
  let noDelay = false;
  prepareSse({
    setHeader: (name: string, value: string) => headers.set(name, value),
    socket: { setNoDelay: () => { noDelay = true; } },
    flushHeaders: () => { flushed = true; },
    write: (value: string) => { writes.push(value); },
  });
  assert.equal(headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  assert.equal(headers.get('X-Accel-Buffering'), 'no');
  assert.equal(headers.get('Connection'), 'keep-alive');
  assert.equal(flushed, true);
  assert.equal(noDelay, true);
  assert.ok(writes[0].length >= 4096);
});
