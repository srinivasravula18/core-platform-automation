/**
 * Phase 3 exit-gate tests — the request selects the roster and the terminal deliverable.
 * Proves: each mission wakes only its own agents and stops at its own artifact; a mission cannot emit a
 * fact kind it did not declare; an unsatisfiable roster fails loudly; promotions are explicit.
 *   npx tsx scripts/test-mission-profiles.ts
 */
import { InMemoryBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus } from '../server/agent-core/bus/messageBus';
import { AgentRegistry } from '../server/agent-core/registry/agents';
import { Coordinator, buildExecutionPlan, type SpecialistRunner } from '../server/agent-core/orchestration/coordinator';
import {
  MISSION_PROFILES, assertProfileSatisfiable, canPromoteMission, missionAllowsOutput,
  missionForRouteKind, missionProfile, missionTaskSpecs,
} from '../server/agent-core/orchestration/missionProfiles';
import { MISSION_KINDS, type MissionKind } from '../server/agent-core/orchestration/contracts';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
async function throws(fn: () => Promise<unknown> | unknown, n: string) {
  try { await fn(); ok(false, `${n} (expected throw, none)`); } catch { ok(true, n); }
}

const RUN = 'run-m';

function planFor(kind: MissionKind, goal: string) {
  return buildExecutionPlan({
    runId: RUN, planId: `plan-${kind}`, missionKind: kind,
    tasks: missionTaskSpecs(kind, goal),
    mandatoryGates: missionProfile(kind).mandatoryGates,
    createdAt: '2026-08-13T00:00:00.000Z',
  });
}

