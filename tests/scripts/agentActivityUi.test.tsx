import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentActivity, activitySteps, type ActivityEvent } from '../../src/components/AgentActivity';

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
