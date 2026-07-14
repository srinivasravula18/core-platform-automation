/**
 * Phase 3 exit-gate tests — the discovery graph (workflow/graphs/discoveryGraph.ts) composing the
 * context → discover_and_ground topology with its bounded rediscovery cycle, plus the underlying
 * node contracts (grounding projection/gate, context invariant) it depends on.
 *
 * Convention: standalone tsx script, no jest/vitest (see test-agent-workflow-state.ts). Run with:
 *   npx tsx scripts/test-agent-discovery-graph.ts   (or: npm run test:agent-discovery-graph)
 * Exits 0 if all pass, 1 on first failure.
 *
 * Sections 1-8 are fully offline (hand-built VerifiedElement fixtures + stubbed context/discovery;
 * grounding and the LangGraph machinery are always REAL). Section 9 is a genuine browser end-to-end
 * against an ephemeral local http server (the core-platform target is offline in this environment);
 * it pre-flights a Chromium launch and prints a one-line skip — not a failure — if none is possible.
 */
import '../server/shared/env';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { MemorySaver } from '@langchain/langgraph';
import { buildDiscoveryGraph, routeAfterDiscoverAndGround } from '../server/features/agent/workflow/graphs/discoveryGraph';
import { runContextNode } from '../server/features/agent/workflow/nodes/context';
import { runDiscoveryNode, type DiscoveryPageSummary } from '../server/features/agent/workflow/nodes/discovery';
import { runGroundingNode, MAX_REDISCOVERY_ATTEMPTS } from '../server/features/agent/workflow/nodes/grounding';
import {
  createInitialWorkflowState,
  assertNoSecretLeakage,
  type MissionRef,
  type WorkflowEvidence,
  type WorkflowState,
} from '../server/features/agent/workflow/state';
import type { VerifiedElement } from '../server/features/agent/domExplorer';
import { launchChromiumWithRetry } from '../server/shared/browser';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Hand-built VerifiedElement; overrides shape each of the four verification statuses. */
function makeElement(overrides: Partial<VerifiedElement>): VerifiedElement {
  return {
    id: 'save_record_button', tag: 'button', role: 'button', name: 'Save record', text: 'Save record',
    aria_label: null, placeholder: null, input_name: null, data_field: null, element_id: 'save-record',
    type: null, value: null, options: [], href: null, tooltip: null, interactive: true,
    resolved_selector: '#save-record', selector_strategy: 'id', fallback_selector: null,
    unique: true, visible: true, status: 'verified',
    state: { disabled: false, readonly: false, required: false },
    ...overrides,
  };
}

/** One element per status: verified / not_unique / broken / unresolvable. */
function fixtureElements(): VerifiedElement[] {
  return [
    makeElement({}),
    makeElement({ id: 'cancel_button', name: 'Cancel', text: 'Cancel', element_id: null, resolved_selector: 'text="Cancel"', selector_strategy: 'text', unique: false, status: 'not_unique' }),
    makeElement({ id: 'ghost_button', name: 'Ghost', text: 'Ghost', element_id: 'ghost', resolved_selector: '#ghost', unique: false, visible: false, status: 'broken' }),
    makeElement({ id: 'mystery_el', name: null, text: null, element_id: null, resolved_selector: null, selector_strategy: 'unresolvable', unique: false, visible: false, status: 'unresolvable' }),
  ];
}

function fixtureMission(targetUrl: string): MissionRef {
  return {
    platformType: 'RUNTIME', platform: 'Keystone', runtimeSurface: 'keystone', applicationId: 'app-fixture-1',
    moduleId: null, tabId: null, targetUrl, executionScope: 'RUNTIME/keystone/app-fixture-1',
  };
}

/** Full initial state minus plansByCase: that channel's UPDATE type is per-case (reducer), so an empty Record can't be passed as invoke input — the channel default supplies {}. */
function fixtureInvokeInput(runId: string, targetUrl: string) {
  const state = createInitialWorkflowState({
    runId, threadId: `thread-${runId}`, requestId: `req-${runId}`,
    tenantId: 'tenant-1', workspaceId: 'ws-1', projectId: 'proj-1', applicationId: 'app-fixture-1',
    requestedBy: 'user-1',
    request: { goal: 'Discover the fixture page', requestedCaseCount: 0, reviewPolicy: 'auto', executionPolicy: 'skip' },
    mission: fixtureMission(targetUrl),
    credentialRef: { websiteId: 'site-1', role: 'admin' },
  });
  const { plansByCase: _plansByCase, ...input } = state;
  return input;
}

