/**
 * Conversational Runtime Phase 1 — persistence foundation tests.
 *
 * Covers the additive session/event/entity-ref/canonical-message repositories and the
 * AgentRuns conversation-scoped reads (docs/diagnostics/conversational-intelligence-
 * runtime-architecture-plan-2026-07-17.md, Phase 1).
 *
 * Convention: standalone tsx script, no jest/vitest (see test-evidence-registry.ts). Run with:
 *   npx tsx scripts/test-conversation-persistence.ts   (or: npm run test:conversation-persistence)
 * Exits 0 if all pass, 1 otherwise.
 *
 * Runs against the in-memory store by default (PG env cleared before imports) so it is
 * deterministic and needs no database. Set TEST_PG_URL to additionally verify the schema
 * applies idempotently against a real PostgreSQL.
 */

const TEST_PG_URL = process.env.TEST_PG_URL || '';

// Force the in-memory backend before any server import evaluates isPgEnabled().
// Hermetic: dotenv (override:true) can restore DATABASE_URL mid-import — DISABLE_POSTGRES wins.
process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGUSER;
delete process.env.PGDATABASE;

const {
  ConversationSessions,
  ConversationEntityRefs,
  CanonicalMessages,
  AgentRuns,
} = await import('../core/persistence');
const { ChatConversations } = await import('../server/db/repository');
const { sessionRepository, canonicalMessages, entityRefIndex, runReader } = await import(
  '../services/runtime/src/adapters/sessionRepository'
);

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 1. Session snapshot: create, version, state round trip ──────────────────────────────
{
  console.log('1. session snapshot commit + read');
  const id = 'conv-persist-session';
  const state = { schemaVersion: 1, conversationId: id, latestRun: { type: 'run', id: 'AGENT-1' } };
  const first = await ConversationSessions.commit({
    conversationId: id, ownerId: 'user-1', workspaceId: 'default', projectId: 'proj-1', state,
    events: [{ eventType: 'ConversationStarted', sourceKey: `${id}:started` }],
  });
  check('commit succeeds', first.ok === true);
  check('version becomes 1', first.ok && first.session.version === 1, JSON.stringify(first));
  check('one event appended', first.ok && first.appendedEvents === 1);

  const loaded = await ConversationSessions.get(id);
  check('get returns snapshot', !!loaded && loaded.version === 1);
  check('state round trips', loaded?.state?.latestRun?.id === 'AGENT-1');
  check('scope persisted', loaded?.ownerId === 'user-1' && loaded?.projectId === 'proj-1');
}

// ── 2. Optimistic concurrency ───────────────────────────────────────────────────────────
{
  console.log('2. optimistic version conflict');
  const id = 'conv-persist-session';
  const stale = await ConversationSessions.commit({ conversationId: id, state: {}, expectedVersion: 0 });
  check('stale expectedVersion conflicts', stale.ok === false && (stale as any).conflict === true);
  check('conflict reports current version', !stale.ok && (stale as any).currentVersion === 1);

  const fresh = await ConversationSessions.commit({
    conversationId: id, state: { schemaVersion: 1, note: 'v2' }, expectedVersion: 1,
  });
  check('matching expectedVersion commits', fresh.ok === true && fresh.ok && fresh.session.version === 2);
}

// ── 3. Idempotent event projection (source_key) ─────────────────────────────────────────
{
  console.log('3. source_key idempotency');
  const id = 'conv-persist-events';
  const event = { eventType: 'RunCompleted', payload: { runId: 'AGENT-9' }, sourceKey: 'AGENT-9:1:completed' };
  const a = await ConversationSessions.commit({ conversationId: id, events: [event] });
  const b = await ConversationSessions.commit({ conversationId: id, events: [event] });
  check('first delivery appends', a.ok && a.appendedEvents === 1);
  check('duplicate delivery is ignored', b.ok && b.appendedEvents === 0);
  const versionAfter = (await ConversationSessions.get(id))?.version;
  check('pure-duplicate commit does not bump version', versionAfter === 1, `version=${versionAfter}`);

  await ConversationSessions.commit({
    conversationId: id,
    events: [
      { eventType: 'RunStarted', sourceKey: 'AGENT-10:start' },
      { eventType: 'RunCompleted', sourceKey: 'AGENT-10:done' },
    ],
  });
  const events = await ConversationSessions.listEvents(id);
  check('events are seq-ordered', events.length === 3 && events.every((e: any, i: number) => e.seq === i + 1));
  const since = await ConversationSessions.listEvents(id, 1);
  check('listEvents honors sinceSeq', since.length === 2 && since[0].seq === 2);
}

