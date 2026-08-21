import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentActivity, activitySteps, restoreActiveActivity, type ActivityEvent } from '../../src/components/AgentActivity';
import { MessageMeta } from '../../src/components/MessageMeta';

test('activity timeline uses one bounded scroll region without an empty placeholder', () => {
  const html = renderToStaticMarkup(
    <AgentActivity conversationId="conversation" requestId="request" />,
  );
  assert.match(html, /max-h-\[min\(55vh,32rem\)\]/);
  assert.match(html, /overflow-y-auto/);
  assert.match(html, /pl-2 pr-2/);
  assert.doesNotMatch(html, /Waiting for the first recorded step/);
});

test('repeated runtime tool calls are grouped without dropping their results', () => {
  const event = (seq: number, kind: string, resultSummary?: string): ActivityEvent => ({
    seq,
    payload: {
      requestId: 'request',
      kind,
      status: kind === 'tool_started' ? 'running' : 'completed',
      tool: { name: 'search_codebase', arguments: { query: `query ${seq}` }, resultSummary },
    },
  });
  const steps = activitySteps([
    event(1, 'tool_started'), event(2, 'tool_completed', 'first result'),
    event(3, 'tool_started'), event(4, 'tool_completed', 'second result'),
  ]);

  assert.equal(steps.length, 1);
  assert.equal(steps[0].items?.length, 2);
  assert.deepEqual(steps[0].items?.map((item) => item.tool?.resultSummary), ['first result', 'second result']);
});

test('terminal requests stop formerly running activity rows', () => {
  const events: ActivityEvent[] = [{
    seq: 1,
    payload: {
      requestId: 'request',
      kind: 'tool_started',
      status: 'running',
      tool: { name: 'search_codebase', arguments: { query: 'pending' } },
    },
  }];

  for (const status of ['completed', 'cancelled', 'interrupted', 'failed'] as const) {
    const steps = activitySteps(events, status);
    assert.equal(steps[0].status, status);
    assert.equal(steps[0].items?.[0].status, status);
  }
});

test('restores a running background request after a browser refresh', () => {
  const restored = restoreActiveActivity(
    [{ id: 'user-1', role: 'user', text: 'Create the flow' }],
    { latest: { requestId: 'request-1', status: 'running' } },
  );
  const tail = restored.at(-1) as any;
  assert.equal(tail.kind, 'thinking');
  assert.equal(tail.activityRequestId, 'request-1');
  assert.equal(tail.label, 'Resuming background work...');

  assert.equal(restoreActiveActivity(restored, { latest: { requestId: 'request-1', status: 'running' } }).length, restored.length);
});

test('completed pipeline phases use their recorded terminal status', () => {
  const steps = activitySteps([{
    seq: 1,
    payload: {
      requestId: 'request',
      kind: 'progress',
      status: 'completed',
      label: 'CoverageScout completed',
    },
  }]);

  assert.equal(steps[0].status, 'completed');
});

test('legacy completed phase labels stay completed when a restarted server interrupts the request', () => {
  const steps = activitySteps([{
    seq: 1,
    payload: {
      requestId: 'request',
      kind: 'progress',
      status: 'running',
      label: 'CoverageScout completed',
    },
  }], 'interrupted');

  assert.equal(steps[0].status, 'completed');
});

test('execution token total equals the visible token categories', () => {
  const html = renderToStaticMarkup(<MessageMeta execution={{ promptTokens: 2136, completionTokens: 75, totalTokens: 51107 }} />);
  assert.match(html, /2,211 tokens/);
  assert.doesNotMatch(html, /51,107 tokens/);
});
