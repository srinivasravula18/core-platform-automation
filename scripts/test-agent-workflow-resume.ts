/**
 * Phase 5 exit-gate tests — TestRunGraph topology + workflow runtime (interrupt/resume, crash-resume
 * durability, duplicate-execution skip, cancel, legacy projection). Fully OFFLINE: stubbed node deps,
 * MemorySaver checkpointers, in-memory AgentRuns/AgentRunEvents (no DATABASE_URL).
 *
 * Convention: standalone tsx script, no jest/vitest (see test-agent-workflow-state.ts). Run with:
 *   npx tsx scripts/test-agent-workflow-resume.ts   (or: npm run test:agent-workflow-resume)
 * Exits 0 if all pass, 1 otherwise.
 */
import { Command, MemorySaver } from '@langchain/langgraph';
import {
  buildTestRunGraph,
  routeAfterAuthorCases, routeAfterReviewCases, routeAfterCompile,
  rediscoveryTargetsFromCompilation, MAX_REDISCOVERY_ATTEMPTS, MAX_REVIEW_REVISE,
} from '../server/features/agent/workflow/testRunGraph';
import {
  startGraphRun, resumeGraphRun, cancelGraphRun, getGraphRunState, isGraphRunActive, projectStateToLegacyRun,
  orphanedRunFailure,
} from '../server/features/agent/workflow/runtime';
import { runExecutionNode } from '../server/features/agent/workflow/nodes/execution';
import type { RunContextNodeInput, RunContextNodeResult } from '../server/features/agent/workflow/nodes/context';
import type { RunDiscoveryNodeInput, RunDiscoveryNodeResult } from '../server/features/agent/workflow/nodes/discovery';
import type {
  AuthorTestCasesInput, AuthorTestCasesResult, AuthorAbstractPlanInput, AuthorAbstractPlanResult,
} from '../server/features/agent/workflow/nodes/authoring';
import type { RunExecutionNodeInput, RunExecutionNodeResult } from '../server/features/agent/workflow/nodes/execution';
import {
  createInitialWorkflowState,
  type ExecutionAttempt, type MissionRef, type PendingReview, type WorkflowState,
} from '../server/features/agent/workflow/state';
import { stashArtifacts, readArtifacts, clearArtifacts } from '../server/features/agent/workflow/artifactStash';
import type { VerifiedElement } from '../server/features/agent/domExplorer';
import { AgentRuns } from '../server/db/repository';
import { db } from '../server/shared/storage';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(25);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fixtures + stubbed node deps.
// ---------------------------------------------------------------------------

const fixtureMission: MissionRef = {
  platformType: 'RUNTIME', platform: 'Keystone', runtimeSurface: 'keystone',
  applicationId: 'app9', moduleId: 'accounts', tabId: null,
  targetUrl: 'https://host/keystone/?appId=app9&nav=accounts',
  executionScope: 'RUNTIME/keystone/app9/accounts',
};

/** One live-verified, unique, visible element — the real grounding node promotes it into the catalog as 'New'. */
function makeElement(): VerifiedElement {
  return {
    id: 'el-new', tag: 'button', role: 'button', name: 'New', text: 'New', aria_label: null,
    placeholder: null, input_name: null, data_field: null, element_id: null, type: null, value: null,
    options: [], href: null, tooltip: null, interactive: true,
    resolved_selector: '[data-testid="new"]', selector_strategy: 'data-testid', fallback_selector: null,
    unique: true, visible: true, status: 'verified',
    state: { disabled: false, readonly: false, required: false },
  };
}