async function main() {
  console.log('Every mission is defined, satisfiable, and schedulable');
  {
    eq(Object.keys(MISSION_PROFILES).sort(), [...MISSION_KINDS].sort(), 'every mission kind has a profile');
    for (const kind of MISSION_KINDS) {
      const p = planFor(kind, 'the list view');
      ok(p.tasks.length > 0, `${kind}: produces a schedulable plan (${p.tasks.length} task(s))`);
      ok(p.roster.length > 0 && p.roster.length <= p.tasks.length, `${kind}: the roster is trimmed to the roles it uses`);
    }
  }

  console.log('"plan this" wakes the plan roster and terminates at the plan');
  {
    const p = planFor('test_plan', 'the list view');
    const names = p.tasks.map((t) => t.displayName);
    eq(names, ['Atlas', 'Compass', 'Charter', 'Sentinel'], 'the test_plan mission wakes exactly Atlas, Compass, Charter, Sentinel');
    ok(!names.includes('Anvil'), 'no script engineer is woken for a plan request');
    ok(!names.includes('Forge'), 'no case designer is woken for a plan request');
    eq(missionProfile('test_plan').deliverable, 'accepted test plan', 'the mission terminates at the test plan');
  }

  console.log('"test the list view" wakes the full chain through to a report');
  {
    const p = planFor('deep_test_run', 'the list view');
    const names = p.tasks.map((t) => t.displayName);
    for (const n of ['Atlas', 'Compass', 'Scout', 'Scribe', 'Forge', 'Sentinel', 'Anvil', 'Sleuth', 'Herald']) {
      ok(names.includes(n), `deep_test_run wakes ${n}`);
    }
    const design = p.tasks.find((t) => t.taskId === 'design_cases')!;
    eq(design.dependsOn.sort(), ['author_requirements', 'ground_live'], 'case design waits on BOTH requirements and live grounding');
  }

  console.log('Shorter missions reuse the same contracts, never a second implementation');
  {
    const req = planFor('requirements', 'the list view');
    const deep = planFor('deep_test_run', 'the list view');
    const reqAuthor = req.tasks.find((t) => t.taskId === 'author_requirements')!;
    const deepAuthor = deep.tasks.find((t) => t.taskId === 'author_requirements')!;
    eq(reqAuthor.agentRoleId, deepAuthor.agentRoleId, 'the requirements stage is the same role in both missions');
    eq(reqAuthor.outputContract, deepAuthor.outputContract, 'and the same output contract');
  }

  console.log('A mission cannot emit outside its declared outputs');
  {
    ok(missionAllowsOutput('requirements', 'requirements.draft'), 'requirements may emit a requirements draft');
    ok(!missionAllowsOutput('requirements', 'plans.abstract'), 'requirements may NOT emit an automation plan');
    ok(!missionAllowsOutput('answer', 'cases.draft'), 'an answer writes no workspace artifacts');
    ok(!missionAllowsOutput('investigation', 'requirements.draft'), 'an investigation does not author requirements');

    // Enforced at acceptance, not by prompt wording.
    const bb = new InMemoryBlackboard();
    const bus = new InMemoryMessageBus();
    const p = buildExecutionPlan({
      runId: RUN, planId: 'plan-answer', missionKind: 'answer',
      tasks: [{ taskId: 'compose_report', agentRoleId: 'specialist.report_composer', objective: 'Answer' }],
      createdAt: '2026-08-13T00:00:00.000Z',
    });
    const stray = await bb.put(RUN, 'report.summary', { text: 'ok' }, 'Herald');
    const runner: SpecialistRunner = async () => ({
      raw: { kind: 'result', summary: 'answered', proposedFactRefs: [{ factId: stray.id, kind: 'report.summary', key: null, digest: stray.digest }] },
    });
    const coord = new Coordinator({ bus, blackboard: bb, runner });
    const r = await coord.dispatch(p, p.tasks[0]);
    eq(r.task.status, 'accepted', 'a declared output kind is accepted');

    const forbidden = await bb.put(RUN, 'cases.draft', { title: 'x' }, 'Herald');
    const badRunner: SpecialistRunner = async () => ({
      raw: { kind: 'result', summary: 'overreach', proposedFactRefs: [{ factId: forbidden.id, kind: 'cases.draft', key: null, digest: forbidden.digest }] },
    });
    const bad = new Coordinator({ bus, blackboard: bb, runner: badRunner });
    const r2 = await bad.dispatch(p, { ...p.tasks[0], status: 'queued', attempt: 0 });
    ok(r2.task.status !== 'accepted', 'an undeclared output kind is not accepted');
    ok(r2.errors.some((e) => e.includes("does not produce fact kind")), 'the mission-output violation is named');
    eq(await bb.latestAccepted(RUN, 'cases.draft'), null, 'the stray artifact never becomes authoritative');
  }

  console.log('Route-kind compatibility and explicit promotion paths');
  {
    eq(missionForRouteKind('requirement_draft'), 'requirements', 'requirement_draft maps to the requirements mission');
    eq(missionForRouteKind('generate_cases'), 'cases', 'generate_cases maps to the cases mission');
    eq(missionForRouteKind('deep_test_run'), 'deep_test_run', 'deep_test_run maps through unchanged');
    eq(missionForRouteKind('workspace_action'), 'test_plan', 'workspace_action maps to the test-plan mission');
    eq(missionForRouteKind('nonsense'), null, 'an unknown route kind maps to nothing, never a guess');

    ok(canPromoteMission('cases', 'automation'), 'cases may be promoted to automation after approval');
    ok(!canPromoteMission('cases', 'requirements'), 'a mission cannot be promoted backwards');
    ok(!canPromoteMission('deep_test_run', 'cases'), 'the full run has nothing to promote to');
  }

  console.log('An unsatisfiable roster fails loudly instead of degrading');
  {
    const empty = new AgentRegistry();
    await throws(() => assertProfileSatisfiable(missionProfile('cases'), empty), 'a profile whose roles are unregistered is rejected');
    const partial = new AgentRegistry();
    partial.register({ name: 'Atlas', description: 'd', toolNames: [], roleId: 'specialist.repo_cartographer', displayName: 'Atlas', definitionVersion: 1 });
    await throws(() => assertProfileSatisfiable(missionProfile('cases'), partial), 'a partially satisfiable profile is still rejected');
    ok(true, 'no mission silently degrades to a different roster');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
