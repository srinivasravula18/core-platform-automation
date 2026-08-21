import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../../server/shared/storage';
import { ConversationSessions } from '../../server/db/repository';
import {
  beginTurnActivity,
  cancelTurnActivity,
  completeTurnActivity,
  finishRunActivity,
  listTurnActivity,
  recordTurnActivity,
} from '../../server/features/controller/turnActivity';

function unique(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanup(conversationId: string) {
  db.conversationSessions = db.conversationSessions.filter((row: any) => row.conversation_id !== conversationId);
  db.conversationSessionEvents = db.conversationSessionEvents.filter((row: any) => row.conversation_id !== conversationId);
}

test('persists ordered, redacted activity through completion', async () => {
  const conversationId = unique('activity-complete');
  const requestId = unique('request');
  try {
    await beginTurnActivity({ conversationId, requestId });
    await recordTurnActivity(requestId, 'tool_started', {
      label: 'Running query_workspace',
      tool: { name: 'query_workspace', arguments: { query: 'runs', token: 'secret-value' } },
    });
    await recordTurnActivity(requestId, 'tool_completed', {
      label: 'Completed query_workspace',
      tool: { name: 'query_workspace', resultSummary: '1 run', ms: 8 },
    });
    await completeTurnActivity(requestId, { label: 'Request completed' });
    const snapshot = await listTurnActivity(conversationId);
    assert.deepEqual(snapshot.events.map((event) => event.payload.kind), ['queued', 'tool_started', 'tool_completed', 'completed']);
    assert.equal(snapshot.latest?.status, 'completed');
    assert.equal(snapshot.events[1].payload.tool.arguments.token, '[REDACTED]');
  } finally { cleanup(conversationId); }
});

test('persists runtime-derived progress without synthetic routing steps', async () => {
  const conversationId = unique('activity-progress');
  const requestId = unique('request');
  try {
    await beginTurnActivity({ conversationId, requestId });
    await recordTurnActivity(requestId, 'agent_started', { label: 'Planning code research for Shockwave' });
    await recordTurnActivity(requestId, 'progress', { label: 'Reading 7 relevant files in depth' });
    await completeTurnActivity(requestId);
    const snapshot = await listTurnActivity(conversationId);
    assert.deepEqual(snapshot.events.map((event) => event.payload.kind), ['queued', 'agent_started', 'progress', 'completed']);
    assert.equal(snapshot.events[1].payload.label, 'Planning code research for Shockwave');
  } finally { cleanup(conversationId); }
});

test('an observer disappearing does not cancel the active request', async () => {
  const conversationId = unique('activity-detach');
  const requestId = unique('request');
  try {
    const activity = await beginTurnActivity({ conversationId, requestId });
    assert.equal(activity.signal.aborted, false);
    assert.equal((await listTurnActivity(conversationId)).latest?.status, 'running');
    await completeTurnActivity(requestId);
    assert.equal((await listTurnActivity(conversationId)).latest?.status, 'completed');
  } finally { cleanup(conversationId); }
});

test('explicit cancellation aborts execution and is persisted', async () => {
  const conversationId = unique('activity-cancel');
  const requestId = unique('request');
  try {
    const activity = await beginTurnActivity({ conversationId, requestId });
    assert.equal(await cancelTurnActivity(conversationId, requestId), true);
    assert.equal(activity.signal.aborted, true);
    assert.equal((await listTurnActivity(conversationId)).latest?.status, 'cancelled');
  } finally { cleanup(conversationId); }
});

test('orphaned running activity is reconciled as interrupted', async () => {
  const conversationId = unique('activity-interrupted');
  const requestId = unique('request');
  try {
    await ConversationSessions.commit({
      conversationId,
      events: [{
        eventType: 'TurnActivity',
        payload: { requestId, kind: 'queued', status: 'running', at: new Date().toISOString() },
        sourceKey: `turn:${requestId}:1:queued`,
        correlationId: requestId,
      }],
    });
    const snapshot = await listTurnActivity(conversationId, 1);
    assert.equal(snapshot.latest?.status, 'interrupted');
    assert.deepEqual(snapshot.events.map((event) => event.payload.kind), ['interrupted']);
  } finally { cleanup(conversationId); }
});

test('rejects unsafe request ids before persistence', async () => {
  const conversationId = unique('activity-invalid');
  try {
    await assert.rejects(beginTurnActivity({ conversationId, requestId: 'bad/request/id' }), /requestId is invalid/);
    assert.equal((await ConversationSessions.listEvents(conversationId)).length, 0);
  } finally { cleanup(conversationId); }
});

test('a terminal graph projection also completes its parent chat activity', async () => {
  const conversationId = unique('activity-graph');
  const requestId = unique('request');
  try {
    await beginTurnActivity({ conversationId, requestId });
    await finishRunActivity({ conversationId, activityRequestId: requestId, status: 'completed' });
    assert.equal((await listTurnActivity(conversationId)).latest?.status, 'completed');
  } finally { cleanup(conversationId); }
});

test('a graph review pause also completes its parent chat activity', async () => {
  const conversationId = unique('activity-review');
  const requestId = unique('request');
  try {
    await beginTurnActivity({ conversationId, requestId });
    await finishRunActivity({ conversationId, activityRequestId: requestId, status: 'review_required' });
    const snapshot = await listTurnActivity(conversationId);
    assert.equal(snapshot.latest?.status, 'completed');
    assert.equal(snapshot.events.at(-1)?.payload?.label, 'Waiting for your review');
  } finally { cleanup(conversationId); }
});
