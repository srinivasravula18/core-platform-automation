/**
 * Phase 5 — end-to-end conversational runtime: full in-memory turn sequence
 * (generate → run → "Why did they fail?") through the real coordinator with a fake
 * provider, asserting evidence-first assembly, event stream, clarification path,
 * message persistence, and manifest traceability.
 *
 * Convention: standalone tsx script. JSON mode; the LLM is stubbed (no keys needed).
 */

// Hermetic: dotenv (override:true) can restore DATABASE_URL mid-import — DISABLE_POSTGRES wins.
process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGUSER;
delete process.env.PGDATABASE;

const { runConversationTurn } = await import('../services/runtime/src/application/conversationalRuntime');
const { sessionContextManager } = await import('../services/runtime/src/application/sessionContextManager');
const { projectRunLifecycle } = await import('../services/runtime/src/application/sessionProjector');
const { canonicalMessages } = await import('../services/runtime/src/adapters/sessionRepository');
const { AgentRuns } = await import('../core/persistence');
const { db } = await import('../server/shared/storage');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const conversationId = 'conv-runtime-e2e';
const scope = { workspaceId: 'default', ownerId: 'u1', projectId: 'p1', appId: null };
const captured: Array<{ systemContract: string; task: string; capability: string }> = [];
const fakeInvoke = async (input: any) => {
  captured.push({ systemContract: input.systemContract, task: input.task, capability: input.capability });
  return `Grounded diagnostic answer for ${input.capability}.`;
};

await sessionContextManager.startSession({ conversationId, ownerId: 'u1', projectId: 'p1' });

// Seed the exact forensic prerequisite: a completed conversation-linked run with failures.
const run = {
  id: 'AGENT-E2E-1', status: 'completed', conversationId, ownerId: 'u1', projectId: 'p1',
  generated_cases: [{ id: 'TC-X1', title: 'List loads' }, { id: 'TC-X2', title: 'List filters' }],
  playwright_scripts: [{ id: 'SC-X1', title: 'List loads' }, { id: 'SC-X2', title: 'List filters' }],
  evidence_screenshots: [{ url: '/evidence/e2e-shot.png' }],
  execution_result: {
    ok: false, total: 2, passed: 1, failed: 1,
    tests: [
      { title: 'List loads', status: 'passed', durationMs: 900 },
      { title: 'List filters', status: 'failed', durationMs: 1100, error: 'expected 3 rows, saw 0 — grid never refreshed' },
    ],
  },
  completed_at: '2026-07-17T10:00:00.000Z',
};
await AgentRuns.upsert(run);
await projectRunLifecycle({ conversationId, run, phase: 'completed' });

// ── 1. The forensic question ────────────────────────────────────────────────────────────
{
  console.log('1. "Why did they fail?" end to end');
  const events: string[] = [];
  const result = await runConversationTurn({
    conversationId,
    message: 'Why did they fail?',
    clientMessageId: 'cli-1',
    scope,
    onEvent: (e) => events.push(e.type),
    invoke: fakeInvoke,
  });
  check('capability is run_diagnostics', result.capability === 'run_diagnostics', result.capability);
  check('not a clarification', result.clarification === false);
  check('resolved failed case from the run', result.resolvedEntities.some((e) => e.id === 'TC-X2'), JSON.stringify(result.resolvedEntities));
  check('evidence refs cite the run', result.evidenceRefs.some((r) => r.includes('AGENT-E2E-1')), JSON.stringify(result.evidenceRefs.slice(0, 4)));
  check('no evidence gaps', result.evidenceGaps.length === 0, JSON.stringify(result.evidenceGaps));
  check('manifest recorded', result.manifestId.startsWith('CTX-'));
  check('event stream complete', ['session_loaded', 'references_resolved', 'capability_selected', 'evidence_collected', 'plan_ready', 'answer_delta', 'final'].every((t) => events.includes(t)), events.join(','));

  const invocation = captured.at(-1)!;
  check('observed evidence in task', invocation.task.includes('[OBSERVED'));
  check('real error detail in task', invocation.task.includes('grid never refreshed'));
  check('evidence-authority contract in system', invocation.systemContract.includes('AUTHORITATIVE'));
  check('code-only contract is gone', !invocation.systemContract.toLowerCase().includes('only in its real source code'));
}

