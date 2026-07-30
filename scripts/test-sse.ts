import assert from 'node:assert/strict';
import { readSseJson } from '../src/lib/sse';
import { prepareSse, sendSse } from '../server/shared/sse';

const encoder = new TextEncoder();
const chunks = ['data: {"type":"st', 'ep","text":"Working"}\n\n: heartbeat\n\ndata: {"type":"final","result":{"id":"REQ-1"}}\n\n'];
const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  },
});
const events: any[] = [];
await readSseJson(stream, (event) => events.push(event));

assert.deepEqual(events, [
  { type: 'step', text: 'Working' },
  { type: 'final', result: { id: 'REQ-1' } },
]);
await assert.rejects(
  readSseJson(new Response('data: {"type":"error"}\n\n').body!, () => { throw new Error('failed'); }),
  /failed/,
);

const headers = new Map<string, string>();
let output = '';
const response = {
  setHeader: (name: string, value: string) => headers.set(name, value),
  write: (value: string) => { output += value; },
  flushHeaders: () => undefined,
  flush: () => undefined,
};
prepareSse(response);
sendSse(response, { type: 'final', result: { ok: true } });
assert.match(headers.get('Content-Type') || '', /text\/event-stream/);
assert.match(output, /data: {"type":"final","result":{"ok":true}}/);
console.log('SSE parsing checks passed.');