/** Offline context stub — the real node would fetch metadata over HTTP against the fake targetUrl. */
const stubContextNode: typeof runContextNode = async () => ({
  context: { metadata: { ref: 'app-fixture-1', digest: 'stub-metadata-digest', objectCount: 3, source: 'cached' as const } },
  errors: [],
});

const EMPTY_PAGE_SUMMARY: DiscoveryPageSummary = { url: '', title: '', headingCount: 0, tableCount: 0, formCount: 0, bodyTextExcerpt: '' };

/** Discovery stub factory: returns per-call element batches (last batch repeats) and counts invocations. */
function stubDiscovery(batches: VerifiedElement[][]) {
  let calls = 0;
  const node: typeof runDiscoveryNode = async () => {
    const batch = batches[Math.min(calls, batches.length - 1)] ?? [];
    calls += 1;
    return { elements: batch, pageSummary: EMPTY_PAGE_SUMMARY, screenshotRef: null, errors: [] };
  };
  return { node, count: () => calls };
}

// ---------------------------------------------------------------------------
function testGroundingProjection() {
  console.log('1. Grounding projection over hand-built VerifiedElement fixtures (pure, no browser)');

  const result = runGroundingNode({ elements: fixtureElements(), metadataDigest: 'meta-digest-1', rediscoveryAttempts: 0 });

  const promoted = result.verifiedSelectors.filter((vs) => vs.verified);
  eq(promoted.length, 1, 'exactly one selector is promoted to verified: true');
  eq(promoted[0]?.id, 'save_record_button', 'the promoted selector is the live-verified unique visible one');
  eq(promoted[0]?.confidence, 'verified-live', 'the promoted selector carries verified-live confidence');
  const demoted = result.verifiedSelectors.filter((vs) => !vs.verified);
  eq(demoted.length, 3, 'not_unique/broken/unresolvable all stay verified: false');
  ok(demoted.every((vs) => vs.confidence !== 'verified-live'), 'no demoted selector claims verified-live confidence');

  eq(result.evidence.targetCatalog.length, 1, 'targetCatalog admits exactly the one verified element');
  eq(result.evidence.targetCatalog[0], { semanticName: 'SaveRecord', evidenceKind: 'UI', confidence: 'verified-live' },
    'catalog entry has the PascalCase semanticName + UI kind + verified-live confidence');

  eq(result.evidence.countsByProvenance, { live: 1, cached: 0, inferred: 0, unverified: 3 }, 'countsByProvenance is {live: 1, unverified: 3}');

  ok(typeof result.evidence.registryRef === 'string' && result.evidence.registryRef.length > 0, 'registryRef is a non-empty digest string');
  ok(typeof result.evidence.evidenceGraphRef === 'string' && result.evidence.evidenceGraphRef.length > 0, 'evidenceGraphRef is a non-empty digest string');
  eq(result.evidence.metadataGraphRef, 'meta-digest-1', 'metadataGraphRef carries the context metadata digest');

  const again = runGroundingNode({ elements: fixtureElements(), metadataDigest: 'meta-digest-1', rediscoveryAttempts: 0 });
  eq(again.evidence.registryRef, result.evidence.registryRef, 'same input produces the same registryRef (stable digest)');
  eq(result.errors, [], 'clean projection returns no errors');
}

// ---------------------------------------------------------------------------
function testGateDecisions() {
  console.log('2. Evidence gate decisions + fail-safe');

  eq(MAX_REDISCOVERY_ATTEMPTS, 2, 'MAX_REDISCOVERY_ATTEMPTS is 2 (per the architecture plan retry table)');
  eq(runGroundingNode({ elements: fixtureElements(), rediscoveryAttempts: 0 }).evidence.gate?.decision, 'continue', 'catalog >= 1 gates continue');
  eq(runGroundingNode({ elements: [], rediscoveryAttempts: 0 }).evidence.gate?.decision, 'targeted_retry', 'empty catalog + attempts 0 gates targeted_retry');
  eq(runGroundingNode({ elements: [], rediscoveryAttempts: 1 }).evidence.gate?.decision, 'targeted_retry', 'empty catalog + attempts 1 gates targeted_retry');
  eq(runGroundingNode({ elements: [], rediscoveryAttempts: 2 }).evidence.gate?.decision, 'blocked', 'empty catalog + attempts 2 gates blocked');

  // A circular ref in a projected field makes the node's sha1 JSON.stringify digest throw internally.
  const circular = makeElement({}) as any;
  circular.name = circular;
  const failSafe = runGroundingNode({ elements: [circular as VerifiedElement], rediscoveryAttempts: 0 });
  eq(failSafe.errors[0]?.class, 'INVARIANT_VIOLATION', 'internal projection throw is classified INVARIANT_VIOLATION');
  eq(failSafe.evidence.gate?.decision, 'blocked', 'fail-safe gate is blocked, never continue');
  eq(failSafe.evidence.targetCatalog, [], 'fail-safe evidence carries no catalog entries');
}

