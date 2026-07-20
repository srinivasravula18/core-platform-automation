/**
 * Phase 4 exit-gate tests — the test-authoring graph (workflow/graphs/testAuthoringGraph.ts) composing
 * author_cases → author_plans → compile_and_validate over the run-scoped artifact stash, plus the
 * strict-parse no-drop regression proof the architecture plan demands.
 *
 * Convention: standalone tsx script, no jest/vitest (see test-agent-discovery-graph.ts). Run with:
 *   npx tsx scripts/test-agent-authoring-graph.ts   (or: npm run test:agent-authoring-graph)
 * Exits 0 if all pass, 1 on first failure. Fully offline: the two authoring model calls are stubbed via
 * the graph's dependency seams; grounding, compilation, and the LangGraph machinery are always REAL.
 */
import '../server/shared/env';
import { MemorySaver } from '@langchain/langgraph';
import { buildTestAuthoringGraph } from '../server/features/agent/workflow/graphs/testAuthoringGraph';
import { runGroundingNode } from '../server/features/agent/workflow/nodes/grounding';
import type { AuthoredTestCase, AuthorTestCasesInput } from '../server/features/agent/workflow/nodes/authoring';
import { stashArtifacts, readArtifacts, clearArtifacts } from '../server/features/agent/workflow/artifactStash';
import {
  createInitialWorkflowState, assertNoSecretLeakage,
  type MissionRef, type UsageRecord, type WorkflowState,
} from '../server/features/agent/workflow/state';
import { parseTestPlan, parseTestPlanStrict, TEST_PLAN_SCHEMA_VERSION, type TestPlan } from '../server/features/agent/compiler/testPlan';
import type { VerifiedElement } from '../server/features/agent/domExplorer';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Hand-built VerifiedElement (same idiom as test-agent-discovery-graph.ts). */
function makeElement(overrides: Partial<VerifiedElement>): VerifiedElement {
  return {
    id: 'new_button', tag: 'button', role: 'button', name: 'New', text: 'New',
    aria_label: null, placeholder: null, input_name: null, data_field: null, element_id: 'new-item',
    type: null, value: null, options: [], href: null, tooltip: null, interactive: true,
    resolved_selector: '#new-item', selector_strategy: 'id', fallback_selector: null,
    unique: true, visible: true, status: 'verified',
    state: { disabled: false, readonly: false, required: false },
    ...overrides,
  };
}

/** Three verified-live unique elements → catalog names 'New', 'Search', 'RefreshListView'. */
function fixtureElements(): VerifiedElement[] {
  return [
    makeElement({}),
    makeElement({ id: 'search_box', tag: 'input', role: 'textbox', name: 'Search', text: null, element_id: 'search-box', resolved_selector: '#search-box' }),
    makeElement({ id: 'refresh_button', name: 'Refresh list view', text: 'Refresh list view', element_id: 'refresh-list', resolved_selector: '#refresh-list' }),
  ];
}

const MISSION: MissionRef = {
  platformType: 'RUNTIME', platform: 'Keystone', runtimeSurface: 'keystone', applicationId: 'app9',
  moduleId: 'accounts', tabId: null,
  targetUrl: 'https://host/keystone/?appId=app9&nav=accounts',
  executionScope: 'RUNTIME/keystone/app9/accounts',
};

/** Full initial state minus plansByCase: that channel's UPDATE type is per-case (reducer), so an empty Record can't be passed as invoke input — the channel default supplies {}. */
function fixtureInvokeInput(runId: string) {
  const state = createInitialWorkflowState({
    runId, threadId: `thread-${runId}`, requestId: `req-${runId}`,
    tenantId: 'tenant-1', workspaceId: 'ws-1', projectId: 'proj-1', applicationId: 'app9',
    requestedBy: 'user-1',
    request: { goal: 'Generate 2 test cases for the Accounts list view', requestedCaseCount: 2, reviewPolicy: 'auto', executionPolicy: 'skip' },
    mission: MISSION,
    credentialRef: { websiteId: 'site-1', role: 'admin' },
  });
  const { plansByCase: _plansByCase, ...input } = state;
  return input;
}

