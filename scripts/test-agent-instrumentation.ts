/**
 * P1 golden test — full-fidelity run instrumentation (server/agent-core/bus/runInstrumentation).
 * Drives a realistic sequence of stage transitions through recordRunStageProgress with real WorkflowState
 * artifacts and asserts the emitted A2A transcript: HANDOFFs from the orchestrator, RESULTs voiced by the
 * owning specialist carrying the concrete artifact, and matching append-only blackboard facts. Also proves
 * the flag gate (OFF → no emission). Pure — in-memory bus/blackboard, no browser/network/DB.
 *   npx tsx scripts/test-agent-instrumentation.ts
 */
import { InMemoryBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, setMessageBus, getMessageBus } from '../server/agent-core/bus/messageBus';
import { setBlackboard, getBlackboard } from '../server/agent-core/bus/blackboard';
import { recordRunStageProgress, recordRunTerminal } from '../server/agent-core/bus/runInstrumentation';
import { createInitialWorkflowState, type WorkflowState } from '../server/features/agent/workflow/state';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

function baseState(): WorkflowState {
  return createInitialWorkflowState({
    runId: 'run-instr', threadId: 'run-instr', requestId: 'req', tenantId: 't', workspaceId: 'w', projectId: 'p',
    requestedBy: 'system',
    request: { goal: 'Test the List View', requestedCaseCount: 2, reviewPolicy: 'auto', executionPolicy: 'auto' },
    mission: { platformType: 'ADMIN', platform: 'local', runtimeSurface: null, applicationId: 'crm', moduleId: null, tabId: null, targetUrl: 'http://localhost:5002', executionScope: 'List View' },
  });
}

async function main() {
  const RUN = 'run-instr';

  console.log('Flag OFF — instrumentation is inert');
  {
    delete process.env.AGENT_NATIVE_V1;
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    await recordRunStageProgress(RUN, baseState(), 'load_context', 'running', 'validate_request');
    ok((await getMessageBus().history(RUN)).length === 0, 'no messages published when AGENT_NATIVE_V1 is off');
    ok((await getBlackboard().all(RUN)).length === 0, 'no blackboard facts written when the flag is off');
  }

  console.log('Flag ON — a real run transcript is emitted');
  {
    process.env.AGENT_NATIVE_V1 = '1';
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());

    // Walk the graph the way the pump does: each call reports the stage we ENTER + the stage that just finished.
    const s = baseState();
    await recordRunStageProgress(RUN, s, 'validate_request', 'running', null);

    s.stage = 'load_context'; s.context = { ...s.context, metadata: { ref: 'r', digest: 'd', objectCount: 13, source: 'live' } };
    await recordRunStageProgress(RUN, s, 'load_context', 'running', 'validate_request');

    s.stage = 'discover_and_ground';
    s.evidence = { ...s.evidence, countsByProvenance: { live: 42, cached: 0, inferred: 0, unverified: 0 }, targetCatalog: [{ semanticName: 'grid', evidenceKind: 'UI', confidence: 'verified-live' }] };
    await recordRunStageProgress(RUN, s, 'discover_and_ground', 'running', 'load_context');

    s.stage = 'author_cases';
    s.cases = [{ id: 'c1', title: 'Open the List View' }, { id: 'c2', title: 'Filter the grid' }];
    await recordRunStageProgress(RUN, s, 'author_cases', 'running', 'discover_and_ground');

    s.stage = 'execute_tests'; s.status = 'completed';
    s.execution = { attempts: [], aggregate: { totalCases: 2, passed: 2, failed: 0, durationMs: 4200 }, evidenceRefs: [] };
    await recordRunStageProgress(RUN, s, 'execute_tests', 'running', 'author_cases');
    // Terminal flush — the pump does this so the final stage's RESULT reaches the transcript.
    await recordRunTerminal(RUN, s);

    const history = await getMessageBus().history(RUN);
    const facts = await getBlackboard().all(RUN);

    ok(history.length > 0, 'messages were published');
    ok(history.some((m) => m.type === 'HANDOFF' && m.from === 'orchestrator' && m.to === 'MetadataFetch'), 'orchestrator HANDOFFs the load_context stage to MetadataFetch');
    ok(history.some((m) => m.type === 'HANDOFF' && m.to === 'TestGenerationAgent'), 'author_cases is handed to TestGenerationAgent');

    const metaResult = history.find((m) => m.type === 'RESULT' && m.from === 'MetadataFetch');
    ok(!!metaResult && (metaResult.payload as any).objectCount === 13, 'MetadataFetch RESULT carries the real object count (13)');

    const caseResult = history.find((m) => m.type === 'RESULT' && m.from === 'TestGenerationAgent');
    ok(!!caseResult && (caseResult.payload as any).count === 2, 'TestGenerationAgent RESULT reports 2 authored cases');
    ok(!!caseResult && Array.isArray((caseResult.payload as any).titles) && (caseResult.payload as any).titles.includes('Filter the grid'), 'the RESULT carries the real case titles, not a template');

    const execResult = history.find((m) => m.type === 'RESULT' && m.from === 'EvidenceAgent');
    ok(!!execResult && (execResult.payload as any).passed === 2 && (execResult.payload as any).failed === 0, 'EvidenceAgent RESULT reports the real 2-pass/0-fail verdict');

    ok(facts.some((f) => f.kind === 'stage.result.author_cases' && (f.value as any).count === 2), 'a blackboard fact records the authored cases (shared, not re-derived)');
    ok(facts.filter((f) => f.kind === 'run.stage').length === 5, 'every stage boundary appends a run.stage fact');

    // Every RESULT is provenance-consistent: emitted by the same specialist that owns the completed stage.
    ok(history.filter((m) => m.type === 'RESULT').every((m) => m.from !== 'orchestrator'), 'RESULTs are voiced by specialists, never the orchestrator');
  }

  setMessageBus(null);
  setBlackboard(null);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
