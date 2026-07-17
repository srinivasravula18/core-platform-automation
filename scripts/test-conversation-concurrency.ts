/**
 * Phase 7 — conversation concurrency + security: simultaneous turns, duplicate
 * clientMessageId under race, run completion racing a question, out-of-order/duplicate
 * run projections, and cross-owner isolation semantics.
 *
 * Convention: standalone tsx script. JSON mode (single process, same observable
 * semantics; PG adds advisory locks on top — see plan §27).
 */

// Hermetic: dotenv (override:true) can restore DATABASE_URL mid-import — DISABLE_POSTGRES wins.
process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGUSER;
delete process.env.PGDATABASE;

const { CanonicalMessages, ConversationSessions } = await import('../core/persistence');
const { foldAndCommit, projectRunLifecycle } = await import('../services/runtime/src/application/sessionProjector');
const { sessionContextManager } = await import('../services/runtime/src/application/sessionContextManager');
const { ownerMismatch } = await import('../server/shared/scope');
const { ChatConversations } = await import('../server/db/repository');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. Concurrent message appends: unique gapless sequence ─────────────────────────────
{
  console.log('1. concurrent appends');
  const id = 'conv-cc-appends';
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    CanonicalMessages.append({ conversationId: id, role: 'user', content: `message ${i}` })));
  const seqs = results.map((r) => r.message.seq).sort((a, b) => a - b);
  check('10 messages, unique seqs 1..10', JSON.stringify(seqs) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), JSON.stringify(seqs));
  check('unique message ids', new Set(results.map((r) => r.message.messageId)).size === 10);
}

// ── 2. Duplicate clientMessageId under race ─────────────────────────────────────────────
{
  console.log('2. clientMessageId race');
  const id = 'conv-cc-dupe';
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    CanonicalMessages.append({ conversationId: id, clientMessageId: 'same-client-id', role: 'user', content: 'once' })));
  const stored = await CanonicalMessages.list(id);
  check('only one row stored', stored.length === 1, `count=${stored.length}`);
  check('all callers got the same message', new Set(results.map((r) => r.message.messageId)).size === 1);
  check('later callers marked deduplicated', results.filter((r) => r.deduplicated).length === 4, JSON.stringify(results.map((r) => r.deduplicated)));
}

// ── 3. Concurrent session commits: no lost events, monotonic version ────────────────────
{
  console.log('3. concurrent session commits');
  const id = 'conv-cc-session';
  await sessionContextManager.startSession({ conversationId: id, ownerId: 'u1' });
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    foldAndCommit({ conversationId: id, events: [{ eventType: 'DecisionRecorded', payload: { decision: { id: `d${i}`, summary: `decision ${i}`, createdAt: new Date().toISOString() } }, sourceKey: `cc:d${i}` }] })));
  const events = await ConversationSessions.listEvents(id);
  check('all 8 events landed exactly once', events.filter((e: any) => e.sourceKey.startsWith('cc:')).length === 8);
  check('event seq strictly increasing', events.every((e: any, i: number) => i === 0 || e.seq > events[i - 1].seq));
  const session = await sessionContextManager.getSession(id, { reconcile: false });
  check('all decisions in snapshot', session.recentDecisions.length === 8, `count=${session.recentDecisions.length}`);
}

// ── 4. Run completion racing a selection change ─────────────────────────────────────────
{
  console.log('4. run completion vs selection race');
  const id = 'conv-cc-race';
  await sessionContextManager.startSession({ conversationId: id, ownerId: 'u1' });
  const run = {
    id: 'AGENT-CC-1', status: 'completed', conversationId: id, ownerId: 'u1',
    generated_cases: [{ id: 'TC-CC-1', title: 'Race case' }],
    execution_result: { ok: true, total: 1, passed: 1, failed: 0, tests: [{ title: 'Race case', status: 'passed' }] },
  };
  await Promise.all([
    projectRunLifecycle({ conversationId: id, run, phase: 'completed' }),
    sessionContextManager.selectEntity(id, { type: 'defect', id: 'DEF-CC-1' }),
  ]);
  const session = await sessionContextManager.getSession(id, { reconcile: false });
  check('both writers survived', session.latestRun?.id === 'AGENT-CC-1' && session.currentSelectedEntity?.id === 'DEF-CC-1',
    JSON.stringify({ latestRun: session.latestRun, selected: session.currentSelectedEntity }));
}

// ── 5. Out-of-order + duplicate run projections ─────────────────────────────────────────
{
  console.log('5. projection ordering safety');
  const id = 'conv-cc-order';
  await sessionContextManager.startSession({ conversationId: id, ownerId: 'u1' });
  const run = { id: 'AGENT-CC-2', status: 'completed', conversationId: id, ownerId: 'u1', generated_cases: [], execution_result: { ok: true, total: 0, passed: 0, failed: 0, tests: [] } };
  await projectRunLifecycle({ conversationId: id, run, phase: 'completed' });
  // A late "started" (out-of-order delivery) must not regress terminal state.
  const late = await projectRunLifecycle({ conversationId: id, run: { ...run, status: 'running' }, phase: 'started' });
  const session = await sessionContextManager.getSession(id, { reconcile: false });
  check('late started ignored', late.projected === false);
  check('terminal state not regressed', session.currentExecution === null && session.latestRun?.id === 'AGENT-CC-2');
  const dup = await projectRunLifecycle({ conversationId: id, run, phase: 'completed' });
  check('duplicate completion ignored', dup.projected === false);
}

// ── 6. Cross-owner isolation semantics ──────────────────────────────────────────────────
{
  console.log('6. tenant isolation helper + conversation ownership');
  check('other owner mismatches', ownerMismatch({ ownerId: 'alice' }, { projectId: '', appId: null, userId: 'bob' } as any) === true);
  check('own row passes', ownerMismatch({ ownerId: 'bob' }, { projectId: '', appId: null, userId: 'bob' } as any) === false);
  check('legacy unowned row passes', ownerMismatch({ ownerId: '' }, { projectId: '', appId: null, userId: 'bob' } as any) === false);
  check('unauthenticated caller passes', ownerMismatch({ ownerId: 'alice' }, { projectId: '', appId: null, userId: '' } as any) === false);

  await ChatConversations.upsert({ id: 'conv-cc-owned', workspaceId: 'default', title: 'mine', turns: [], ownerId: 'alice' });
  const stored = await ChatConversations.get('conv-cc-owned');
  check('conversation carries ownerId', stored?.ownerId === 'alice');
  const again = await ChatConversations.upsert({ id: 'conv-cc-owned', workspaceId: 'default', title: 'renamed', turns: [], ownerId: 'mallory' });
  check('ownership is not silently transferable', again?.ownerId === 'alice', JSON.stringify(again?.ownerId));
}

console.log(failures === 0 ? '\nAll conversation-concurrency checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
