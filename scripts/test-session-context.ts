/**
 * Phase 2 — Session Context Manager tests: aggregate invariants, event projection,
 * command/versioning behavior, run projection idempotency, and restart survival.
 *
 * Convention: standalone tsx script (see test-conversation-persistence.ts). JSON mode.
 */

// Hermetic: dotenv (override:true) can restore DATABASE_URL mid-import — DISABLE_POSTGRES wins.
process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGUSER;
delete process.env.PGDATABASE;

const { createInitialSession, applySessionEvent, validateSessionInvariants } = await import('../services/runtime/src/domain/session');
const { sessionContextManager } = await import('../services/runtime/src/application/sessionContextManager');
const { projectRunLifecycle, hydrateSessionState } = await import('../services/runtime/src/application/sessionProjector');
const { ConversationSessions, ConversationEntityRefs, AgentRuns } = await import('../core/persistence');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. Pure aggregate projections ───────────────────────────────────────────────────────
{
  console.log('1. pure event projections');
  let s = createInitialSession({ conversationId: 'c1', ownerId: 'u1', projectId: 'p1' });
  check('initial invariants hold', validateSessionInvariants(s).length === 0);

  s = applySessionEvent(s, 'EntitySelected', { entity: { type: 'test_suite', id: 'SUITE-1', label: 'Smoke' } });
  check('selection sets selected entity', s.currentSelectedEntity?.id === 'SUITE-1');
  check('selection sets matching pointer', s.currentTestSuite?.id === 'SUITE-1');
  check('selection touches active entities', s.activeEntities[0]?.id === 'SUITE-1');

  s = applySessionEvent(s, 'RunStarted', { runRef: { type: 'run', id: 'AGENT-1' } });
  check('run start sets currentExecution', s.currentExecution?.id === 'AGENT-1');

  s = applySessionEvent(s, 'RunCompleted', {
    runRef: { type: 'run', id: 'AGENT-1' }, status: 'completed',
    caseRefs: [{ type: 'test_case', id: 'TC-1', label: 'Login works' }, { type: 'test_case', id: 'TC-2', label: 'List filters' }],
    scriptRefs: [{ type: 'script', id: 'SC-1', label: 'Login works' }],
    failedCaseRefs: [{ type: 'test_case', id: 'TC-2', label: 'List filters' }],
    failedScriptRefs: [],
  });
  check('completion sets latestRun', s.latestRun?.id === 'AGENT-1');
  check('completion clears matching execution', s.currentExecution === null);
  check('completion projects case collection', s.latestTestCases?.ids.join(',') === 'TC-1,TC-2' && s.latestTestCases?.sourceRunId === 'AGENT-1');
  check('failures land in active entities', s.activeEntities.some((e) => e.id === 'TC-2'));

  const beforeAppSwitch = s;
  s = applySessionEvent(s, 'ScopeSelected', { app: { type: 'app', id: 'app-keystone', label: 'Keystone' } });
  check('app switch clears module/page/object', s.currentModule === null && s.currentPage === null && s.currentObject === null);
  check('app switch preserves latestRun', s.latestRun?.id === 'AGENT-1');
  check('projection is pure (input untouched)', beforeAppSwitch.currentApp === null);

  s = applySessionEvent(s, 'EntityInvalidated', { entity: { type: 'run', id: 'AGENT-1' }, reason: 'deleted' });
  check('invalidation clears latestRun pointer', s.latestRun === null);
  check('invariants still hold after sequence', validateSessionInvariants(s).length === 0);
}

// ── 2. Bounded collections ──────────────────────────────────────────────────────────────
{
  console.log('2. bounded history');
  let s = createInitialSession({ conversationId: 'c2' });
  for (let i = 0; i < 30; i++) {
    s = applySessionEvent(s, 'DecisionRecorded', { decision: { id: `d${i}`, summary: `decision ${i}`, createdAt: new Date().toISOString() } });
  }
  check('decisions bounded to 20', s.recentDecisions.length === 20);
  check('newest decisions kept', s.recentDecisions[19].id === 'd29');
  for (let i = 0; i < 60; i++) {
    s = applySessionEvent(s, 'ArtifactGenerated', { output: { kind: 'cases', refs: [{ type: 'test_case', id: `TC-${i}` }], createdAt: new Date().toISOString() } });
  }
  check('generated outputs bounded to 50', s.generatedOutputs.length === 50);
  check('active entities bounded + deduped', validateSessionInvariants(s).length === 0);
}