/** Grounds the fixture elements for one run and stashes graph+selectors (what Phase 5 wiring will do). */
function stashFixtureEvidence(runId: string) {
  const grounding = runGroundingNode({ elements: fixtureElements(), rediscoveryAttempts: 0 });
  stashArtifacts(runId, { evidenceGraph: grounding.evidenceGraph, verifiedSelectors: grounding.verifiedSelectors });
  return grounding;
}

const STUB_CASES: AuthoredTestCase[] = [
  {
    title: 'List view loads', description: 'The Accounts list shows the grid', preconditions: 'Signed in with seeded accounts',
    tags: ['@regression', '@ui'], priority: 'High', type: 'Automated',
    steps: [{ action: 'Open the Accounts module', expected: 'The grid renders rows' }],
  },
  {
    title: 'Search filters rows', description: 'Typing in Search narrows the grid', preconditions: 'Accounts exist',
    tags: ['@positive'], priority: 'Medium', type: 'Automated',
    steps: [{ action: 'Fill Search with a term', expected: 'Only matching rows remain' }],
  },
];

/** Realistic strict plan over REAL cataloged semantic names (actions mirror scripts/test-playwright-compiler.ts). */
const CLEAN_PLAN: TestPlan = {
  mission: MISSION.executionScope, module: 'Account', title: 'accounts smoke',
  steps: [
    { action: 'OPEN_MODULE', target: 'Accounts' },
    { assert: 'VISIBLE', target: 'New' },
    { action: 'FILL', target: 'Search', value: 'acme' },
    { assert: 'VERIFY_TABLE', target: 'New' },
  ],
};

const usageOf = (node: string): UsageRecord => ({ node, modelName: 'stub-model', inputTokens: 10, outputTokens: 20, latencyMs: 1, timestamp: '2026-07-13T00:00:00Z' });

// ---------------------------------------------------------------------------
async function testHappyPath() {
  console.log('1. Happy path — grounded stash → stubbed authoring → REAL compile + validate');

  const runId = 'run-authoring-happy-1';
  const threadId = `thread-${runId}`;
  clearArtifacts(runId);
  const grounding = stashFixtureEvidence(runId);
  eq(grounding.evidence.targetCatalog.map((t) => t.semanticName).sort(), ['New', 'RefreshListView', 'Search'],
    'fixture catalog carries the three verified semantic names');

  let caseCalls = 0, planCalls = 0;
  let seenCasesInput: AuthorTestCasesInput | undefined;
  const graph = buildTestAuthoringGraph({
    authorCases: async (input) => { caseCalls++; seenCasesInput = input; return { cases: STUB_CASES, usage: [usageOf('generate_cases')], errors: [] }; },
    authorPlan: async () => { planCalls++; return { plan: CLEAN_PLAN, usage: [usageOf('generate_abstract_plans')], errors: [] }; },
  }, { checkpointer: new MemorySaver() });

  const finalState = (await graph.invoke(fixtureInvokeInput(runId), { configurable: { thread_id: threadId } })) as WorkflowState;

  eq(caseCalls, 1, 'case authoring ran exactly once');
  eq(planCalls, 2, 'plan authoring ran exactly once per case');
  ok(seenCasesInput?.evidenceGraph === grounding.evidenceGraph, 'author_cases received the STASHED in-memory evidence graph');
  eq(seenCasesInput?.goal, 'Generate 2 test cases for the Accounts list view', 'author_cases received the request goal');
  eq(seenCasesInput?.requestedCaseCount, 2, 'author_cases received the requested case count');

  eq(finalState.cases.map((c) => c.id), ['case-1', 'case-2'], 'both authored cases reached state with stable ids');
  eq(finalState.cases[0]?.title, 'List view loads', 'case title survives the WorkflowCase projection');

  const refs = Object.values(finalState.plansByCase);
  eq(refs.map((r) => r.status), ['planned', 'planned'], 'both plansByCase refs are status planned');
  ok(refs.every((r) => typeof r.planRef === 'string' && /^[0-9a-f]{40}$/.test(r.planRef ?? '')), 'each planRef is a sha1 digest, never a plan body');

  eq(finalState.compilation.scripts.length, 2, 'both cases compiled to scripts');
  ok(finalState.compilation.scripts.every((s) => s.ok && /^[0-9a-f]{40}$/.test(s.digest)), 'each script ref is ok with a sha1 digest');
  eq(finalState.compilation.diagnostics, [], 'zero compile diagnostics');
  ok(!!finalState.compilation.compilerVersion, `compilerVersion stamped (${finalState.compilation.compilerVersion})`);
  eq(finalState.coveragePlan?.items.length, 2, 'coverage plan classifies both cases');
  eq(finalState.riskScores.length, 2, 'risk scores populated for both coverage items');
  eq(finalState.errors, [], 'no errors appended on the happy path');
  eq(finalState.usage.map((u) => u.node), ['generate_cases', 'generate_abstract_plans', 'generate_abstract_plans'], 'usage appended for the case call and both plan calls');
  eq(finalState.stage, 'compile_and_validate', 'stage reflects the last node');

  const arts = readArtifacts(runId);
  eq(Object.keys(arts.plansByCase ?? {}).sort(), ['case-1', 'case-2'], 'FULL plans live in the stash keyed by case id');
  eq(Object.keys(arts.compiledSources ?? {}).sort(), ['case-1', 'case-2'], 'compiled sources live in the stash, not state');
  ok((arts.compiledSources?.['case-1'] ?? '').includes('#search-box'), 'compiled source embeds the verified Search selector');
  ok((arts.compiledSources?.['case-1'] ?? '').includes('await runner.openModule();'), 'OPEN_MODULE compiled to mission-scoped navigation, not a click');
  ok((arts.compiledSources?.['case-1'] ?? '').includes('test("List view loads"'), 'compiled test uses the reviewed case title when the plan omits it');

  return { graph, threadId, runId };
}