// ---------------------------------------------------------------------------
async function testContextInvariant() {
  console.log('3. Context node mission invariant');

  const result = await runContextNode({ mission: null });
  eq(result.context.metadata, null, 'metadata stays null without a mission');
  eq(result.errors[0]?.class, 'INVARIANT_VIOLATION', 'missing mission classifies INVARIANT_VIOLATION (no network attempted)');
  eq(result.errors[0]?.nodeName, 'context', 'error is attributed to the context node');
}

// ---------------------------------------------------------------------------
function testRouter() {
  console.log('4. Gate router (exported, unit-tested directly)');

  const withGate = (decision: 'continue' | 'targeted_retry' | 'blocked' | null): Pick<WorkflowState, 'evidence'> => ({
    evidence: {
      registryRef: null, metadataGraphRef: null, evidenceGraphRef: null,
      countsByProvenance: { live: 0, cached: 0, inferred: 0, unverified: 0 },
      targetCatalog: [],
      gate: decision ? { decision, reasons: [], missingRequirements: [] } : null,
    },
  });
  eq(routeAfterDiscoverAndGround(withGate('continue')), 'continue', "gate 'continue' routes to the END mapping");
  eq(routeAfterDiscoverAndGround(withGate('blocked')), 'blocked', "gate 'blocked' routes to the END mapping");
  eq(routeAfterDiscoverAndGround(withGate('targeted_retry')), 'targeted_retry', "gate 'targeted_retry' routes back to discover_and_ground");
  eq(routeAfterDiscoverAndGround(withGate(null)), 'blocked', 'a missing gate fails safe to blocked-semantics (END)');
  eq(routeAfterDiscoverAndGround({ evidence: undefined as unknown as WorkflowEvidence }), 'blocked', 'missing evidence entirely also fails safe to blocked');
}

// ---------------------------------------------------------------------------
async function testGraphHappyPath() {
  console.log('5. Graph topology — happy path (stubbed context/discovery, real grounding)');

  const stub = stubDiscovery([[makeElement({})]]);
  const graph = buildDiscoveryGraph({ contextNode: stubContextNode, discoveryNode: stub.node });
  const finalState = (await graph.invoke(fixtureInvokeInput('run-happy-1', 'http://fixture.invalid/app'))) as WorkflowState;

  eq(finalState.evidence.gate?.decision, 'continue', 'final gate is continue');
  eq(finalState.rediscoveryAttempts, 0, 'no rediscovery attempts consumed');
  eq(finalState.evidence.targetCatalog.length, 1, 'targetCatalog carries the one verified element');
  eq(finalState.stage, 'discovery', 'stage reflects the last node');
  eq(stub.count(), 1, 'discovery ran exactly once');
  eq(finalState.context.metadata?.digest, 'stub-metadata-digest', 'context metadata written by the context node survives');
  eq(finalState.evidence.metadataGraphRef, 'stub-metadata-digest', 'grounding carried the context metadata digest into evidence');
}

// ---------------------------------------------------------------------------
async function testGraphExhaustedRediscovery() {
  console.log('6. Graph topology — exhausted rediscovery (bounded cycle)');

  const stub = stubDiscovery([[]]);
  const graph = buildDiscoveryGraph({ contextNode: stubContextNode, discoveryNode: stub.node });
  const finalState = (await graph.invoke(fixtureInvokeInput('run-exhausted-1', 'http://fixture.invalid/app'))) as WorkflowState;

  ok(true, 'graph terminated (no infinite loop)');
  eq(stub.count(), 1 + MAX_REDISCOVERY_ATTEMPTS, 'discovery ran exactly 3 times (initial + 2 retries)');
  eq(finalState.evidence.gate?.decision, 'blocked', 'final gate is blocked after exhaustion');
  eq(finalState.rediscoveryAttempts, MAX_REDISCOVERY_ATTEMPTS, 'rediscoveryAttempts is 2');
}

// ---------------------------------------------------------------------------
async function testGraphRecoverOnRetry() {
  console.log('7. Graph topology — recover on retry');

  const stub = stubDiscovery([[], [makeElement({})]]);
  const graph = buildDiscoveryGraph({ contextNode: stubContextNode, discoveryNode: stub.node });
  const finalState = (await graph.invoke(fixtureInvokeInput('run-recover-1', 'http://fixture.invalid/app'))) as WorkflowState;

  eq(stub.count(), 2, 'discovery ran exactly twice (initial + 1 retry)');
  eq(finalState.evidence.gate?.decision, 'continue', 'final gate is continue after the retry recovered');
  eq(finalState.rediscoveryAttempts, 1, 'exactly one rediscovery attempt was consumed');
  eq(finalState.evidence.targetCatalog.length, 1, 'the retry batch reached the target catalog');
}

