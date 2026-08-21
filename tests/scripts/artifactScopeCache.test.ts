import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../../server/shared/storage';
import { fetchArtifact, rememberToolResult, searchConversationMemory } from '../../server/ai/memory/artifactMemory';

test('reuses tool evidence across chats only inside the same authorized scope', async () => {
  const previous = process.env.DISABLE_POSTGRES;
  process.env.DISABLE_POSTGRES = 'true';
  db.conversationArtifacts = [];
  try {
    const artifact = await rememberToolResult({
    conversationId: 'chat-a', workspaceId: 'workspace-a', ownerId: 'user-a', projectId: 'project-a', appId: 'app-a',
    toolName: 'query_metadata', arguments: { query: 'accounts' }, result: { count: 3 },
  });
  assert.ok(artifact?.id);

  const allowed = await searchConversationMemory('chat-b', 'count', 20, {
    conversationId: 'chat-b', workspaceId: 'workspace-a', userId: 'user-a', projectId: 'project-a', appId: 'app-a',
  });
  assert.ok(allowed.some((item) => item.ref === artifact!.id));
  const fetched = await fetchArtifact(artifact!.id, {
    conversationId: 'chat-b', workspaceId: 'workspace-a', userId: 'user-a', projectId: 'project-a', appId: 'app-a',
  });
  assert.deepEqual(fetched.body, { count: 3 });

  const denied = await searchConversationMemory('chat-c', 'count', 20, {
    conversationId: 'chat-c', workspaceId: 'workspace-a', userId: 'user-b', projectId: 'project-a', appId: 'app-a',
  });
  assert.equal(denied.some((item) => item.ref === artifact!.id), false);
    await assert.rejects(() => fetchArtifact(artifact!.id, {
      conversationId: 'chat-c', workspaceId: 'workspace-a', userId: 'user-b', projectId: 'project-a', appId: 'app-a',
    }), /authorized scope/);
  } finally {
    if (previous === undefined) delete process.env.DISABLE_POSTGRES;
    else process.env.DISABLE_POSTGRES = previous;
  }
});