function makeStubs(o: { discoveryDelayMs?: number } = {}) {
  const counters = { discovery: 0, cases: 0, plans: 0, execution: 0, lastCasesUnderstanding: undefined as string | undefined };
  const contextNode = async (_input: RunContextNodeInput): Promise<RunContextNodeResult> => ({
    context: { metadata: { ref: 'app9', digest: 'meta-digest-1', objectCount: 3, source: 'live' } },
    errors: [],
  });
  const discoveryNode = async (_input: RunDiscoveryNodeInput): Promise<RunDiscoveryNodeResult> => {
    counters.discovery++;
    if (o.discoveryDelayMs) await sleep(o.discoveryDelayMs);
    return {
      elements: [makeElement()],
      pageSummary: { url: fixtureMission.targetUrl, title: 'Accounts', headingCount: 1, tableCount: 1, formCount: 0, bodyTextExcerpt: 'Accounts list' },
      screenshotRef: null,
      errors: [],
    };
  };
  const authorCases = async (_input: AuthorTestCasesInput): Promise<AuthorTestCasesResult> => {
    counters.cases++;
    counters.lastCasesUnderstanding = _input.understanding; // capture: prove the chat analysis reaches the writer
    return {
      cases: [{
        title: 'New button is visible on Accounts',
        description: 'Verifies the New action is present on the list view.',
        preconditions: 'User is on the Accounts list view.',
        tags: ['@ui', '@positive'],
        priority: 'Medium',
        type: 'Automated',
        steps: [{ action: 'Look at the list view toolbar', expected: 'The New button is visible' }],
      }],
      usage: [{ node: 'generate_cases', modelName: 'stub', timestamp: new Date().toISOString() }],
      errors: [],
    };
  };
  // Valid plan on a CATALOGED target ('New') so the REAL compiler grounds and validates it.
  const authorPlan = async (_input: AuthorAbstractPlanInput): Promise<AuthorAbstractPlanResult> => {
    counters.plans++;
    return {
      plan: { mission: fixtureMission.executionScope, title: 'new visible', steps: [{ assert: 'VISIBLE', target: 'New' }] },
      usage: [{ node: 'generate_abstract_plans', modelName: 'stub', timestamp: new Date().toISOString() }],
      errors: [],
    };
  };
  // Mirrors the real node's idempotency check so duplicate-skip stays observable through the counter.
  const executionNode = async (input: RunExecutionNodeInput): Promise<RunExecutionNodeResult> => {
    const completed = input.priorAttempts.find((a) => a.scriptSetDigest === input.scriptSetDigest && a.status === 'completed');
    if (completed) return { attempt: completed, aggregate: null, evidenceRefs: [], errors: [], skippedAsDuplicate: true };
    counters.execution++;
    const startedAt = new Date().toISOString();
    return {
      attempt: { scriptSetDigest: input.scriptSetDigest, logicalAttempt: 1, status: 'completed', startedAt, endedAt: new Date().toISOString(), resultRef: 'result-digest-1' },
      aggregate: { totalCases: input.scripts.length, passed: input.scripts.length, failed: 0, durationMs: 42 },
      evidenceRefs: ['evidence/exec-shot-1.png'],
      evidenceShots: [{ title: 'stub test', url: '', screenshotUrl: '/evidence/exec-shot-1.png', status: 'passed' }],
      errors: [],
      skippedAsDuplicate: false,
    };
  };
  return { counters, deps: { contextNode, discoveryNode, authorCases, authorPlan, executionNode } };
}

function initialInput(runId: string, reviewPolicy: 'auto' | 'manual'): Record<string, unknown> {
  const state = createInitialWorkflowState({
    runId, threadId: runId, requestId: `req-${runId}`,
    tenantId: 't1', workspaceId: 'w1', projectId: 'p1', applicationId: 'app9', requestedBy: 'tester',
    request: { goal: 'Generate a test for the Accounts list view', requestedCaseCount: 1, reviewPolicy, executionPolicy: 'auto' },
    mission: fixtureMission,
    credentialRef: null,
  });
  // Known reducer quirk: plansByCase must be omitted from the invoke input (the channel default supplies {}).
  const input: Record<string, unknown> = { ...state };
  delete input.plansByCase;
  return input;
}

function firstInterruptValue(snapshot: { tasks?: readonly unknown[] } | null | undefined): PendingReview | null {
  for (const task of (snapshot?.tasks ?? []) as Array<{ interrupts?: Array<{ value?: unknown }> }>) {
    if (task.interrupts && task.interrupts.length > 0) return (task.interrupts[0]?.value ?? null) as PendingReview | null;
  }
  return null;
}