// ---------------------------------------------------------------------------
async function testCheckpointRoundTrip() {
  console.log('8. Checkpoint round-trip (MemorySaver) + secret-leakage proof');

  const SECRET = 'S3CRET-MARKER';
  let credentialSeenByNode: string | undefined;
  const stub = stubDiscovery([[makeElement({})]]);
  const spyDiscovery: typeof runDiscoveryNode = async (input) => {
    credentialSeenByNode = input.credential?.password;
    return stub.node(input);
  };

  const graph = buildDiscoveryGraph(
    {
      contextNode: stubContextNode,
      discoveryNode: spyDiscovery,
      resolveCredential: async () => ({ username: 'tester', password: SECRET }),
    },
    { checkpointer: new MemorySaver() },
  );
  const threadId = 'thread-checkpoint-1';
  await graph.invoke(fixtureInvokeInput('run-checkpoint-1', 'http://fixture.invalid/app'), { configurable: { thread_id: threadId } });

  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  const persisted = snapshot.values as WorkflowState;
  eq(persisted.evidence.gate?.decision, 'continue', 'persisted state carries the final gate');
  eq(persisted.evidence.targetCatalog.length, 1, 'persisted state carries the target catalog');
  eq(persisted.rediscoveryAttempts, 0, 'persisted rediscoveryAttempts survived the round-trip');
  ok(credentialSeenByNode === SECRET, 'discovery received the just-in-time resolved credential inside the node');

  let threw = false;
  try { assertNoSecretLeakage(persisted); } catch { threw = true; }
  ok(!threw, 'assertNoSecretLeakage passes over the persisted checkpoint state');
  ok(!JSON.stringify(persisted).includes(SECRET), 'the resolved secret never reached checkpointed state');
}

// ---------------------------------------------------------------------------
const FIXTURE_HTML = `<!doctype html>
<html>
<head><title>Discovery Graph Fixture</title></head>
<body>
  <h1>Inventory Console</h1>
  <table>
    <thead><tr><th>Item</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>Widget A</td><td>Active</td></tr>
      <tr><td>Widget B</td><td>Retired</td></tr>
    </tbody>
  </table>
  <button id="refresh-list">Refresh list</button>
  <button id="new-item">New item</button>
  <button id="export-csv">Export CSV</button>
  <form>
    <label for="search-box">Search items</label>
    <input id="search-box" name="search" placeholder="Search items" />
  </form>
</body>
</html>`;

async function testLiveBrowserEndToEnd() {
  console.log('9. Live browser end-to-end (real nodes, ephemeral local server)');

  // Pre-flight: the discovery node classifies launch failures internally (it never throws), so a
  // broken browser environment must be detected here and skipped — not misread as a gate regression.
  try {
    const probe = await launchChromiumWithRetry({ headless: true });
    await probe.close();
  } catch (err) {
    console.log(`  ⊘ skipped — Chromium cannot launch in this environment (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
    return;
  }

  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FIXTURE_HTML); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  try {
    // Real nodes end-to-end; credential-less. The real context node finds no metadata API on the
    // fixture server (metadata null + a transient error) — by design that never blocks discovery.
    const graph = buildDiscoveryGraph({ resolveCredential: async () => undefined });
    const finalState = (await graph.invoke(fixtureInvokeInput(`test-discovery-graph-${Date.now()}`, targetUrl))) as WorkflowState;

    eq(finalState.evidence.gate?.decision, 'continue', 'live run gates continue');
    ok(finalState.evidence.targetCatalog.length > 0, `live targetCatalog is non-empty (${finalState.evidence.targetCatalog.length} targets)`);
    ok(finalState.evidence.countsByProvenance.live > 0, `elements were live-verified (live count ${finalState.evidence.countsByProvenance.live})`);
    eq(finalState.rediscoveryAttempts, 0, 'no rediscovery attempts were needed');
    eq(finalState.stage, 'discovery', 'stage reflects the last node');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
async function main() {
  testGroundingProjection();
  testGateDecisions();
  await testContextInvariant();
  testRouter();
  await testGraphHappyPath();
  await testGraphExhaustedRediscovery();
  await testGraphRecoverOnRetry();
  await testCheckpointRoundTrip();
  await testLiveBrowserEndToEnd();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
