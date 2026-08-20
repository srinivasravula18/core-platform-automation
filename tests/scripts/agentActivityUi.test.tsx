import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentActivity } from '../../src/components/AgentActivity';

test('activity timeline uses one bounded scroll region without an empty placeholder', () => {
  const html = renderToStaticMarkup(
    <AgentActivity conversationId="conversation" requestId="request" />,
  );
  assert.match(html, /max-h-\[min\(55vh,32rem\)\]/);
  assert.match(html, /overflow-y-auto/);
  assert.doesNotMatch(html, /Waiting for the first recorded step/);
});