// ---------------------------------------------------------------------------
function testRouters() {
  console.log('0. Router unit tests');

  const request = (reviewPolicy: 'auto' | 'manual') => ({ goal: 'g', requestedCaseCount: 1, reviewPolicy, executionPolicy: 'auto' as const });
  eq(routeAfterAuthorCases({ cases: [], request: request('auto') }), 'finalize', 'no cases → finalize');
  eq(routeAfterAuthorCases({ cases: [{ id: 'c1', title: 't' }], request: request('manual') }), 'review_cases', 'manual policy → review_cases');
  eq(routeAfterAuthorCases({ cases: [{ id: 'c1', title: 't' }], request: request('auto') }), 'author_plans', 'auto policy skips review');

  const resolution = (decision: 'approved' | 'rejected' | 'revised') => ({
    pending: null, resolution: { correlationId: 'cases:x', decision, actor: 'qa', decidedAt: 'now' },
  });
  eq(routeAfterReviewCases({ review: resolution('rejected'), retryCounters: {} }), 'finalize', 'rejected review → finalize');
  eq(routeAfterReviewCases({ review: resolution('revised'), retryCounters: { review_revise: 1 } }), 'author_cases', `revised within bound (${MAX_REVIEW_REVISE}) → re-author`);
  eq(routeAfterReviewCases({ review: resolution('revised'), retryCounters: { review_revise: 2 } }), 'author_plans', 'revised past bound → proceed to plans');
  eq(routeAfterReviewCases({ review: resolution('approved'), retryCounters: {} }), 'author_plans', 'approved → author_plans');

  const unresolvedCompilation = {
    scripts: [], compilerVersion: 'x@1',
    diagnostics: [{ caseId: 'c1', kind: 'UNRESOLVED_SELECTOR' as const, message: 'm', target: 'Ghost' }],
  };
  eq(rediscoveryTargetsFromCompilation(unresolvedCompilation), ['Ghost'], 'unresolved diagnostics yield rediscovery targets');
  eq(routeAfterCompile({ compilation: unresolvedCompilation, rediscoveryAttempts: 0, request: request('auto') }), 'discover_and_ground', 'unresolved targets + attempts left → rediscovery');
  eq(routeAfterCompile({ compilation: unresolvedCompilation, rediscoveryAttempts: MAX_REDISCOVERY_ATTEMPTS, request: request('auto') }), 'finalize', 'unresolved targets + attempts exhausted + no scripts → finalize');
  const cleanCompilation = { scripts: [{ caseId: 'c1', scriptRef: 'r', digest: 'd', ok: true }], diagnostics: [], compilerVersion: 'x@1' };
  // Script review removed: clean scripts ALWAYS go straight to execution regardless of review policy.
  eq(routeAfterCompile({ compilation: cleanCompilation, rediscoveryAttempts: 0, request: request('manual') }), 'execute_tests', 'clean scripts + manual → execute_tests (script gate removed)');
  eq(routeAfterCompile({ compilation: cleanCompilation, rediscoveryAttempts: 0, request: request('auto') }), 'execute_tests', 'clean scripts + auto → execute_tests');
}

