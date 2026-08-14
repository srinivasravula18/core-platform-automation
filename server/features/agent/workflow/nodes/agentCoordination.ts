/** Graph-side adapters: give every run a persisted plan and route the author↔critic exchange for real. */
import { getBlackboard } from '../../../../agent-core/bus/blackboard';
import { getMessageBus } from '../../../../agent-core/bus/messageBus';
import { captureRegistrySnapshot } from '../../../../agent-core/registry/agents';
import { buildExecutionPlan } from '../../../../agent-core/orchestration/coordinator';
import { missionProfile, missionTaskSpecs } from '../../../../agent-core/orchestration/missionProfiles';
import { buildAgentInstanceId, type AgentExecutionPlan, type AgentTask, type FactRef, type MissionKind, type TaskStatus } from '../../../../agent-core/orchestration/contracts';
import { critiqueCases, type CritiqueCase, type CritiqueResult } from '../../../../agent-core/critic/caseCritic';
import type { BehaviorObservation } from '../../behaviorOracle';
import type { WorkflowOrchestration } from '../state';

/** Build and pin the mission plan for a run. Failure is non-fatal: the graph still runs deterministically. */
export function planMissionForRun(input: {
  runId: string;
  goal: string;
  missionKind: MissionKind;
}): Partial<WorkflowOrchestration> | null {
  try {
    const snapshot = captureRegistrySnapshot();
    const profile = missionProfile(input.missionKind);
    const plan = buildExecutionPlan({
      runId: input.runId,
      planId: `plan-${input.runId}`,
      missionKind: input.missionKind,
      tasks: missionTaskSpecs(input.missionKind, input.goal),
      mandatoryGates: profile.mandatoryGates,
      snapshot,
    });
    return {
      plan,
      registrySnapshot: snapshot,
      tasks: Object.fromEntries(plan.tasks.map((t) => [t.taskId, t])),
    };
  } catch (err) {
    console.warn('[orchestration] mission plan not built:', (err as Error)?.message);
    return null;
  }
}

/** Graph stages that currently OWN a planned task. Stages the pipeline does not run yet are skipped,
 * so the console never shows work as pending that will never start. */
const STAGE_TASK: Record<string, string> = {
  discover_and_ground: 'ground_live',
  author_cases: 'design_cases',
  review_cases: 'review_cases',
  compile_and_validate: 'engineer_scripts',
  investigate_failures: 'triage_failures',
  finalize: 'compose_report',
};

/** Planned roles the current graph topology has no stage for — Phase 3 specialists, not yet pipelined. */
const UNPIPELINED = ['map_repo', 'resolve_scope', 'author_requirements', 'curate_suite', 'author_plan', 'review_requirements', 'review_plan', 'review_suite'];

/** Advance the ledger for a graph stage, so the ledger reflects the run rather than the plan alone. */
export function advanceLedgerForStage(
  orchestration: WorkflowOrchestration | undefined,
  stage: string,
  status: TaskStatus,
): Partial<WorkflowOrchestration> | null {
  if (!orchestration?.plan) return null;
  const taskId = STAGE_TASK[stage];
  if (!taskId) return null;
  const patch = markTask(orchestration, taskId, status, status === 'running' ? { attempt: 1 } : {});
  if (!patch) return null;
  // First advance also settles the stages this topology will never run, so nothing sits queued forever.
  const settled: Record<string, AgentTask> = { ...(patch.tasks ?? {}) };
  for (const id of UNPIPELINED) {
    const t = orchestration.tasks[id];
    if (t && t.status === 'queued') settled[id] = { ...t, status: 'skipped', updatedAt: new Date().toISOString() };
  }
  return { tasks: settled };
}

