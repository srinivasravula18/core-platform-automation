/**
 * Phase 3 — capability predicate matrix: deterministic router over request facts,
 * resolved entities, and session state, plus the exact forensic sequence
 * ("generate → run → why did they fail?") and legacy RouteKind mapping.
 *
 * Convention: standalone tsx script. JSON mode; no model calls.
 */

// Hermetic: dotenv (override:true) can restore DATABASE_URL mid-import — DISABLE_POSTGRES wins.
process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGUSER;
delete process.env.PGDATABASE;

const { createInitialSession, applySessionEvent } = await import('../services/runtime/src/domain/session');
const { analyzeRequest } = await import('../services/runtime/src/application/requestAnalyzer');
const { decideCapability } = await import('../services/runtime/src/domain/capabilityRouter');
const { resolveReferences } = await import('../services/runtime/src/domain/entityResolver');
const { routeTurn, capabilityToLegacyRouteKind } = await import('../services/runtime/src/application/routeTurn');
const { sessionContextManager } = await import('../services/runtime/src/application/sessionContextManager');
const { projectRunLifecycle } = await import('../services/runtime/src/application/sessionProjector');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function factsFor(message: string, session: any, conversationRefs: any[] = []) {
  const analysis = analyzeRequest(message);
  const bindings = resolveReferences({ utterance: message, session, conversationRefs, workspaceRecords: [] });
  return { speechAct: analysis.speechAct, isQuestion: analysis.isQuestion, wantsExecution: analysis.wantsExecution, topics: analysis.topics, bindings, session };
}

const emptySession = () => createInitialSession({ conversationId: 'c-matrix' });
const sessionWithRun = () => {
  let s = emptySession();
  s = applySessionEvent(s, 'RunCompleted', {
    runRef: { type: 'run', id: 'AGENT-77' }, status: 'completed',
    caseRefs: [{ type: 'test_case', id: 'TC-1', label: 'Login' }],
    failedCaseRefs: [{ type: 'test_case', id: 'TC-1', label: 'Login' }],
  });
  return s;
};
const failedRefs = [
  { entityType: 'run', entityId: 'AGENT-77', relation: 'latest', sourceRunId: 'AGENT-77', lastSeenAt: '2026-07-17T12:00:00.000Z' },
  { entityType: 'test_case', entityId: 'TC-1', relation: 'failed', sourceRunId: 'AGENT-77', lastSeenAt: '2026-07-17T12:01:00.000Z', label: 'Login' },
];

// ── 1. Speech-act analysis ──────────────────────────────────────────────────────────────
{
  console.log('1. request analysis');
  check('why-question → explain + failure topic', (() => { const a = analyzeRequest('Why did the test cases fail?'); return a.speechAct === 'explain' && a.topics.failure && a.isQuestion; })());
  check('generate → create + test topic', (() => { const a = analyzeRequest('Generate 5 test cases for the list view'); return a.speechAct === 'create' && a.topics.test; })());
  check('run → run + execution', (() => { const a = analyzeRequest('Run the tests against Admin'); return a.speechAct === 'run' && a.wantsExecution; })());
  check('recall phrase detected', analyzeRequest('What have we tested before in this project?').topics.recall);
  check('code topic detected', analyzeRequest('Review the diff on the feature branch').topics.code);
}

// ── 2. Capability matrix ────────────────────────────────────────────────────────────────
{
  console.log('2. capability predicates');
  const rows: Array<{ msg: string; session: any; refs?: any[]; capability: string; interaction?: string }> = [
    { msg: 'Why did they fail?', session: sessionWithRun(), refs: failedRefs, capability: 'run_diagnostics', interaction: 'answer' },
    { msg: 'Why did the test cases fail?', session: sessionWithRun(), refs: failedRefs, capability: 'run_diagnostics' },
    { msg: 'How did the last run go?', session: sessionWithRun(), refs: failedRefs, capability: 'run_diagnostics' },
    { msg: 'Generate test cases for the accounts module', session: emptySession(), capability: 'test_generation', interaction: 'action' },
    { msg: 'Run the scripts again', session: sessionWithRun(), refs: failedRefs, capability: 'automation', interaction: 'action' },
    { msg: 'Review the diff on the feature branch', session: emptySession(), capability: 'code_review', interaction: 'review' },
    { msg: 'Explain the architecture of the orchestrator subsystem', session: emptySession(), capability: 'architecture_review' },
    { msg: 'Analyze DEF-12', session: emptySession(), refs: [{ entityType: 'defect', entityId: 'DEF-12', relation: 'mentioned', sourceRunId: '', lastSeenAt: '2026-07-17T09:00:00.000Z' }], capability: 'defect_analysis' },
    { msg: 'Create a requirement for the sharing rules', session: emptySession(), capability: 'requirement_review' },
    { msg: 'What have we tested before?', session: emptySession(), capability: 'conversation_recall' },
    { msg: 'How does the list view filtering work?', session: emptySession(), capability: 'app_knowledge', interaction: 'answer' },
    { msg: 'What API endpoints does the platform expose?', session: emptySession(), capability: 'api_testing' },
    { msg: 'Create a new test plan for regression', session: emptySession(), capability: 'workspace_action' },
    { msg: 'Move the reports into the smoke folder', session: emptySession(), capability: 'workspace_action', interaction: 'action' },
  ];
  for (const row of rows) {
    const d = decideCapability(factsFor(row.msg, row.session, row.refs || []));
    const ok = d.capability === row.capability && (!row.interaction || d.interaction === row.interaction);
    check(`"${row.msg}" → ${row.capability}`, ok, `got ${d.capability}/${d.interaction} [${d.reasonCodes.join(',')}]`);
  }
}

