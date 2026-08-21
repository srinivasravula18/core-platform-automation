import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../../server/shared/storage';
import { beginTurnActivity, completeTurnActivity, listTurnActivity, recordTurnActivity } from '../../server/features/controller/turnActivity';

test('cache lookup and hit remain visible in workflow activity', async () => {
  const previous = process.env.DISABLE_POSTGRES;
  process.env.DISABLE_POSTGRES = 'true';
  const conversationId = `cache-activity-${Date.now()}`;
  const requestId = `${conversationId}-request`;
  try {
    await beginTurnActivity({ conversationId, requestId, ownerId: 'user-a' });
    await recordTurnActivity(requestId, 'cache_lookup', { label: 'Checking reusable agent work' });
    await recordTurnActivity(requestId, 'cache_hit', { label: 'Reused validated cached result', cache: { status: 'hit', ageMs: 20 } });
    await completeTurnActivity(requestId);
    const snapshot = await listTurnActivity(conversationId);
    assert.deepEqual(snapshot.events.map((event) => event.payload.kind), ['queued', 'cache_lookup', 'cache_hit', 'completed']);
  } finally {
    db.conversationSessions = db.conversationSessions.filter((row: any) => row.conversation_id !== conversationId);
    db.conversationSessionEvents = db.conversationSessionEvents.filter((row: any) => row.conversation_id !== conversationId);
    if (previous === undefined) delete process.env.DISABLE_POSTGRES;
    else process.env.DISABLE_POSTGRES = previous;
  }
});