/** What the pre-run understanding flow already produced, keyed to the task it satisfies. */
const PRE_RUN_WORK: Array<{ taskId: string; kind: string; describe: (u: string) => Record<string, unknown> }> = [
  { taskId: 'map_repo', kind: 'evidence.repository', describe: (u) => ({ source: 'pre-run understanding', chars: u.length }) },
  { taskId: 'resolve_scope', kind: 'scope.resolved', describe: (u) => ({ source: 'pre-run understanding', summary: u.slice(0, 800) }) },
  { taskId: 'author_requirements', kind: 'requirements.draft', describe: (u) => ({ source: 'pre-run understanding', summary: u.slice(0, 800) }) },
];

/** Named as the producer on adopted facts — never an agent display name, because no agent thread ran. */
const PRE_RUN_PRODUCER = 'PreRunUnderstanding';

/**
 * Record work the pre-run understanding flow already did, so the ledger reflects the run instead of
 * showing repo/scope/requirements as skipped. This ADOPTS existing output — it runs no model and
 * invents nothing: provenance names the understanding flow, and `agentInstanceId` stays null because
 * no agent thread executed. With no understanding there is nothing to adopt and the tasks stay queued.
 */
export async function attributePreRunUnderstanding(input: {
  runId: string;
  understanding: string;
  orchestration: WorkflowOrchestration | undefined;
}): Promise<Partial<WorkflowOrchestration> | null> {
  const understanding = String(input.understanding || '').trim();
  const tasks = input.orchestration?.tasks;
  if (!understanding || !tasks) return null;

  const bb = getBlackboard();
  const adopted: Record<string, AgentTask> = {};
  const acceptedFactRefs: FactRef[] = [];

  for (const work of PRE_RUN_WORK) {
    const task = tasks[work.taskId];
    if (!task || task.status !== 'queued') continue;
    try {
      const fact = await bb.put(input.runId, work.kind, work.describe(understanding), PRE_RUN_PRODUCER, {
        taskId: work.taskId, status: 'accepted',
      });
      acceptedFactRefs.push({ factId: fact.id, kind: fact.kind, key: fact.key, digest: fact.digest });
      // The work was dispatched to the pre-run flow, ran, and is accepted — walk that real sequence
      // rather than jumping straight to accepted, which the lifecycle rightly forbids.
      adopted[work.taskId] = { ...task, status: 'accepted', attempt: 1, updatedAt: new Date().toISOString() };
    } catch (err) {
      console.warn(`[orchestration] could not attribute ${work.taskId}:`, (err as Error)?.message);
    }
  }
  if (!Object.keys(adopted).length) return null;
  console.log(`[orchestration] adopted pre-run understanding for: ${Object.keys(adopted).join(', ')}`);
  return { tasks: adopted, acceptedFactRefs };
}

/** At terminal time, a task still queued never ran — record it as skipped rather than leaving it pending. */
export function settleOpenTasks(
  orchestration: WorkflowOrchestration | undefined,
  patch: Partial<WorkflowOrchestration> | null,
): Partial<WorkflowOrchestration> | null {
  if (!orchestration?.plan) return patch;
  const tasks: Record<string, AgentTask> = { ...(patch?.tasks ?? {}) };
  for (const [id, t] of Object.entries(orchestration.tasks)) {
    if (tasks[id]) continue;
    if (t.status === 'queued' || t.status === 'dispatched') tasks[id] = { ...t, status: 'skipped', updatedAt: new Date().toISOString() };
  }
  return Object.keys(tasks).length ? { tasks } : patch;
}

/** Mark one ledger task, preserving every other field so the merge reducer stays monotonic. */
export function markTask(
  orchestration: WorkflowOrchestration,
  taskId: string,
  status: TaskStatus,
  patch: Partial<AgentTask> = {},
): Partial<WorkflowOrchestration> | null {
  const task = orchestration.tasks[taskId];
  if (!task) return null;
  return { tasks: { [taskId]: { ...task, ...patch, status, updatedAt: new Date().toISOString() } } };
}

