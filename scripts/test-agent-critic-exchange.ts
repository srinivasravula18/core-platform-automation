/**
 * Phase 4 exit-gate tests — the author↔critic exchange is decision-bearing, not projected.
 * Proves: the critique is a persisted CRITIQUE causally linked to Sentinel's HANDOFF; Forge answers with
 * exactly ONE bounded revision; an empty revision never regresses the case set; every run pins a plan.
 *   npx tsx scripts/test-agent-critic-exchange.ts
 */
import { InMemoryBlackboard, setBlackboard, getBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, setMessageBus, getMessageBus } from '../server/agent-core/bus/messageBus';
import { planMissionForRun, markTask, runCriticExchange } from '../server/features/agent/workflow/nodes/agentCoordination';
import { emptyOrchestration } from '../server/features/agent/workflow/state';
import type { CritiqueCase } from '../server/agent-core/critic/caseCritic';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const RUN = 'run-x';
const GOAL = 'Test the Accounts list view';
const CATALOG = ['New Button', 'Accounts Grid', 'Account Name Field'];

const PRE = 'Signed in as an admin with the Accounts app open.';
const mk = (title: string, action: string, expected: string): CritiqueCase =>
  ({ title, description: action, preconditions: PRE, steps: [{ action, expected }] });

/** Distinct + grounded in CATALOG + fully specified — the critic must accept these unchanged. */
const CLEAN: CritiqueCase[] = [
  mk('Create an account from the New Button', 'Click the New Button', 'The account create form opens'),
  mk('Filter the Accounts Grid by name', 'Type into the Account Name Field', 'The Accounts Grid filters to matching rows'),
];
/** Two identical titles — the deterministic critic must refute the duplicate. */
const DUPES: CritiqueCase[] = [CLEAN[0], { ...CLEAN[0] }];

function reset() {
  setMessageBus(new InMemoryMessageBus());
  setBlackboard(new InMemoryBlackboard());
}

async function main() {
  console.log('Every run pins a mission plan and a registry snapshot');
  {
    const orch = planMissionForRun({ runId: RUN, goal: GOAL, missionKind: 'deep_test_run' });
    ok(!!orch?.plan, 'a plan is built for the run');
    ok(!!orch?.registrySnapshot?.registryDigest, 'the registry snapshot is pinned');
    eq(orch!.plan!.tasks[0].runId, RUN, 'every planned task belongs to the run');
    ok(Object.keys(orch!.tasks!).length === orch!.plan!.tasks.length, 'the ledger is seeded from the plan');
    ok(!!orch!.tasks!['review_cases'], 'a deep run includes the critic review task');
    ok(orch!.plan!.mandatoryGates.includes('critique'), 'the critique gate is mandatory and cannot be planned away');

    const base = { ...emptyOrchestration(), ...orch } as ReturnType<typeof emptyOrchestration>;
    const marked = markTask(base, 'review_cases', 'accepted');
    eq(marked?.tasks?.review_cases.status, 'accepted', 'a ledger task can be marked without touching its siblings');
    eq(markTask(base, 'no_such_task', 'accepted'), null, 'marking an unknown task is a no-op, never an invention');
  }

  console.log('A clean draft produces no critique and no revision');
  {
    reset();
    let revisions = 0;
    const orch = planMissionForRun({ runId: RUN, goal: GOAL, missionKind: 'deep_test_run' });
    const r = await runCriticExchange({
      runId: RUN, goal: GOAL, cases: CLEAN, catalogLabels: CATALOG, plan: orch!.plan!,
      revise: async () => { revisions++; return { cases: CLEAN, accepted: true }; },
    });
    eq(revisions, 0, 'a clean draft is never sent back for revision');
    eq(r.revised, false, 'no revision is reported');
    const history = await getMessageBus().history(RUN);
    ok(history.some((m) => m.type === 'HANDOFF' && m.to === 'Sentinel'), 'the critic is still handed the draft to review');
    ok(!history.some((m) => m.type === 'CRITIQUE'), 'no CRITIQUE is published when there is nothing to refute');
  }

  console.log('A refuted draft produces a causally linked CRITIQUE and exactly one revision');
  {
    reset();
    let revisions = 0;
    const orch = planMissionForRun({ runId: RUN, goal: GOAL, missionKind: 'deep_test_run' });
    const r = await runCriticExchange({
      runId: RUN, goal: GOAL, cases: DUPES, catalogLabels: CATALOG, plan: orch!.plan!,
      revise: async (feedback) => {
        revisions++;
        ok(feedback.length > 0, 'the revision request carries the critic feedback');
        return { cases: CLEAN, accepted: true };
      },
    });
    ok(r.critique.hasIssues, 'the duplicate draft is refuted');
    eq(revisions, 1, 'exactly ONE bounded revision is permitted');
    eq(r.revised, true, 'the accepted revision is reported');

    const history = await getMessageBus().history(RUN);
    const handoff = history.find((m) => m.type === 'HANDOFF')!;
    const critique = history.find((m) => m.type === 'CRITIQUE')!;
    const result = history.find((m) => m.type === 'RESULT')!;
    ok(!!critique, 'the critique is a persisted CRITIQUE message, not a function argument');
    eq(critique.from, 'Sentinel', 'the critique is voiced by the critic');
    eq(critique.to, 'Forge', 'and addressed to the author');
    eq(critique.causationId, handoff.id, 'the CRITIQUE is causally linked to the critic handoff');
    eq(result.causationId, critique.id, "the author's RESULT answers the critique it received");
    eq(critique.taskId, 'review_cases', 'the exchange is bound to the planned review task');
    ok(!!critique.agentInstanceId && critique.agentInstanceId.startsWith('sentinel:'), 'the critique carries the critic instance identity');

    const facts = await getBlackboard().all(RUN, 'critique.findings');
    ok(facts.length === 1, 'the critique outcome is recorded as a shared fact');
    eq(facts[0].status, 'accepted', 'the coordinator accepted the critique finding');
    eq((facts[0].value as { revisionAccepted: boolean }).revisionAccepted, true, 'the fact records whether the revision was accepted');
  }

  console.log('An empty revision never regresses the case set');
  {
    reset();
    const orch = planMissionForRun({ runId: RUN, goal: GOAL, missionKind: 'deep_test_run' });
    const r = await runCriticExchange({
      runId: RUN, goal: GOAL, cases: DUPES, catalogLabels: CATALOG, plan: orch!.plan!,
      revise: async () => ({ cases: [], accepted: true }),
    });
    eq(r.revised, false, 'an empty revision is treated as a FAILED revision, not an improvement');
    const facts = await getBlackboard().all(RUN, 'critique.findings');
    eq((facts[0].value as { revisionAccepted: boolean }).revisionAccepted, false, 'the shared fact records the rejection');
  }

  console.log('The exchange degrades safely when no plan was pinned');
  {
    reset();
    let revisions = 0;
    const r = await runCriticExchange({
      runId: RUN, goal: GOAL, cases: DUPES, catalogLabels: CATALOG, plan: null,
      revise: async () => { revisions++; return { cases: CLEAN, accepted: true }; },
    });
    ok(r.critique.hasIssues, 'the deterministic critique still runs without a plan');
    eq(revisions, 1, 'the bounded revision still happens');
    const history = await getMessageBus().history(RUN);
    ok(history.every((m) => m.taskId === null), 'messages carry no task id when no plan pinned one');
    ok(history.some((m) => m.type === 'CRITIQUE'), 'the critique is still published and traceable');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