// ---------------------------------------------------------------------------
async function testAutoHappyPath(shared: { graph?: ReturnType<typeof buildTestRunGraph>; threadId?: string; counters?: ReturnType<typeof makeStubs>['counters'] }) {
  console.log('1. Auto-policy happy path (stubbed discovery/authoring/execution, REAL grounding+compilation)');

  const { counters, deps } = makeStubs();
  const saver = new MemorySaver();
  const graph = buildTestRunGraph(deps, { checkpointer: saver });
  const threadId = `wfrun-auto-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  const final = await graph.invoke(initialInput(threadId, 'auto') as any, config) as WorkflowState;
  eq(final.status, 'completed', 'final status is completed');
  eq(final.stage, 'finalize', 'final stage is finalize');
  eq(final.plansByCase['case-1']?.status, 'planned', 'plansByCase ref recorded as planned');
  ok((final.plansByCase['case-1']?.planRef ?? '').startsWith('plan:case-1:'), 'planRef is a ref/digest, not a payload');
  ok(final.compilation.scripts.length >= 1, `compilation produced ${final.compilation.scripts.length} clean script(s)`);
  ok(final.compilation.scripts.every((s) => s.ok), 'every recorded script compiled clean');
  ok(final.execution.attempts.some((a) => a.status === 'completed'), 'execution attempt completed');
  eq(final.execution.aggregate?.passed, 1, 'execution aggregate reflects the stub result');
  eq(counters.execution, 1, 'stubbed execution ran exactly once');
  eq(final.evidence.gate?.decision, 'continue', 'evidence gate passed on live-verified element');
  const compiledSource = readArtifacts(threadId).compiledSources?.['case-1'] ?? '';
  ok(compiledSource.includes('data-testid'), 'compiled source embeds the verified locator (from the real compiler)');
  ok(!JSON.stringify(final).toLowerCase().includes('hunter2'), 'sanity: no stray secrets in state');

  shared.graph = graph;
  shared.threadId = threadId;
  shared.counters = counters;
}

// ---------------------------------------------------------------------------
async function testManualReviewResume() {
  console.log('2. Manual review interrupt + resume');

  const { deps } = makeStubs();
  const saver = new MemorySaver();
  const graph = buildTestRunGraph(deps, { checkpointer: saver });
  const threadId = `wfrun-manual-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  await graph.invoke(initialInput(threadId, 'manual') as any, config);
  const snap1 = await graph.getState(config);
  const pending1 = firstInterruptValue(snap1);
  ok(pending1 !== null, 'graph paused with a pending interrupt visible via getState');
  eq(pending1?.kind, 'cases', 'first interrupt is the cases review');
  ok((pending1?.correlationId ?? '').startsWith('cases:'), 'correlationId is digest-derived (cases:<digest>)');
  ok((snap1.values as WorkflowState).status !== 'completed', 'run is not completed while paused');

  // Script review removed: approving cases runs plans→compile→execute automatically to completion, no 2nd pause.
  const final = await graph.invoke(new Command({ resume: { correlationId: pending1!.correlationId, decision: 'approved', actor: 'qa' } }) as any, config) as WorkflowState;
  eq(final.status, 'completed', 'run completes automatically after the single case-review approval');
  eq(final.review.resolution?.decision, 'approved', 'review.resolution decision recorded');
  eq(final.review.resolution?.correlationId, pending1!.correlationId, 'recorded resolution answers the cases review');
  eq(final.review.resolution?.actor, 'qa', 'resolution actor recorded');
  ok(firstInterruptValue(await graph.getState(config)) === null, 'no second (scripts) interrupt — script→evidence is automatic');
}

// ---------------------------------------------------------------------------
async function testStaleResumeRejected() {
  console.log('3. Stale resume (wrong correlationId) is rejected');

  const { deps } = makeStubs();
  const saver = new MemorySaver();
  const graph = buildTestRunGraph(deps, { checkpointer: saver });
  const threadId = `wfrun-stale-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  await graph.invoke(initialInput(threadId, 'manual') as any, config);
  const pending = firstInterruptValue(await graph.getState(config));
  ok(pending?.kind === 'cases', 'paused at the cases review');

  let threw = false; let message = '';
  try {
    await graph.invoke(new Command({ resume: { correlationId: 'cases:WRONG-DIGEST', decision: 'approved', actor: 'qa' } }) as any, config);
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  ok(threw, 'graph run errors instead of approving the wrong artifact');
  ok(/correlationId/i.test(message), `error names the correlation mismatch (got: ${message.slice(0, 120)})`);
}

// ---------------------------------------------------------------------------
async function testCrashResumeDurability() {
  console.log('4. Crash-resume durability (fresh graph instance, same MemorySaver + thread_id)');

  const stubs = makeStubs();
  const saver = new MemorySaver();
  const threadId = `wfrun-crash-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  const graphA = buildTestRunGraph(stubs.deps, { checkpointer: saver });
  await graphA.invoke(initialInput(threadId, 'manual') as any, config);
  ok(firstInterruptValue(await graphA.getState(config))?.kind === 'cases', 'first instance paused at the cases review');

  // "Process restart": a brand-new graph instance over the SAME checkpointer continues the thread.
  const graphB = buildTestRunGraph(stubs.deps, { checkpointer: saver });
  const pendingB = firstInterruptValue(await graphB.getState(config));
  eq(pendingB?.kind, 'cases', 'fresh graph instance sees the pending interrupt from the checkpoint');

  // Script review removed: approving cases on the fresh instance runs straight through to completion.
  const final = await graphB.invoke(new Command({ resume: { correlationId: pendingB!.correlationId, decision: 'approved', actor: 'qa' } }) as any, config) as WorkflowState;
  eq(final.status, 'completed', 'checkpoint-backed continuation completes on the fresh instance');
  eq(stubs.counters.discovery, 1, 'discovery ran exactly once across the simulated restart (no replay of finished nodes)');
  eq(stubs.counters.cases, 1, 'case authoring ran exactly once across the simulated restart');
}

