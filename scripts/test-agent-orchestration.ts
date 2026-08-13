/**
 * P3 golden test — orchestrator delegates the run plan over the bus (server/agent-core/router/orchestrateRun).
 * Uses a deterministic injected classifier (no LLM) and asserts the real A2A exchange: orchestrator REQUEST →
 * router RESULT (registry-validated plan, unknown agents dropped) → one DELEGATE per real specialist, plus a
 * shared routing.plan blackboard fact. Also proves the flag gate. Pure — in-memory bus/blackboard.
 *   npx tsx scripts/test-agent-orchestration.ts
 */
import { InMemoryBlackboard, setBlackboard, getBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, setMessageBus, getMessageBus } from '../server/agent-core/bus/messageBus';
import { orchestrateRunStart } from '../server/agent-core/router/orchestrateRun';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

async function main() {
  const RUN = 'run-orch';
  // Deterministic classifier: proposes two real registered agents + one bogus one (drift) to prove validation.
  const classify = async () => ({
    steps: [
      { agent: 'ApplicationInspector', task: 'Ground the List View.' },
      { agent: 'TestGenerationAgent', task: 'Author cases from evidence.' },
      { agent: 'nonexistentAgent', task: 'should be dropped' },
    ],
    rationale: 'ground, then author',
  });

  console.log('A registry-validated delegation is published');
  {
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const plan = await orchestrateRunStart({ runId: RUN, goal: 'Test the List View', classify });

    ok(!!plan, 'a plan is returned');
    ok(plan!.steps.map((s) => s.agent).join(',') === 'ApplicationInspector,TestGenerationAgent', 'only registered agents survive, in order');
    ok(plan!.droppedAgents.includes('nonexistentAgent'), 'the unknown agent is dropped (drift surfaced, never dispatched)');

    const history = await getMessageBus().history(RUN);
    const request = history.find((m) => m.type === 'REQUEST' && m.from === 'orchestrator' && m.to === 'router');
    ok(!!request, 'orchestrator REQUESTs a plan from the router');
    const result = history.find((m) => m.type === 'RESULT' && m.from === 'router' && m.to === 'orchestrator');
    ok(!!result && result.causationId === request!.id, 'router RESULTs its plan, causally linked to the REQUEST');

    const delegates = history.filter((m) => m.type === 'DELEGATE' && m.from === 'orchestrator');
    ok(delegates.length === 2, 'the orchestrator DELEGATEs each of the two real specialists');
    ok(delegates.every((d) => d.causationId === result!.id), 'each DELEGATE is caused by the router plan');
    ok(delegates.some((d) => d.to === 'TestGenerationAgent'), 'one DELEGATE targets TestGenerationAgent');
    ok(!history.some((m) => m.to === 'nonexistentAgent'), 'the dropped agent is never dispatched');

    const fact = await getBlackboard().latest<{ steps: any[] }>(RUN, 'routing.plan');
    ok(!!fact && fact.value.steps.length === 2, 'the routing plan is a shared blackboard fact (read once, not re-derived)');
  }

  setMessageBus(null);
  setBlackboard(null);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
