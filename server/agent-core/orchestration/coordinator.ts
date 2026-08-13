/** The coordinator: the ONLY authority that dispatches tasks, accepts results, and promotes facts. */
import { getBlackboard, type Blackboard } from '../bus/blackboard';
import { getMessageBus, type MessageBus } from '../bus/messageBus';
import { captureRegistrySnapshot, getAgentRegistry, type AgentRegistry } from '../registry/agents';
import { buildAgentTaskContext, factKindAllowed, renderTaskPrompt, type AgentTaskContext, type MemoryNote } from './context';
import { missionAllowsOutput } from './missionProfiles';
import {
  agentResultEnvelopeSchema, assertSchedulableTasks, buildAgentInstanceId, canTransitionTask,
  computePlanDigest, digestOf, readyTasks, stripModelSuppliedIdentity, validatePlanShape,
  ORCHESTRATION_CONTRACT_VERSION,
  type AgentExecutionPlan, type AgentResultEnvelope, type AgentTask, type AgentUsage, type Budget,
  type FactRef, type MissionKind, type RegistrySnapshot, type RosterEntry, type TaskStatus,
} from './contracts';

const EMPTY_USAGE: AgentUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, codexTurns: 0, toolCalls: 0 };

/** Thrown when work is attempted that the plan or policy does not permit. Never coerced into a default. */
export class CoordinationError extends Error {
  constructor(message: string) { super(message); this.name = 'CoordinationError'; }
}

/** What a specialist run returns. Injectable so the coordination path is testable without a provider. */
export type SpecialistRunner = (input: {
  task: AgentTask;
  roster: RosterEntry;
  context: AgentTaskContext;
  prompt: string;
  system: string;
  handoffId: string;
  signal?: AbortSignal;
}) => Promise<{ raw: unknown; usage?: AgentUsage; codexThreadId?: string | null }>;

export interface CoordinatorDeps {
  bus?: MessageBus;
  blackboard?: Blackboard;
  agents?: AgentRegistry;
  runner: SpecialistRunner;
}

export interface PlanTaskSpec {
  taskId: string;
  agentRoleId: string;
  objective: string;
  dependsOn?: string[];
  inputFactRefs?: FactRef[];
  budget?: Budget;
  maxAttempts?: number;
}

const DEFAULT_BUDGET: Budget = { maxCodexTurns: 4, maxToolCalls: 20, maxTokens: null };

export interface BuildPlanInput {
  runId: string;
  planId: string;
  missionKind: MissionKind;
  tasks: PlanTaskSpec[];
  mandatoryGates?: string[];
  budget?: Budget;
  snapshot?: RegistrySnapshot;
  createdAt?: string;
  agents?: AgentRegistry;
}

/**
 * Turn a proposed task list into a validated, digest-pinned plan. Unknown roles are rejected here, so a
 * supervisor can never name an agent that does not exist or has not been pinned for this run.
 */
export function buildExecutionPlan(input: BuildPlanInput): AgentExecutionPlan {
  const snapshot = input.snapshot ?? captureRegistrySnapshot(input.agents ?? getAgentRegistry());
  const byRole = new Map(snapshot.entries.map((e) => [e.agentRoleId, e]));
  const createdAt = input.createdAt ?? new Date().toISOString();

  const tasks: AgentTask[] = input.tasks.map((spec) => {
    const entry = byRole.get(spec.agentRoleId);
    if (!entry) throw new CoordinationError(`Plan names role '${spec.agentRoleId}', absent from the pinned registry snapshot.`);
    return {
      taskId: spec.taskId,
      runId: input.runId,
      planId: input.planId,
      missionKind: input.missionKind,
      agentRoleId: entry.agentRoleId,
      agentKey: entry.agentKey,
      displayName: entry.displayName,
      agentDefinitionVersion: entry.agentDefinitionVersion,
      agentInstanceId: null,
      codexThreadId: null,
      objective: spec.objective,
      status: 'queued' as TaskStatus,
      inputFactRefs: spec.inputFactRefs ?? [],
      outputContract: (input.agents ?? getAgentRegistry()).get(entry.agentKey)?.outputContract ?? entry.agentRoleId,
      dependsOn: spec.dependsOn ?? [],
      attempt: 0,
      maxAttempts: spec.maxAttempts ?? 2,
      idempotencyKey: `${input.runId}:${spec.taskId}`,
      budget: spec.budget ?? DEFAULT_BUDGET,
      createdAt,
      updatedAt: null,
    };
  });

  assertSchedulableTasks(tasks);
  const base = {
    planId: input.planId,
    contractVersion: ORCHESTRATION_CONTRACT_VERSION,
    missionKind: input.missionKind,
    registryDigest: snapshot.registryDigest,
    roster: snapshot.entries.filter((e) => tasks.some((t) => t.agentRoleId === e.agentRoleId)),
    tasks,
    mandatoryGates: input.mandatoryGates ?? [],
    budget: input.budget ?? DEFAULT_BUDGET,
    createdAt,
  };
  const plan: AgentExecutionPlan = { ...base, digest: computePlanDigest(base) };
  const problems = validatePlanShape(plan);
  if (problems.length) throw new CoordinationError(`Invalid execution plan: ${problems.join('; ')}`);
  return plan;
}