// ---------------------------------------------------------------------------
async function testDuplicateExecutionSkip(shared: { graph?: ReturnType<typeof buildTestRunGraph>; threadId?: string; counters?: ReturnType<typeof makeStubs>['counters'] }) {
  console.log('5. Duplicate execution skip');

  // 5a — the REAL execution node short-circuits on a completed prior attempt (never reaches Playwright).
  const iso = new Date().toISOString();
  const prior: ExecutionAttempt = { scriptSetDigest: 'digest-X', logicalAttempt: 1, status: 'completed', startedAt: iso, endedAt: iso, resultRef: 'res-1' };
  const skip = await runExecutionNode({
    runId: 'unit-exec-skip',
    scripts: [{ filename: 'x.spec.ts', title: 'x', code: '// never executed' }],
    scriptSetDigest: 'digest-X',
    priorAttempts: [prior],
  });
  eq(skip.skippedAsDuplicate, true, 'real runExecutionNode skips a completed scriptSetDigest');
  eq(skip.attempt, prior, 'skip returns the prior attempt untouched');
  eq(skip.errors, [], 'skip carries no errors');

  // 5b — graph-level: re-drive the execute path on section 1's completed thread; the counting stub must not fire again.
  // compile_and_validate now routes straight to execute_tests (script review removed), so re-enter there.
  const graph = shared.graph!;
  const threadId = shared.threadId!;
  const counters = shared.counters!;
  const config = { configurable: { thread_id: threadId } };
  await graph.updateState(config, { stage: 'compile_and_validate' }, 'compile_and_validate');
  const redriven = await graph.invoke(null, config) as WorkflowState;
  eq(counters.execution, 1, 'stubbed execution was NOT called a second time');
  eq(redriven.execution.attempts.length, 1, 'no second execution attempt appended (reducer replaced the same key)');
  eq(redriven.execution.aggregate?.passed, 1, 'prior aggregate preserved through the duplicate-skip update');
  eq(redriven.status, 'completed', 're-driven run finalizes completed');
}