// ── 4. Canonical messages: seq, message_id, client idempotency ──────────────────────────
{
  console.log('4. canonical message append');
  const id = 'conv-persist-msgs';
  const first = await CanonicalMessages.append({
    conversationId: id, clientMessageId: 'client-1', role: 'user', content: 'Why did they fail?',
    entityRefs: [{ type: 'run', id: 'AGENT-1' }], correlationId: 'req-1',
  });
  check('append returns message', first.message.seq === 1 && first.deduplicated === false);
  check('message_id is deterministic', first.message.messageId === `${id}:1`);

  const dup = await CanonicalMessages.append({
    conversationId: id, clientMessageId: 'client-1', role: 'user', content: 'Why did they fail? (retry)',
  });
  check('duplicate clientMessageId dedupes', dup.deduplicated === true);
  check('dedupe returns the original body', dup.message.content === 'Why did they fail?');

  const second = await CanonicalMessages.append({
    conversationId: id, role: 'assistant', kind: 'text', content: 'Grounded answer.', causationId: `${id}:1`,
  });
  check('seq increments', second.message.seq === 2);

  const all = await CanonicalMessages.list(id);
  check('list returns ordered transcript', all.length === 2 && all[0].seq === 1 && all[1].seq === 2);
  check('entity refs round trip', all[0].entityRefs?.[0]?.id === 'AGENT-1');
  const paged = await CanonicalMessages.list(id, { beforeSeq: 2 });
  check('beforeSeq pagination works', paged.length === 1 && paged[0].seq === 1);

  const legacy = await ChatConversations.get(id);
  check('legacy conversation read still works', Array.isArray(legacy?.turns) && legacy.turns.length === 2);
}

// ── 5. Entity recency index ─────────────────────────────────────────────────────────────
{
  console.log('5. entity refs upsert + recency query');
  const id = 'conv-persist-refs';
  const a = await ConversationEntityRefs.upsert({
    conversationId: id, entityType: 'run', entityId: 'AGENT-1', relation: 'latest',
    sourceRunId: 'AGENT-1', salience: 2, metadata: { status: 'failed' },
  });
  const b = await ConversationEntityRefs.upsert({
    conversationId: id, entityType: 'run', entityId: 'AGENT-1', relation: 'latest',
    sourceRunId: 'AGENT-1', salience: 1, metadata: { revisit: true },
  });
  check('dedupe key returns the same row', a.id === b.id);
  check('salience keeps the max', b.salience === 2);
  check('metadata merges', b.metadata?.status === 'failed' && b.metadata?.revisit === true);

  await ConversationEntityRefs.upsert({ conversationId: id, entityType: 'test_case', entityId: 'TC-1', relation: 'failed', sourceRunId: 'AGENT-1' });
  await ConversationEntityRefs.upsert({ conversationId: id, entityType: 'test_case', entityId: 'TC-2', relation: 'failed', sourceRunId: 'AGENT-1' });
  await ConversationEntityRefs.upsert({ conversationId: id, entityType: 'test_case', entityId: 'TC-1', relation: 'generated', sourceRunId: 'AGENT-1' });

  const failed = await ConversationEntityRefs.list(id, { entityType: 'test_case', relation: 'failed' });
  check('type+relation filter works', failed.length === 2 && failed.every((r: any) => r.entityType === 'test_case'));
  const everything = await ConversationEntityRefs.list(id);
  check('unfiltered list returns all refs', everything.length === 4);
  check('rows are recency-ordered', everything.every((r: any, i: number, arr: any[]) =>
    i === 0 || String(arr[i - 1].lastSeenAt) >= String(r.lastSeenAt)));
}