// ---------------------------------------------------------------------------
async function testUnresolvedTarget() {
  console.log('2. Unresolved target — explicit diagnostic + rediscovery error, clean termination');

  const runId = 'run-authoring-unresolved-1';
  clearArtifacts(runId);
  stashFixtureEvidence(runId);
  const ghostPlan: TestPlan = {
    mission: MISSION.executionScope,
    steps: [
      { action: 'CLICK', target: 'GhostControl' }, // not in the catalog → UNRESOLVED_SELECTOR
      { assert: 'VISIBLE', target: 'New' },
    ],
  };
  const graph = buildTestAuthoringGraph({
    authorCases: async () => ({ cases: [STUB_CASES[0]], usage: [], errors: [] }),
    authorPlan: async () => ({ plan: ghostPlan, usage: [], errors: [] }),
  });
  const finalState = (await graph.invoke(fixtureInvokeInput(runId))) as WorkflowState;

  ok(true, 'graph terminated cleanly (no throw)');
  eq(finalState.compilation.diagnostics.map((d) => d.kind), ['UNRESOLVED_SELECTOR'], 'the ungrounded target surfaces as an UNRESOLVED_SELECTOR diagnostic');
  eq(finalState.compilation.diagnostics[0]?.target, 'GhostControl', 'the diagnostic names the offending target');
  eq(finalState.compilation.scripts, [], 'no script is emitted for the failed case (never a guessed locator)');
  const unresolved = finalState.errors.find((e) => e.class === 'TARGET_UNRESOLVED');
  ok(!!unresolved, 'a TARGET_UNRESOLVED error reached state for graph-level routing');
  ok(Array.isArray(unresolved?.details?.targets) && (unresolved?.details?.targets as string[]).includes('GhostControl'),
    'the error carries the distinct rediscovery targets');
  eq(finalState.plansByCase['case-1']?.status, 'planned', 'the plan itself authored fine — the failure is a compile-grounding failure');
  eq(readArtifacts(runId).compiledSources, {}, 'no compiled source stashed for the failed case');
}