// ── 2. Persistence: canonical messages closed the loop ─────────────────────────────────
{
  console.log('2. transcript + idempotency');
  const messages = await canonicalMessages.list(conversationId);
  check('user + assistant messages persisted', messages.length === 2, `count=${messages.length}`);
  check('assistant message carries capability payload', (messages[1]?.payload as any)?.capability === 'run_diagnostics');
  check('assistant message carries evidence refs', (messages[1]?.artifactRefs?.length || 0) > 0);

  const retry = await runConversationTurn({
    conversationId, message: 'Why did they fail? (network retry)', clientMessageId: 'cli-1',
    scope, invoke: fakeInvoke,
  });
  const after = await canonicalMessages.list(conversationId);
  check('duplicate clientMessageId does not duplicate the user turn', after.filter((m) => m.role === 'user').length === 1, `users=${after.filter((m) => m.role === 'user').length}`);
  check('retry still answers', retry.answer.length > 0);
}

// ── 3. Clarification path (no provider call) ────────────────────────────────────────────
{
  console.log('3. ambiguous mutation → clarify without LLM');
  const convB = 'conv-runtime-ambig';
  await sessionContextManager.startSession({ conversationId: convB, ownerId: 'u1' });
  const { entityRefIndex } = await import('../services/runtime/src/adapters/sessionRepository');
  await entityRefIndex.upsert({ conversationId: convB, entityType: 'script', entityId: 'SC-A9', relation: 'failed', sourceRunId: 'AGENT-A', metadata: {} });
  await entityRefIndex.upsert({ conversationId: convB, entityType: 'defect', entityId: 'DEF-A9', relation: 'failed', sourceRunId: 'AGENT-B', metadata: {} });
  // Force identical recency so the two collections genuinely tie.
  for (const r of (db as any).conversationEntityRefs) if (r.conversation_id === convB) r.last_seen_at = '2026-07-17T12:00:00.000Z';

  const callsBefore = captured.length;
  const result = await runConversationTurn({ conversationId: convB, message: 'fix them', scope, invoke: fakeInvoke });
  check('clarification returned', result.clarification === true, JSON.stringify(result));
  check('clarification names the candidates', /SC-A9|DEF-A9|more than one/.test(result.answer), result.answer);
  check('no provider call for clarify', captured.length === callsBefore);
}

// ── 4. Diagnostics with no runs: honest gap answer path ─────────────────────────────────
{
  console.log('4. failure question with zero runs');
  const convC = 'conv-runtime-norun';
  await sessionContextManager.startSession({ conversationId: convC, ownerId: 'u1' });
  const result = await runConversationTurn({
    conversationId: convC, message: 'Why did my tests fail?', scope,
    invoke: async () => '',  // model returns nothing → runtime must produce the honest gap answer
  });
  check('gaps surfaced', result.evidenceGaps.length > 0, JSON.stringify(result.evidenceGaps));
  check('honest no-evidence answer', result.answer.includes('could not find the runtime evidence'), result.answer);
}

// ── 5. Request-context scope hints thread into the session ──────────────────────────────
{
  console.log('5. scope hint merge');
  const convD = 'conv-runtime-scope';
  await runConversationTurn({
    conversationId: convD, message: 'How does the list view work?', scope,
    requestContext: { projectId: 'p1', appId: 'app-admin', appName: 'Admin', pagePath: '/objects/list' },
    invoke: fakeInvoke,
  });
  const session = await sessionContextManager.getSession(convD, { reconcile: false });
  check('app hint merged', session.currentApp?.id === 'app-admin');
  check('page hint merged', session.currentPage?.path === '/objects/list');
}

console.log(failures === 0 ? '\nAll conversational-runtime checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