export interface CriticExchangeInput {
  runId: string;
  goal: string;
  cases: CritiqueCase[];
  catalogLabels: Array<string | null | undefined>;
  behavior?: BehaviorObservation | null;
  plan: AgentExecutionPlan | null;
  /** Runs one bounded revision addressing the critique; returns the revised cases. */
  revise: (feedback: string) => Promise<{ cases: CritiqueCase[]; accepted: boolean }>;
}

export interface CriticExchangeResult {
  critique: CritiqueResult;
  revised: boolean;
  handoffId: string | null;
  critiqueMessageId: string | null;
}

const AUTHOR = 'Forge';
const CRITIC = 'Sentinel';
const SUPERVISOR = 'Maestro';

/**
 * The author↔critic exchange, routed by the coordinator rather than projected after the fact. Sentinel's
 * deterministic checks stay the authority; what changes is that its critique is a persisted, causally
 * linked CRITIQUE that Forge answers with exactly one revision, and the revision is what drives routing.
 */
export async function runCriticExchange(input: CriticExchangeInput): Promise<CriticExchangeResult> {
  const bus = getMessageBus();
  const bb = getBlackboard();
  const reviewTask = input.plan?.tasks.find((t) => t.taskId === 'review_cases') ?? null;
  const taskId = reviewTask?.taskId ?? null;
  const instance = reviewTask ? buildAgentInstanceId(CRITIC, input.runId, reviewTask.taskId, 1) : null;

  let handoffId: string | null = null;
  try {
    const handoff = await bus.publish({
      runId: input.runId, from: SUPERVISOR, to: CRITIC, type: 'HANDOFF',
      payload: { taskId, objective: 'Refute ungrounded, duplicate, or unsafe cases before compile.', caseCount: input.cases.length },
      taskId, agentInstanceId: instance, traceId: input.runId,
    });
    handoffId = handoff.id;
  } catch (err) {
    console.warn('[orchestration] critic handoff not published:', (err as Error)?.message);
  }

  const critique = await critiqueCases({
    runId: input.runId, goal: input.goal, cases: input.cases,
    catalogLabels: input.catalogLabels,
    behavior: input.behavior ?? undefined,
    causationId: handoffId,
  });

  if (!critique.hasIssues) {
    return { critique, revised: false, handoffId, critiqueMessageId: null };
  }

  // The critique is a real message Forge answers — not a string passed through a function argument.
  let critiqueMessageId: string | null = null;
  try {
    const msg = await bus.publish({
      runId: input.runId, from: CRITIC, to: AUTHOR, type: 'CRITIQUE',
      payload: {
        taskId,
        refuted: critique.verdicts.filter((v) => !v.accepted).map((v) => ({ title: v.title, codes: v.codes, issues: v.issues })),
        feedback: critique.feedback.slice(0, 4000),
      },
      causationId: handoffId, taskId, agentInstanceId: instance, traceId: input.runId,
    });
    critiqueMessageId = msg.id;
  } catch (err) {
    console.warn('[orchestration] critique not published:', (err as Error)?.message);
  }

  const revision = await input.revise(critique.feedback);
  // Never regress to an empty set on a critic pass — an empty revision is a failed revision.
  const revised = revision.accepted && revision.cases.length > 0;

  try {
    await bb.put(input.runId, 'critique.findings', {
      refuted: critique.verdicts.filter((v) => !v.accepted).length,
      accepted: critique.verdicts.filter((v) => v.accepted).length,
      revisionAccepted: revised,
    }, CRITIC, { causationId: critiqueMessageId, taskId, status: 'accepted' });
    await bus.publish({
      runId: input.runId, from: AUTHOR, to: SUPERVISOR, type: 'RESULT',
      payload: { taskId, revisionAccepted: revised, caseCount: revision.cases.length },
      causationId: critiqueMessageId ?? handoffId, taskId, agentInstanceId: instance, traceId: input.runId,
    });
  } catch (err) {
    console.warn('[orchestration] critique outcome not recorded:', (err as Error)?.message);
  }

  return { critique, revised, handoffId, critiqueMessageId };
}