export interface DispatchResult {
  task: AgentTask;
  envelope: AgentResultEnvelope | null;
  acceptedFactRefs: FactRef[];
  rejectedFactIds: string[];
  usage: AgentUsage;
  handoffId: string;
  resultMessageId: string | null;
  errors: string[];
}

export class Coordinator {
  private bus: MessageBus;
  private bb: Blackboard;
  private agents: AgentRegistry;
  private runner: SpecialistRunner;
  private spend: AgentUsage = { ...EMPTY_USAGE };

  constructor(deps: CoordinatorDeps) {
    this.bus = deps.bus ?? getMessageBus();
    this.bb = deps.blackboard ?? getBlackboard();
    this.agents = deps.agents ?? getAgentRegistry();
    this.runner = deps.runner;
  }

  /** Total usage across every specialist this coordinator has run — one shared run budget. */
  get usage(): AgentUsage { return { ...this.spend }; }

  /** Tasks whose dependencies are all ACCEPTED. Scheduling never keys off "finished". */
  ready(plan: AgentExecutionPlan, ledger: Record<string, AgentTask>): AgentTask[] {
    return readyTasks(plan.tasks.map((t) => ledger[t.taskId] ?? t));
  }

  private transition(task: AgentTask, to: TaskStatus): AgentTask {
    if (!canTransitionTask(task.status, to)) {
      throw new CoordinationError(`Illegal task transition ${task.status} -> ${to} for ${task.taskId}.`);
    }
    return { ...task, status: to, updatedAt: new Date().toISOString() };
  }

  private overBudget(plan: AgentExecutionPlan): boolean {
    const max = plan.budget.maxTokens;
    if (max == null) return false;
    return this.spend.inputTokens + this.spend.outputTokens >= max;
  }