// ---------------------------------------------------------------------------
async function testRuntimeCancelAndResume() {
  console.log('6. Runtime service — cancel mid-flight + interrupt/resume/status (in-memory AgentRuns)');

  // 6a — cancel while the stubbed discovery hangs.
  const cancelStubs = makeStubs({ discoveryDelayMs: 500 });
  const runC = `wfrt-cancel-${Date.now()}`;
  await startGraphRun({
    runId: runC, goal: 'cancel me', requestedCaseCount: 1, reviewPolicy: 'auto',
    mission: fixtureMission,
    credential: { username: 'admin', password: 'SECRET_MARKER_CANCEL' },
    graphDeps: cancelStubs.deps,
  });
  await sleep(120); // discovery is now hanging inside its 500ms stub delay
  await cancelGraphRun(runC);
  const recC = await AgentRuns.get(runC);
  eq(recC?.status, 'cancelled', 'projection shows cancelled immediately after cancelGraphRun');
  await sleep(700); // let the hung stub settle past its delay
  const recC2 = await AgentRuns.get(runC);
  eq(recC2?.status, 'cancelled', 'status stays cancelled after the hung node settles (loop did not overwrite it)');
  ok(!isGraphRunActive(runC), 'background pump stopped');

  // 6b — full runtime review flow: review_required projection → resume → completed; no secret leaks.
  const reviewStubs = makeStubs();
  const runR = `wfrt-review-${Date.now()}`;
  await startGraphRun({
    runId: runR, goal: 'review flow', requestedCaseCount: 1, reviewPolicy: 'manual',
    mission: fixtureMission,
    requestedBy: 'tester',
    credential: { username: 'admin', password: 'SECRET_MARKER_RT' },
    legacyRunSeed: { provider: 'openai', model: 'gpt-test', prompt: 'review flow', messages: [] },
    graphDeps: reviewStubs.deps,
  });
  ok(await waitFor(async () => {
    const r = await AgentRuns.get(runR);
    return r?.status === 'review_required' && !isGraphRunActive(runR);
  }, 4000), 'runtime projects review_required when the stream ends on a pending interrupt');
  const rec1 = await AgentRuns.get(runR);
  ok((rec1?.pending_review?.correlationId ?? '').startsWith('cases:'), 'pending review surfaced in the projection (cases)');

  // Script review removed: approving CASES runs plans → compile → execute automatically to completion.
  await resumeGraphRun(runR, { correlationId: rec1.pending_review.correlationId, decision: 'approved', actor: 'qa' });
  ok(await waitFor(async () => (await AgentRuns.get(runR))?.status === 'completed', 5000), 'run completes automatically after the single case-review approval (no script gate)');
  const rec3 = await AgentRuns.get(runR);
  eq(rec3?.engine, 'langgraph', 'projection carries engine=langgraph');
  ok((rec3?.playwright_scripts ?? []).length >= 1, 'legacy projection carries the compiled script');
  eq(rec3?.playwright_scripts?.[0]?.test_case_title, 'New button is visible on Accounts', 'script mapped with the case title');
  ok((rec3?.evidence_screenshots ?? []).some((s: any) => s?.screenshotUrl === '/evidence/exec-shot-1.png'), 'UI-ready evidence card projected');
  ok(!JSON.stringify(rec3).includes('SECRET_MARKER_RT'), 'no credential secret in the persisted projection');
  const rtWorkflowLines = (rec3?.messages ?? []).filter((m: any) => m.agent === 'Workflow');
  ok(rtWorkflowLines.length > 0 && rtWorkflowLines.length <= 20, `progress lines appended conservatively (${rtWorkflowLines.length} ≤ 20)`);
  // Chip truth table: a completed run must leave every chip completed or skipped — never blank/spinning.
  const rtChips = (rec3?.messages ?? []).filter((m: any) => m.agent !== 'Workflow' && m.agent !== 'System');
  ok(rtChips.length > 0 && rtChips.every((m: any) => m.status === 'completed' || m.status === 'skipped'), 'terminal run leaves no chip running or silently blank');

  const wfState = await getGraphRunState(runR);
  eq(wfState?.status, 'completed', 'getGraphRunState returns the checkpointed values snapshot');
  eq(wfState?.runId, runR, 'snapshot belongs to the requested run');
  eq(await getGraphRunState('no-such-run-id'), null, 'getGraphRunState returns null for an unknown thread');
  ok(!isGraphRunActive(runR), 'pump finished');

  // Cleanup: keep the shared in-memory store free of test records.
  await AgentRuns.remove(runC);
  await AgentRuns.remove(runR);
  const testRunIds = new Set([runC, runR]);
  const keep = (db.agentRunEvents as any[]).filter((r) => !testRunIds.has(r.run_id));
  (db.agentRunEvents as any[]).length = 0;
  (db.agentRunEvents as any[]).push(...keep);
  clearArtifacts(runC);
  clearArtifacts(runR);
}

