/**
 * Pre-run attribution — the ledger reflects work that really happened, and nothing else.
 * The repo/scope/requirements work runs in the pre-run understanding flow, outside the graph. Adopting
 * it must record real provenance, never claim an agent thread ran, and never invent work that is absent.
 *   npx tsx scripts/test-agent-prerun-attribution.ts
 */
import { InMemoryBlackboard, setBlackboard, getBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, setMessageBus } from '../server/agent-core/bus/messageBus';
import { attributePreRunUnderstanding, planMissionForRun, settleOpenTasks } from '../server/features/agent/workflow/nodes/agentCoordination';
import { emptyOrchestration, type WorkflowOrchestration } from '../server/features/agent/workflow/state';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const RUN = 'run-attr';
const UNDERSTANDING = 'Target: Admin. Task: test the Apps list view. The list view supports sorting, filters, and column configuration.';

function freshOrchestration(): WorkflowOrchestration {
  setMessageBus(new InMemoryMessageBus());
  setBlackboard(new InMemoryBlackboard());
  const planned = planMissionForRun({ runId: RUN, goal: 'test the apps list view', missionKind: 'deep_test_run' });
  return { ...emptyOrchestration(), ...planned } as WorkflowOrchestration;
}

async function main() {
  console.log('Adopting real pre-run work');
  {
    const orch = freshOrchestration();
    eq(orch.tasks.map_repo.status, 'queued', 'repo mapping starts queued');
    const adopted = await attributePreRunUnderstanding({ runId: RUN, understanding: UNDERSTANDING, orchestration: orch });

    ok(!!adopted, 'work is adopted when an understanding exists');
    eq(Object.keys(adopted!.tasks ?? {}).sort(), ['author_requirements', 'map_repo', 'resolve_scope'],
      'exactly the three stages the pre-run flow performs are adopted');
    ok(Object.values(adopted!.tasks ?? {}).every((t) => t.status === 'accepted'), 'each adopted task reads accepted, not skipped');

    // The whole point: honest attribution. No agent thread ran, so nothing may claim one did.
    ok(Object.values(adopted!.tasks ?? {}).every((t) => t.agentInstanceId === null),
      'no adopted task claims an agent instance — no model thread executed');

    const facts = await getBlackboard().all(RUN);
    eq(facts.map((f) => f.kind).sort(), ['evidence.repository', 'requirements.draft', 'scope.resolved'],
      'one accepted fact per adopted stage');
    ok(facts.every((f) => f.status === 'accepted'), 'adopted facts are authoritative');
    ok(facts.every((f) => f.provenance.by === 'PreRunUnderstanding'),
      'provenance names the understanding flow, never an agent display name');
    ok(facts.every((f) => !!f.taskId), 'each fact is bound to the task it satisfies');
    eq(adopted!.acceptedFactRefs?.length, 3, 'the accepted refs are returned for the ledger');
  }

  console.log('Nothing is invented when there is nothing to adopt');
  {
    const orch = freshOrchestration();
    eq(await attributePreRunUnderstanding({ runId: RUN, understanding: '', orchestration: orch }), null,
      'an empty understanding adopts nothing');
    eq(await attributePreRunUnderstanding({ runId: RUN, understanding: '   ', orchestration: orch }), null,
      'a whitespace-only understanding adopts nothing');
    eq((await getBlackboard().all(RUN)).length, 0, 'no facts are written when no work was done');
    eq(await attributePreRunUnderstanding({ runId: RUN, understanding: UNDERSTANDING, orchestration: undefined }), null,
      'with no plan there is no ledger to attribute against');
  }

  console.log('Adoption never overwrites work the run itself performed');
  {
    const orch = freshOrchestration();
    // Scout genuinely ran and was rejected — adopting must not quietly flip that to accepted.
    orch.tasks.map_repo = { ...orch.tasks.map_repo, status: 'rejected', attempt: 1 };
    const adopted = await attributePreRunUnderstanding({ runId: RUN, understanding: UNDERSTANDING, orchestration: orch });
    ok(!adopted?.tasks?.map_repo, 'a task that already ran is left exactly as the run left it');
    eq(Object.keys(adopted!.tasks ?? {}).sort(), ['author_requirements', 'resolve_scope'], 'only still-queued stages are adopted');
  }

  console.log('A mission without those stages adopts nothing');
  {
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const planned = planMissionForRun({ runId: RUN, goal: 'why did run 42 fail', missionKind: 'investigation' });
    const orch = { ...emptyOrchestration(), ...planned } as WorkflowOrchestration;
    eq(await attributePreRunUnderstanding({ runId: RUN, understanding: UNDERSTANDING, orchestration: orch }), null,
      'an investigation has no repo/scope/requirements stages, so nothing is adopted');
  }

  console.log('Terminal settle still closes whatever never ran');
  {
    const orch = freshOrchestration();
    const adopted = await attributePreRunUnderstanding({ runId: RUN, understanding: UNDERSTANDING, orchestration: orch });
    const merged = { ...orch, tasks: { ...orch.tasks, ...(adopted!.tasks ?? {}) } };
    const settled = settleOpenTasks(merged, null);
    const byId = { ...merged.tasks, ...(settled?.tasks ?? {}) };
    eq(byId.map_repo.status, 'accepted', 'adopted work survives the terminal settle');
    eq(byId.ground_live.status, 'skipped', 'a stage that never ran is closed as skipped, never left pending');
    ok(Object.values(byId).every((t) => t.status !== 'queued'), 'no task is left queued on a finished run');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