  /**
   * Run one task end to end: HANDOFF, execute, validate the envelope, promote or reject its proposed
   * facts, then RESULT. A schema-invalid or unpermitted result fails the task visibly — it is never
   * consumed as text, and it never updates state.
   */
  async dispatch(
    plan: AgentExecutionPlan,
    task: AgentTask,
    opts: { memory?: MemoryNote[]; signal?: AbortSignal; from?: string } = {},
  ): Promise<DispatchResult> {
    if (this.overBudget(plan)) throw new CoordinationError(`Run budget exhausted; refusing to dispatch ${task.taskId}.`);
    const roster = plan.roster.find((r) => r.agentRoleId === task.agentRoleId);
    if (!roster) throw new CoordinationError(`Task ${task.taskId} names role ${task.agentRoleId}, absent from the plan roster.`);

    const from = opts.from ?? 'Maestro';
    const attempt = task.attempt + 1;
    if (attempt > task.maxAttempts) throw new CoordinationError(`Task ${task.taskId} exceeded maxAttempts (${task.maxAttempts}).`);
    const agentInstanceId = buildAgentInstanceId(roster.displayName, task.runId, task.taskId, attempt);

    let current: AgentTask = { ...this.transition(task, 'dispatched'), attempt, agentInstanceId };
    const context = await buildAgentTaskContext({ task: current, roster, memory: opts.memory, blackboard: this.bb });

    const handoff = await this.bus.publish({
      runId: task.runId, from, to: roster.displayName, type: 'HANDOFF',
      payload: { taskId: task.taskId, objective: task.objective, contextDigest: context.digest, outputContract: task.outputContract },
      taskId: task.taskId, agentInstanceId, traceId: task.runId,
    });

    current = this.transition(current, 'running');
    const errors: string[] = [];
    let envelope: AgentResultEnvelope | null = null;
    let usage: AgentUsage = { ...EMPTY_USAGE };

    try {
      const def = this.agents.get(roster.agentKey);
      const out = await this.runner({
        task: current, roster, context,
        prompt: renderTaskPrompt(context),
        system: def?.resolveSystem?.() ?? '',
        handoffId: handoff.id,
        signal: opts.signal,
      });
      usage = out.usage ?? { ...EMPTY_USAGE };
      if (out.codexThreadId) current = { ...current, codexThreadId: out.codexThreadId };

      // Identity is runtime-stamped; anything the model claimed about itself is discarded before validation.
      const { value } = stripModelSuppliedIdentity(out.raw);
      const parsed = agentResultEnvelopeSchema.safeParse({
        ...(value as object), taskId: task.taskId, agentInstanceId,
        usage: { ...EMPTY_USAGE, ...usage },
      });
      if (!parsed.success) errors.push(`Result failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      else envelope = parsed.data;
    } catch (err) {
      errors.push((err as Error)?.message ?? String(err));
    }

    this.spend = {
      inputTokens: this.spend.inputTokens + usage.inputTokens,
      cachedInputTokens: this.spend.cachedInputTokens + usage.cachedInputTokens,
      outputTokens: this.spend.outputTokens + usage.outputTokens,
      reasoningOutputTokens: this.spend.reasoningOutputTokens + usage.reasoningOutputTokens,
      codexTurns: this.spend.codexTurns + usage.codexTurns,
      toolCalls: this.spend.toolCalls + usage.toolCalls,
    };

    if (!envelope) {
      const failed = this.transition(current, attempt < task.maxAttempts ? 'rejected' : 'failed');
      return { task: failed, envelope: null, acceptedFactRefs: [], rejectedFactIds: [], usage, handoffId: handoff.id, resultMessageId: null, errors };
    }

    const { accepted, rejected, gateErrors } = await this.settleFacts(task, roster, envelope);
    errors.push(...gateErrors);

    // A result that proposed only unpermitted facts has produced nothing usable — that is a task failure.
    const usable = accepted.length > 0 || envelope.proposedFactRefs.length === 0;
    const finalStatus: TaskStatus = usable && !gateErrors.length ? 'accepted' : (attempt < task.maxAttempts ? 'rejected' : 'failed');
    const settled = this.transition(current, finalStatus);

    const resultMsg = await this.bus.publish({
      runId: task.runId, from: roster.displayName, to: from,
      type: envelope.kind === 'critique' ? 'CRITIQUE' : envelope.kind === 'question' ? 'QUESTION' : 'RESULT',
      payload: { taskId: task.taskId, status: finalStatus, summary: envelope.summary.slice(0, 1000), acceptedFactRefs: accepted, question: envelope.question },
      causationId: handoff.id, taskId: task.taskId, agentInstanceId, traceId: task.runId,
    });

    return { task: settled, envelope, acceptedFactRefs: accepted, rejectedFactIds: rejected, usage, handoffId: handoff.id, resultMessageId: resultMsg.id, errors };
  }

  /** Promote the facts a result proposed, rejecting any kind the role is not permitted to write. */
  private async settleFacts(task: AgentTask, roster: RosterEntry, envelope: AgentResultEnvelope) {
    const accepted: FactRef[] = [];
    const rejected: string[] = [];
    const gateErrors: string[] = [];
    for (const ref of envelope.proposedFactRefs) {
      // A mission may not emit outside its declared outputs — an `answer` writes no workspace artifacts.
      if (!missionAllowsOutput(task.missionKind, ref.kind)) {
        gateErrors.push(`Mission '${task.missionKind}' does not produce fact kind '${ref.kind}'.`);
        await this.bb.setStatus(ref.factId, 'rejected').catch(() => undefined);
        rejected.push(ref.factId);
        continue;
      }
      if (!factKindAllowed(ref.kind, roster.writableFactKinds)) {
        gateErrors.push(`${roster.displayName} may not write fact kind '${ref.kind}'.`);
        await this.bb.setStatus(ref.factId, 'rejected').catch(() => undefined);
        rejected.push(ref.factId);
        continue;
      }
      const promoted = await this.bb.setStatus(ref.factId, 'accepted').catch((e) => { gateErrors.push((e as Error).message); return null; });
      if (promoted) accepted.push({ factId: promoted.id, kind: promoted.kind, key: promoted.key, digest: promoted.digest });
      else rejected.push(ref.factId);
    }
    return { accepted, rejected, gateErrors };
  }

  /** Deliver a supervisor/human ANSWER to a blocked specialist, linked to the QUESTION it resolves. */
  async answer(task: AgentTask, questionMessageId: string, answer: string, from = 'Maestro'): Promise<string> {
    const msg = await this.bus.publish({
      runId: task.runId, from, to: task.displayName, type: 'ANSWER',
      payload: { taskId: task.taskId, answer: answer.slice(0, 2000) },
      causationId: questionMessageId, taskId: task.taskId, agentInstanceId: task.agentInstanceId, traceId: task.runId,
    });
    return msg.id;
  }

  /** Re-queue a rejected/failed task for a bounded retry under the SAME idempotency key. */
  requeue(task: AgentTask): AgentTask {
    if (task.attempt >= task.maxAttempts) throw new CoordinationError(`Task ${task.taskId} has no attempts left.`);
    return this.transition(task, 'queued');
  }

  /** Digest of the accepted state a supervisor decision was made against, for the trace. */
  static decisionDigest(plan: AgentExecutionPlan, ledger: Record<string, AgentTask>): string {
    return digestOf(plan.tasks.map((t) => ({ taskId: t.taskId, status: (ledger[t.taskId] ?? t).status })));
  }
}
