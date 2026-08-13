/**
 * Phase 6 exit-gate tests — artifacts survive a process restart.
 * Proves: a durable stash write is awaited and readable; a COLD process rehydrates a run's artifacts
 * before any node reads them; hydration is idempotent; a capability result survives the restart so the
 * resumed run cannot execute twice.
 *   npx tsx scripts/test-agent-artifact-durability.ts
 */
import { InMemoryBlackboard, setBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, setMessageBus } from '../server/agent-core/bus/messageBus';
import { clearArtifacts, hydrateRunArtifacts, readArtifacts, stashArtifacts, stashArtifactsDurable } from '../server/features/agent/workflow/artifactStash';
import { invokeCapability, resetCapabilityInvocations } from '../server/agent-core/registry/capabilities';
import { hydrateArtifactsFromRunStore } from '../server/agent-core/runstore/runStoreMirror';
import { digestOf } from '../server/agent-core/orchestration/contracts';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const RUN = `run-dur-${Date.now()}`;
const GRAPH = { nodes: [{ semanticName: 'NewButton', label: 'New Button' }], edges: [], selectorRegistryRef: 'selector_registry' } as never;
const SELECTORS = [{ id: 'sel_new', selector: '#new', verified: true }] as never;

async function main() {
  console.log('A durable write is awaited, so the artifact is really there');
  {
    await stashArtifactsDurable(RUN, { evidenceGraph: GRAPH, verifiedSelectors: SELECTORS });
    const durable = await hydrateArtifactsFromRunStore(RUN);
    ok(!!durable.evidenceGraph, 'the evidence graph reached the durable store before the call returned');
    ok(!!durable.verifiedSelectors, 'the verified selectors reached it too');
    eq(readArtifacts(RUN).evidenceGraph, GRAPH, 'the in-process stash still serves the hot path');
  }

  console.log('A COLD process rehydrates the run before any node reads it');
  {
    // Simulate a restart: the stash dies with the process, the durable store does not.
    clearArtifacts(RUN);
    eq(readArtifacts(RUN), {}, 'a fresh process starts with an empty stash');

    const rehydrated = await hydrateRunArtifacts(RUN);
    ok(!!rehydrated.evidenceGraph, 'the resumed worker recovers the evidence graph');
    ok(!!rehydrated.verifiedSelectors, 'and the verified selectors');
    eq(digestOf(readArtifacts(RUN).evidenceGraph), digestOf(GRAPH), 'the recovered artifacts are readable through the normal path');
  }

  console.log('Hydration is idempotent and never clobbers newer in-process work');
  {
    stashArtifacts(RUN, { compiledSources: { 'case-1': 'test("a", async () => {});' } });
    const again = await hydrateRunArtifacts(RUN);
    ok(!!again.compiledSources?.['case-1'], 'a second hydration leaves newer stash content intact');
    ok(!!again.evidenceGraph, 'and keeps what was already recovered');
  }

  console.log('Per-case artifacts merge across writes instead of clobbering siblings');
  {
    const run2 = `${RUN}-merge`;
    await stashArtifactsDurable(run2, { compiledSources: { a: 'A' } });
    await stashArtifactsDurable(run2, { compiledSources: { b: 'B' } });
    clearArtifacts(run2);
    const recovered = await hydrateRunArtifacts(run2);
    eq(Object.keys(recovered.compiledSources ?? {}).sort(), ['a', 'b'], 'both per-case sources survive the restart');
  }

  console.log('A capability result survives the restart, so the resumed run cannot execute twice');
  {
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    resetCapabilityInvocations();
    const run3 = `${RUN}-cap`;
    let runs = 0;
    const invoke = () => invokeCapability({
      runId: run3, capability: 'execute_scripts', idempotencyKey: 'execute:digest-z:0',
      requestSummary: 'Execute 2 scripts.',
      handler: async () => { runs++; return { total: 2, passed: 2, failed: 0 }; },
      summarize: (v) => ({ summary: `Ran ${v.total}.`, value: v }),
    });
    const first = await invoke();
    eq(first.executed, true, 'the first process executed the scripts');

    // "Restart": drop the in-process memo but keep the durable accepted fact.
    resetCapabilityInvocations();
    const second = await invoke();
    eq(second.executed, false, 'after a restart the capability is NOT executed again');
    eq(runs, 1, 'the side effect happened exactly once across the restart');
    eq(second.result, first.result, 'the resumed run reads the original result');
  }

  console.log('A run with nothing durable hydrates to empty, never to a guess');
  {
    const empty = `${RUN}-empty`;
    const r = await hydrateRunArtifacts(empty);
    eq(r, {}, 'an unknown run rehydrates to nothing rather than inventing artifacts');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