// ── 3. Diagnostics without any run: explicit gap, no code-essay fallback ───────────────
{
  console.log('3. failure question with no run context');
  const d = decideCapability(factsFor('Why did the tests fail?', emptySession()));
  check('still run_diagnostics', d.capability === 'run_diagnostics');
  check('missing run requirement surfaced', d.missing.some((m) => m.reason.includes('run')), JSON.stringify(d.missing));
}

// ── 4. Ambiguous mutation target → clarify ──────────────────────────────────────────────
{
  console.log('4. ambiguity gate');
  const twoCollections = [
    { entityType: 'script', entityId: 'SC-9', relation: 'failed', sourceRunId: 'AGENT-300', lastSeenAt: '2026-07-17T12:00:00.000Z' },
    { entityType: 'defect', entityId: 'DEF-7', relation: 'failed', sourceRunId: 'AGENT-301', lastSeenAt: '2026-07-17T12:00:00.000Z' },
  ];
  const d = decideCapability(factsFor('fix them', emptySession(), twoCollections));
  check('ambiguous mutation clarifies', d.interaction === 'clarify' && d.confidence === 'ambiguous', JSON.stringify(d.reasonCodes));
}

// ── 5. Exact forensic sequence via routeTurn (stateful) ─────────────────────────────────
{
  console.log('5. generate → run → "why did they fail?"');
  const conversationId = 'conv-forensic';
  const scope = { workspaceId: 'default', ownerId: 'u1', projectId: 'p1' };
  await sessionContextManager.startSession({ conversationId, ownerId: 'u1', projectId: 'p1' });

  const gen = await routeTurn({ conversationId, message: 'Generate 2 test cases for the List View', scope, mode: 'shadow' });
  check('step 1 routes to test_generation', gen.decision.capability === 'test_generation', gen.decision.capability);

  await projectRunLifecycle({
    conversationId,
    run: {
      id: 'AGENT-FRX-1', status: 'completed', conversationId, ownerId: 'u1', projectId: 'p1',
      generated_cases: [{ id: 'TC-L1', title: 'List loads' }, { id: 'TC-L2', title: 'List filters' }],
      playwright_scripts: [{ id: 'SC-L1', title: 'List loads' }, { id: 'SC-L2', title: 'List filters' }],
      execution_result: { ok: false, total: 2, passed: 1, failed: 1, tests: [
        { title: 'List loads', status: 'passed' },
        { title: 'List filters', status: 'failed', error: 'expected 3 rows, saw 0' },
      ] },
    },
    phase: 'completed',
  });

  const why = await routeTurn({ conversationId, message: 'Why did they fail?', scope, mode: 'shadow' });
  check('step 3 routes to run_diagnostics', why.decision.capability === 'run_diagnostics', why.decision.capability);
  check('interaction is answer', why.decision.interaction === 'answer');
  const pronoun = why.bindings.find((b) => b.expressionKind === 'pronoun');
  check('"they" binds failed case from the run', pronoun?.status === 'resolved' && pronoun.resolved.some((r) => r.id === 'TC-L2'), JSON.stringify(pronoun?.resolved));
  check('no missing requirements', why.decision.missing.length === 0, JSON.stringify(why.decision.missing));
  check('legacy mapping stays answer', capabilityToLegacyRouteKind(why.decision) === 'answer');
}

// ── 6. Legacy RouteKind compatibility mapping ──────────────────────────────────────────
{
  console.log('6. legacy mapping');
  const mk = (capability: string, interaction: string) => capabilityToLegacyRouteKind({ capability, interaction, resolvedEntities: [], requiredEvidence: [], missing: [], confidence: 'deterministic', reasonCodes: [] } as any);
  check('test_generation → generate_cases', mk('test_generation', 'action') === 'generate_cases');
  check('automation → deep_test_run', mk('automation', 'action') === 'deep_test_run');
  check('code_review → code_analysis', mk('code_review', 'review') === 'code_analysis');
  check('run_diagnostics → answer', mk('run_diagnostics', 'answer') === 'answer');
  check('clarify wins over capability', mk('automation', 'clarify') === 'clarify');
  check('workspace_action maps through', mk('workspace_action', 'action') === 'workspace_action');
}

console.log(failures === 0 ? '\nAll capability-routing checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