// ── 6. AgentRuns: conversation columns + scoped reads ───────────────────────────────────
{
  console.log('6. agent runs conversation-scoped reads');
  const conversationId = 'conv-persist-runs';
  await AgentRuns.upsert({
    id: 'AGENT-RUN-A', status: 'completed', conversationId, ownerId: 'user-1', projectId: 'proj-1',
    execution_result: { ok: false, total: 2, passed: 1, failed: 1, tests: [{ title: 'login', status: 'failed', error: 'timeout' }] },
    completed_at: '2026-07-17T10:00:00.000Z', created_at: '2026-07-17T09:00:00.000Z',
  });
  await AgentRuns.upsert({
    id: 'AGENT-RUN-B', status: 'running', conversationId, ownerId: 'user-1', projectId: 'proj-1',
    created_at: '2026-07-17T11:00:00.000Z',
  });
  await AgentRuns.upsert({ id: 'AGENT-RUN-OTHER', status: 'completed', conversationId: 'conv-unrelated' });

  const linked = await AgentRuns.listByConversation(conversationId);
  check('listByConversation scopes to the conversation', linked.length === 2 && linked.every((r: any) => r.conversationId === conversationId));
  check('newest first', linked[0]?.id === 'AGENT-RUN-B', `first=${linked[0]?.id}`);

  const latestAny = await AgentRuns.latestByConversation(conversationId);
  const latestTerminal = await AgentRuns.latestByConversation(conversationId, { terminal: true });
  check('latest includes running runs', latestAny?.id === 'AGENT-RUN-B');
  check('terminal filter skips running runs', latestTerminal?.id === 'AGENT-RUN-A');
  check('execution_result survives round trip', latestTerminal?.execution_result?.tests?.[0]?.error === 'timeout');

  const scopedHit = await AgentRuns.getScoped('AGENT-RUN-A', { ownerId: 'user-1' });
  const scopedMiss = await AgentRuns.getScoped('AGENT-RUN-A', { ownerId: 'someone-else' });
  check('getScoped matches owner', scopedHit?.id === 'AGENT-RUN-A');
  check('getScoped rejects cross-owner', scopedMiss === null);
}

// ── 7. Runtime adapter chain (ports → core/persistence) ─────────────────────────────────
{
  console.log('7. services/runtime adapters delegate correctly');
  const id = 'conv-persist-adapter';
  const commit = await sessionRepository.commit({
    conversationId: id, workspaceId: 'default',
    events: [{ eventType: 'ConversationStarted', sourceKey: `${id}:started` }],
  });
  check('adapter session commit works', commit.ok === true);
  const session = await sessionRepository.get(id);
  check('adapter session read works', session?.version === 1);

  const appended = await canonicalMessages.append({ conversationId: id, role: 'user', content: 'hello runtime' });
  check('adapter message append maps to domain shape', appended.message.sequence === 1 && appended.message.id === `${id}:1`);
  const listed = await canonicalMessages.list(id);
  check('adapter message list works', listed.length === 1 && listed[0].content === 'hello runtime');

  await entityRefIndex.upsert({ conversationId: id, entityType: 'run', entityId: 'AGENT-RUN-A', relation: 'mentioned' });
  const refs = await entityRefIndex.list(id);
  check('adapter entity index works', refs.length === 1 && refs[0].entityId === 'AGENT-RUN-A');

  const latest = await runReader.latestByConversation('conv-persist-runs', { terminal: true });
  check('adapter run reader works', latest?.id === 'AGENT-RUN-A');
}

// ── 8. PostgreSQL schema idempotency (opt-in via TEST_PG_URL) ───────────────────────────
if (TEST_PG_URL) {
  console.log('8. PG schema applies twice (TEST_PG_URL set)');
  const { Client } = await import('pg');
  const fs = await import('fs/promises');
  const path = await import('path');
  const sql = await fs.readFile(path.resolve(process.cwd(), 'server/db/schema.sql'), 'utf-8');
  const client = new Client({ connectionString: TEST_PG_URL });
  await client.connect();
  try {
    await client.query(sql);
    await client.query(sql);
    check('schema.sql is idempotent', true);
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN
       ('conversation_sessions','conversation_session_events','conversation_entity_refs')`,
    );
    check('phase-1 tables exist', tables.rows.length === 3);
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_runs' AND column_name IN
       ('conversation_id','execution_result','completed_at','artifact_set_id')`,
    );
    check('agent_runs first-class columns exist', cols.rows.length === 4);
  } catch (err: any) {
    check('schema applies against PG', false, err?.message || String(err));
  } finally {
    await client.end();
  }
} else {
  console.log('8. PG schema idempotency skipped (set TEST_PG_URL to enable)');
}

console.log(failures === 0 ? '\nAll conversation-persistence checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