// ---------------------------------------------------------------------------
function testProjectionUnit() {
  console.log('7. projectStateToLegacyRun unit tests');

  const runId = `wfproj-${Date.now()}`;
  const base = createInitialWorkflowState({
    runId, threadId: runId, requestId: `req-${runId}`,
    tenantId: 't1', workspaceId: 'w1', projectId: 'p1', applicationId: 'app9', requestedBy: 'tester',
    request: { goal: 'projection goal', requestedCaseCount: 1, reviewPolicy: 'auto', executionPolicy: 'auto' },
    mission: fixtureMission,
    credentialRef: null,
  });
  const state: WorkflowState = {
    ...base,
    status: 'queued',
    stage: 'load_context',
    cases: [{ id: 'case-1', title: 'Case title', description: 'Case description', tags: ['@ui'] }],
    compilation: { scripts: [{ caseId: 'case-1', scriptRef: 'compiled:x:case-1', digest: 'd1', ok: true }], diagnostics: [], compilerVersion: 'x@1' },
    execution: { attempts: [], aggregate: null, evidenceRefs: ['shots/a.png'] },
  };
  stashArtifacts(runId, {
    compiledSources: { 'case-1': 'compiled-code-here' },
    evidenceShots: [{ title: 'Case title', url: 'https://target/', screenshotUrl: '/evidence/x-graph-1.png', status: 'passed' }],
  });

  const seed = { credentials: { username: 'admin', password: 'SECRET_MARKER_SEED' }, provider: 'openai', model: 'gpt-test', prompt: 'orig prompt', messages: [] };
  const proj = projectStateToLegacyRun(state, seed);
  eq(proj.id, runId, 'projection id is the runId');
  eq(proj.status, 'running', 'queued maps to running for UI compat');
  eq(proj.generated_cases[0]?.title, 'Case title', 'case title mapped to the legacy case shape');
  eq(proj.generated_cases[0]?.description, 'Case description', 'case description mapped');
  eq(proj.generated_cases[0]?.tags, ['@ui'], 'case tags mapped');
  eq(proj.playwright_scripts[0]?.test_case_title, 'Case title', 'script test_case_title mapped from the case');
  eq(proj.playwright_scripts[0]?.filename, 'case-1.spec.ts', 'script filename derived from the case id');
  eq(proj.playwright_scripts[0]?.code, 'compiled-code-here', 'script code read from the artifact stash');
  eq(proj.evidence_screenshots?.[0]?.screenshotUrl, '/evidence/x-graph-1.png', 'UI-ready evidence cards projected from the stash');
  eq(proj.evidence_screenshots?.[0]?.title, 'Case title', 'evidence card carries the test title');
  eq(proj.engine, 'langgraph', 'engine stamped langgraph');
  eq(proj.provider, 'openai', 'whitelisted seed field (provider) copied');
  eq(proj.prompt, 'orig prompt', 'seed prompt wins over the goal');
  ok(!JSON.stringify(proj).includes('SECRET_MARKER_SEED'), 'seed credentials never copied into the projection');
  ok(proj.credentials === undefined, 'no credentials key at all on the projection');
  const wfLines = (proj.messages as any[]).filter((m) => m.agent === 'Workflow');
  ok(wfLines.length === 1, 'one bounded Workflow progress line appended');

  const projDone = projectStateToLegacyRun({ ...state, status: 'completed', stage: 'finalize' }, proj);
  eq(projDone.status, 'completed', 'completed maps straight through');
  const doneWf = (projDone.messages as any[]).filter((m) => m.agent === 'Workflow');
  eq(doneWf.length, 2, 'a changed progress line appends exactly one more Workflow message');
  const projSame = projectStateToLegacyRun({ ...state, status: 'completed', stage: 'finalize' }, projDone);
  eq((projSame.messages as any[]).filter((m) => m.agent === 'Workflow').length, 2, 'an unchanged progress line appends nothing');
  // Chip truth table on a terminal run: artifact-backed chips completed, artifact-less chips explicitly skipped.
  const doneChips = (projDone.messages as any[]).filter((m) => m.agent !== 'Workflow' && m.agent !== 'System');
  ok(doneChips.every((m) => m.status === 'completed' || m.status === 'skipped'), 'terminal projection has only completed/skipped chips');
  ok(doneChips.some((m) => m.status === 'skipped' && /skipped/i.test(m.output)), 'artifact-less stages are explicitly marked skipped with a reason');
  ok(doneChips.find((m) => m.agent === 'PlaywrightAgent')?.status === 'completed', 'compiled stage chip shows completed (artifact-backed)');

  const failedState: WorkflowState = { ...state, status: 'failed', stage: 'finalize', output: { summary: 's', reportRef: null, reason: 'gate blocked' } };
  const projFailed = projectStateToLegacyRun(failedState, projSame);
  eq(projFailed.status, 'failed', 'failed maps straight through');
  ok(String(projFailed.messages[projFailed.messages.length - 1]?.output ?? '').includes('gate blocked'), 'failure reason surfaces in the progress line');

  clearArtifacts(runId);
}

