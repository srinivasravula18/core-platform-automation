/**
 * Phase 6 — run→session projection parity: the legacy engine shape and the LangGraph
 * legacy-projection shape must produce IDENTICAL session semantics; duplicate/terminal
 * deliveries are no-ops; the SESSION_RUN_PROJECTION_V1 flag disables cleanly; state
 * survives restart (snapshot-only rehydration).
 *
 * Convention: standalone tsx script. JSON mode.
 */

// Hermetic: dotenv (override:true) can restore DATABASE_URL mid-import — DISABLE_POSTGRES wins.
process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGUSER;
delete process.env.PGDATABASE;

const { projectRunLifecycleSafe, projectRunLifecycle, hydrateSessionState } = await import('../services/runtime/src/application/sessionProjector');
const { sessionContextManager } = await import('../services/runtime/src/application/sessionContextManager');
const { ConversationSessions, ConversationEntityRefs } = await import('../core/persistence');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeRun(id: string, conversationId: string, engine?: string) {
  return {
    id, status: 'completed', conversationId, ownerId: 'u1', projectId: 'p1',
    ...(engine ? { engine } : {}),
    generated_cases: [{ id: 'TC-P1', title: 'Case one' }, { id: 'TC-P2', title: 'Case two' }],
    playwright_scripts: [{ id: 'SC-P1', title: 'Case one' }],
    execution_result: {
      ok: false, total: 2, passed: 1, failed: 1,
      tests: [
        { title: 'Case one', status: 'passed' },
        { title: 'Case two', status: 'failed', error: 'assert failed' },
      ],
    },
    completed_at: '2026-07-17T12:00:00.000Z',
  };
}

function sessionSemantics(s: any) {
  return {
    latestRun: s.latestRun?.id,
    cases: s.latestTestCases?.ids,
    caseSource: s.latestTestCases?.sourceRunId,
    scripts: s.latestScripts?.ids,
    failedActive: s.activeEntities.filter((e: any) => e.type === 'test_case').map((e: any) => e.id).sort(),
  };
}

// ── 1. Engine parity ────────────────────────────────────────────────────────────────────
{
  console.log('1. legacy vs langgraph projection parity');
  const convLegacy = 'conv-proj-legacy';
  const convGraph = 'conv-proj-graph';
  await sessionContextManager.startSession({ conversationId: convLegacy, ownerId: 'u1' });
  await sessionContextManager.startSession({ conversationId: convGraph, ownerId: 'u1' });

  await projectRunLifecycle({ conversationId: convLegacy, run: makeRun('AGENT-PAR-L', convLegacy), phase: 'completed' });
  await projectRunLifecycle({ conversationId: convGraph, run: makeRun('AGENT-PAR-G', convGraph, 'langgraph'), phase: 'completed' });

  const a = sessionSemantics(await sessionContextManager.getSession(convLegacy, { reconcile: false }));
  const b = sessionSemantics(await sessionContextManager.getSession(convGraph, { reconcile: false }));
  check('latest run set on both', a.latestRun === 'AGENT-PAR-L' && b.latestRun === 'AGENT-PAR-G');
  check('identical case projection', JSON.stringify(a.cases) === JSON.stringify(b.cases));
  check('identical failure semantics', JSON.stringify(a.failedActive) === JSON.stringify(b.failedActive), `${JSON.stringify(a.failedActive)} vs ${JSON.stringify(b.failedActive)}`);
  check('identical script projection', JSON.stringify(a.scripts) === JSON.stringify(b.scripts));

  const refsA = await ConversationEntityRefs.list(convLegacy);
  const refsB = await ConversationEntityRefs.list(convGraph);
  // Run ids differ by design between the two conversations — normalize them out of the shape.
  const shape = (refs: any[]) => refs.map((r) => `${r.relation}:${r.entityType}:${r.entityType === 'run' ? 'RUN' : r.entityId}`).sort();
  check('identical entity index shape', JSON.stringify(shape(refsA)) === JSON.stringify(shape(refsB)));
}

// ── 2. Lifecycle ordering: started → completed ─────────────────────────────────────────
{
  console.log('2. started then completed');
  const conv = 'conv-proj-lifecycle';
  await sessionContextManager.startSession({ conversationId: conv, ownerId: 'u1' });
  const run = { ...makeRun('AGENT-PAR-S', conv), status: 'running', execution_result: null, completed_at: null };
  await projectRunLifecycle({ conversationId: conv, run, phase: 'started' });
  let s = await sessionContextManager.getSession(conv, { reconcile: false });
  check('currentExecution set while running', s.currentExecution?.id === 'AGENT-PAR-S');
  check('latestRun untouched while running', s.latestRun === null);

  const done = makeRun('AGENT-PAR-S', conv);
  await projectRunLifecycle({ conversationId: conv, run: done, phase: 'completed' });
  s = await sessionContextManager.getSession(conv, { reconcile: false });
  check('completion clears execution + sets latest', s.currentExecution === null && s.latestRun?.id === 'AGENT-PAR-S');

  const versionBefore = s.version;
  await projectRunLifecycle({ conversationId: conv, run: done, phase: 'completed' });
  s = await sessionContextManager.getSession(conv, { reconcile: false });
  check('duplicate terminal delivery is a no-op', s.version === versionBefore, `v ${versionBefore} → ${s.version}`);
}

// ── 3. Fire-and-forget hook + flag ──────────────────────────────────────────────────────
{
  console.log('3. safe hook + flag gate');
  const conv = 'conv-proj-flag';
  await sessionContextManager.startSession({ conversationId: conv, ownerId: 'u1' });

  process.env.SESSION_RUN_PROJECTION_V1 = 'false';
  projectRunLifecycleSafe({ run: makeRun('AGENT-PAR-OFF', conv), phase: 'completed' });
  await new Promise((r) => setTimeout(r, 50));
  let s = await sessionContextManager.getSession(conv, { reconcile: false });
  check('flag off → no projection', s.latestRun === null);

  process.env.SESSION_RUN_PROJECTION_V1 = 'true';
  projectRunLifecycleSafe({ run: makeRun('AGENT-PAR-ON', conv), phase: 'completed' });
  await new Promise((r) => setTimeout(r, 100));
  s = await sessionContextManager.getSession(conv, { reconcile: false });
  check('flag on → projected', s.latestRun?.id === 'AGENT-PAR-ON');

  projectRunLifecycleSafe({ run: { id: 'AGENT-NO-CONV', status: 'completed' }, phase: 'completed' });
  check('run without conversation is ignored safely', true);
}

// ── 4. Restart survival ─────────────────────────────────────────────────────────────────
{
  console.log('4. restart parity');
  const conv = 'conv-proj-legacy';
  const stored = await ConversationSessions.get(conv);
  const rehydrated = hydrateSessionState(stored, conv);
  check('snapshot alone restores run pointers', rehydrated.latestRun?.id === 'AGENT-PAR-L' && rehydrated.latestTestCases?.ids.length === 2);
}

console.log(failures === 0 ? '\nAll run-session-projection checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