// ---------------------------------------------------------------------------
function testStrictNoDrop() {
  console.log('3. Strict no-drop — parseTestPlanStrict fails loudly where legacy parseTestPlan silently drops');

  eq(TEST_PLAN_SCHEMA_VERSION, 2, 'strict schema variant is versioned (v2)');
  const invalid = {
    mission: MISSION.executionScope,
    steps: [
      { action: 'CLICK', target: 'New' },
      { action: 'SCROLL', target: 'Search' }, // invalid verb — the legacy normalizer drops this step
    ],
  };
  const strict = parseTestPlanStrict(invalid);
  eq(strict.plan, null, 'strict parse rejects the WHOLE plan when any step has an invalid verb');
  ok(strict.issues.some((i) => i.includes('step 2') && i.includes('SCROLL')), `issues quote the offending step + verb (${JSON.stringify(strict.issues)})`);
  const legacy = parseTestPlan(invalid);
  eq(legacy?.steps.length, 1, 'legacy tolerant parse silently drops the invalid step — the exact regression the strict graph path forbids');
  eq((legacy?.steps[0] as { action?: string })?.action, 'CLICK', 'legacy kept only the valid step, losing behavior without a trace');
}

// ---------------------------------------------------------------------------
async function testNoEvidenceGuard() {
  console.log('4. No-evidence guard — empty stash ends the graph with an explicit INVARIANT error');

  const runId = 'run-authoring-no-stash-1';
  clearArtifacts(runId);
  let caseCalls = 0, planCalls = 0;
  const graph = buildTestAuthoringGraph({
    authorCases: async () => { caseCalls++; return { cases: STUB_CASES, usage: [], errors: [] }; },
    authorPlan: async () => { planCalls++; return { plan: CLEAN_PLAN, usage: [], errors: [] }; },
  });
  const finalState = (await graph.invoke(fixtureInvokeInput(runId))) as WorkflowState;

  ok(true, 'graph terminated without throwing');
  eq(caseCalls, 0, 'the case-authoring model is never called without stashed evidence');
  eq(planCalls, 0, 'plan authoring never ran');
  eq(finalState.cases, [], 'no cases were authored');
  const inv = finalState.errors.find((e) => e.class === 'INVARIANT_VIOLATION');
  ok(!!inv && inv.nodeName === 'author_cases', 'INVARIANT_VIOLATION is attributed to author_cases');
  ok((inv?.message ?? '').includes('discovery/grounding'), 'the error tells the operator to route back through rediscovery');
  eq(finalState.compilation.scripts, [], 'compilation never produced scripts');
  eq(finalState.stage, 'author_cases', 'the graph ended right after author_cases');
}

// ---------------------------------------------------------------------------
async function testCheckpointRefsOnly(happy: { graph: ReturnType<typeof buildTestAuthoringGraph>; threadId: string; runId: string }) {
  console.log('5. Checkpoint — persisted state holds refs/digests only; no plan bodies, no compiled source');

  const snapshot = await happy.graph.getState({ configurable: { thread_id: happy.threadId } });
  const persisted = snapshot.values as WorkflowState;
  const json = JSON.stringify(persisted);

  const compiled = readArtifacts(happy.runId).compiledSources?.['case-1'] ?? '';
  ok(compiled.includes('#search-box'), 'sanity: the distinctive marker exists in the stashed compiled source');
  ok(!json.includes('#search-box'), 'compiled-source marker (verified selector) does NOT appear in persisted state');
  ok(!json.includes('OPEN_MODULE'), 'plan steps do NOT appear in persisted state');
  ok(!json.includes('acme'), 'plan step values do NOT appear in persisted state');
  ok(Object.values(persisted.plansByCase).every((r) => !('steps' in (r as object)) && /^[0-9a-f]{40}$/.test(r.planRef ?? '')),
    'persisted plansByCase entries are digest refs, never plan bodies');
  eq(persisted.compilation.scripts.map((s) => s.caseId), ['case-1', 'case-2'], 'persisted compilation carries the bounded script refs');

  let threw = false;
  try { assertNoSecretLeakage(persisted); } catch { threw = true; }
  ok(!threw, 'assertNoSecretLeakage passes over the persisted checkpoint state');
}

// ---------------------------------------------------------------------------
async function main() {
  const happy = await testHappyPath();
  await testUnresolvedTarget();
  testStrictNoDrop();
  await testNoEvidenceGuard();
  await testCheckpointRefsOnly(happy);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