// ---------------------------------------------------------------------------
async function testOrphanReconciliation() {
  console.log('8. Orphaned-run reconciliation (restart/crash leaves no run spinning forever)');
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();

  // Orphaned: a graph run stuck 'running', no live pump in this process, stale → becomes a truthful failure.
  const orphan = { id: `orphan-${Date.now()}`, engine: 'langgraph', status: 'running', updated_at: old,
    messages: [{ agent: 'ApplicationInspector', status: 'running', output: 'Discovering…' }, { agent: 'ScopeAgent', status: 'completed', output: 'Done.' }] };
  const failed = orphanedRunFailure(orphan);
  ok(failed?.status === 'failed', 'stale running graph run with no live pump → failed');
  ok(failed?.pending_review === null, 'reconciled record clears any pending review');
  ok(failed?.messages?.some((m: any) => m.agent === 'Workflow' && m.status === 'failed' && /interrupted/i.test(m.output)), 'a truthful failure line names the interruption');
  ok(!failed?.messages?.some((m: any) => m.status === 'running'), 'no chip is left spinning (running → skipped)');
  ok(failed?.messages?.some((m: any) => m.agent === 'ApplicationInspector' && m.status === 'skipped'), 'the in-flight inspector chip is downgraded to skipped');

  // Left ALONE: terminal, review-paused (resumable), legacy-engine, and just-projected runs.
  eq(orphanedRunFailure({ ...orphan, status: 'completed' }), null, 'completed run is never reconciled');
  eq(orphanedRunFailure({ ...orphan, status: 'review_required' }), null, 'review-paused run (resumable) is left alone');
  eq(orphanedRunFailure({ ...orphan, engine: 'legacy' }), null, 'legacy-engine run is not touched (owns its own lifecycle)');
  eq(orphanedRunFailure({ ...orphan, updated_at: fresh }), null, 'a just-projected run gets the benefit of the doubt (staleness grace)');

  // An ACTIVELY-PUMPING run is never reconciled even if its last projection is old (long node between streams).
  const runA = `orphan-active-${Date.now()}`;
  const activeStubs = makeStubs({ discoveryDelayMs: 600 });
  await startGraphRun({ runId: runA, goal: 'active', requestedCaseCount: 1, reviewPolicy: 'auto', mission: fixtureMission, graphDeps: activeStubs.deps });
  await sleep(120);
  ok(isGraphRunActive(runA), 'run is actively pumping');
  eq(orphanedRunFailure({ id: runA, engine: 'langgraph', status: 'running', updated_at: old }), null, 'a live-pumping run is never reconciled, even with a stale timestamp');
  await cancelGraphRun(runA);
  await sleep(700);
  await AgentRuns.remove(runA);
  clearArtifacts(runA);
}

// ---------------------------------------------------------------------------
async function testUnderstandingThreading() {
  console.log('9. Chat understanding threads through to the case writer (not just prompt + DOM)');
  const stubs = makeStubs();
  const runU = `wfrt-understanding-${Date.now()}`;
  const understanding = 'VERIFIED ANALYSIS: Label derives API Name by lowercasing + underscoring; Prefix is lowercased on change; Version accepts free text.';
  await startGraphRun({
    runId: runU, goal: 'write cases for app creation', requestedCaseCount: 1, reviewPolicy: 'auto',
    understanding,
    mission: fixtureMission,
    graphDeps: stubs.deps,
  });
  ok(await waitFor(async () => stubs.counters.cases > 0, 5000), 'case authoring ran');
  eq(stubs.counters.lastCasesUnderstanding, understanding, 'the case writer received the chat understanding verbatim');
  ok(!isGraphRunActive(runU) || (await AgentRuns.get(runU))?.status === 'completed', 'run reached a terminal/settled state');
  await AgentRuns.remove(runU);
  clearArtifacts(runU);
}

// ---------------------------------------------------------------------------
async function main() {
  // Hermetic: force the in-memory JSON store + MemorySaver checkpointer regardless of the shell env.
  delete process.env.DATABASE_URL;
  delete process.env.DEPLOYMENT_MODE;
  process.env.NODE_ENV = 'test';

  const shared: { graph?: ReturnType<typeof buildTestRunGraph>; threadId?: string; counters?: ReturnType<typeof makeStubs>['counters'] } = {};

  testRouters();
  await testAutoHappyPath(shared);
  await testManualReviewResume();
  await testStaleResumeRejected();
  await testCrashResumeDurability();
  await testDuplicateExecutionSkip(shared);
  await testRuntimeCancelAndResume();
  testProjectionUnit();
  await testOrphanReconciliation();
  await testUnderstandingThreading();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