// ── 3. Manager commands persist through the store ───────────────────────────────────────
{
  console.log('3. manager commands + versioning');
  const id = 'conv-mgr-1';
  const started = await sessionContextManager.startSession({ conversationId: id, ownerId: 'u1', projectId: 'p1' });
  check('start creates session', started.conversationId === id);
  const again = await sessionContextManager.startSession({ conversationId: id, ownerId: 'u1' });
  check('start is idempotent', again.version === started.version);

  await sessionContextManager.selectEntity(id, { type: 'defect', id: 'DEF-9', label: 'Broken filter' });
  const afterSelect = await sessionContextManager.getSession(id, { reconcile: false });
  check('selection persisted', afterSelect.currentSelectedEntity?.id === 'DEF-9' && afterSelect.currentDefect?.id === 'DEF-9');
  const selectedRefs = await ConversationEntityRefs.list(id, { relation: 'selected' });
  check('selection indexed for resolver', selectedRefs.some((r: any) => r.entityId === 'DEF-9'));

  await sessionContextManager.recordGoal(id, { description: 'regression pass on list view', status: 'active', createdAt: new Date().toISOString() });
  await sessionContextManager.recordDecision(id, { id: 'd1', summary: 'skip flaky suite', createdAt: new Date().toISOString() });
  const enriched = await sessionContextManager.getSession(id, { reconcile: false });
  check('goal persisted', enriched.currentGoal?.description.includes('regression'));
  check('decision persisted', enriched.recentDecisions[0]?.summary === 'skip flaky suite');
  check('version advanced per command', enriched.version >= 4, `version=${enriched.version}`);
}

// ── 4. Run lifecycle projection (idempotent) ────────────────────────────────────────────
{
  console.log('4. run lifecycle projection');
  const id = 'conv-mgr-runs';
  const run = {
    id: 'AGENT-PROJ-1', status: 'completed', conversationId: id, ownerId: 'u1', projectId: 'p1',
    generated_cases: [{ id: 'TC-A', title: 'Create record' }, { id: 'TC-B', title: 'Delete record' }],
    playwright_scripts: [{ id: 'SC-A', title: 'Create record' }],
    execution_result: { ok: false, total: 2, passed: 1, failed: 1, tests: [
      { title: 'Create record', status: 'passed' },
      { title: 'Delete record', status: 'failed', error: 'locator timeout' },
    ] },
  };
  await sessionContextManager.startSession({ conversationId: id, ownerId: 'u1' });
  const first = await projectRunLifecycle({ conversationId: id, run, phase: 'completed' });
  const dup = await projectRunLifecycle({ conversationId: id, run, phase: 'completed' });
  check('first projection applies', first.projected === true);
  check('duplicate projection is a no-op', dup.projected === false);

  const session = await sessionContextManager.getSession(id, { reconcile: false });
  check('latestRun projected', session.latestRun?.id === 'AGENT-PROJ-1');
  check('case collection projected', session.latestTestCases?.ids.includes('TC-A') === true);
  check('failed case in active entities', session.activeEntities.some((e) => e.id === 'TC-B'));

  const failedRefs = await ConversationEntityRefs.list(id, { relation: 'failed' });
  check('failed refs indexed with run edge', failedRefs.some((r: any) => r.entityId === 'TC-B' && r.sourceRunId === 'AGENT-PROJ-1'));
  const generatedRefs = await ConversationEntityRefs.list(id, { relation: 'generated' });
  check('generated graph indexed', generatedRefs.length >= 3);
}

// ── 5. Restart survival + lazy reconciliation ───────────────────────────────────────────
{
  console.log('5. restart + reconciliation');
  const id = 'conv-mgr-restart';
  await sessionContextManager.startSession({ conversationId: id, ownerId: 'u1' });
  // Simulate a run that completed while the session process was down (no projection call).
  await AgentRuns.upsert({
    id: 'AGENT-OFFLINE-1', status: 'completed', conversationId: id, ownerId: 'u1',
    generated_cases: [{ id: 'TC-R', title: 'Offline case' }],
    execution_result: { ok: true, total: 1, passed: 1, failed: 0, tests: [{ title: 'Offline case', status: 'passed' }] },
    created_at: new Date().toISOString(),
  });
  const reconciled = await sessionContextManager.getSession(id);
  check('load reconciles missed run', reconciled.latestRun?.id === 'AGENT-OFFLINE-1');
  const events = await ConversationSessions.listEvents(id);
  check('reconciliation is audited', events.some((e: any) => e.eventType === 'SessionReconciled'));
  // "Restart": hydrate from the stored snapshot only.
  const stored = await ConversationSessions.get(id);
  const rehydrated = hydrateSessionState(stored, id);
  check('snapshot survives restart', rehydrated.latestRun?.id === 'AGENT-OFFLINE-1' && rehydrated.version === reconciled.version);
}

console.log(failures === 0 ? '\nAll session-context checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
