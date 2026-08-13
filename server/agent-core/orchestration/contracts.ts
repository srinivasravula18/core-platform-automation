/**
 * Orchestration contracts — the typed task/fact/plan lifecycle (Phase 1).
 * Contracts only: the coordinator (Phase 2) is the sole authority that transitions any state.
 */
import { createHash } from 'crypto';
import { z } from 'zod';

export const ORCHESTRATION_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Identity — stable roles, canonical keys, and per-execution instances (plan §10.8).
// ---------------------------------------------------------------------------------------------

/** Stable semantic roles. Never renamed — dashboards and evals group by these across prompt edits. */
export const AGENT_ROLE_IDS = [
  'orchestrator.supervisor',
  'specialist.repo_cartographer',
  'specialist.scope_resolver',
  'specialist.live_grounding',
  'specialist.requirements_analyst',
  'specialist.test_plan_author',
  'specialist.suite_curator',
  'specialist.case_designer',
  'specialist.critic',
  'specialist.script_engineer',
  'specialist.triage_analyst',
  'specialist.report_composer',
] as const;
export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number];

/** Deterministic capabilities. Plain names — agent names are reserved for reasoning agents. */
export const CAPABILITY_IDS = ['capability.compiler', 'capability.executor', 'gate.human_review'] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** Missions the supervisor may plan. The roster/gates per mission arrive with Phase 3's profiles. */
export const MISSION_KINDS = [
  'requirements', 'test_plan', 'suite', 'cases', 'automation', 'deep_test_run', 'investigation', 'answer',
] as const;
export type MissionKind = (typeof MISSION_KINDS)[number];

/** Codex execution policy per agent. Only deterministic capabilities ever get write scope. */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export const APPROVAL_MODES = ['never', 'on-request', 'on-failure', 'untrusted'] as const;

export const executionPolicySchema = z.object({
  sandboxMode: z.enum(SANDBOX_MODES),
  approvalPolicy: z.enum(APPROVAL_MODES),
  networkAccessEnabled: z.boolean(),
});
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

/** Read tools are model-callable in-turn; state-changing ones are coordinator-only, never on the tool belt. */
export const TOOL_CLASSES = ['read', 'state_changing'] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

/** The identity tuple every message, fact, span, and UI event must carry for one task execution. */
export const agentIdentitySchema = z.object({
  agentRoleId: z.string(),
  /** Existing canonical registry key — unchanged, so prompts/Settings/RBAC/thread mapping keep working. */
  agentKey: z.string(),
  displayName: z.string(),
  agentDefinitionVersion: z.number().int().positive(),
  /** Hash of the RENDERED system prompt, stamped by the runtime — never supplied by the model. */
  promptHash: z.string(),
  agentInstanceId: z.string(),
});
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

/** Correlation IDs kept structurally distinct: correlated, never assumed equal. */
export const correlationSchema = z.object({
  runId: z.string(),
  langGraphThreadId: z.string(),
  taskId: z.string().nullable(),
  traceId: z.string(),
  spanId: z.string().nullable(),
  parentSpanId: z.string().nullable(),
  /** Provider conversation identity — never used as the business identity. */
  codexThreadId: z.string().nullable(),
});
export type Correlation = z.infer<typeof correlationSchema>;

const SLUG_UNSAFE = /[^a-z0-9]+/g;

/** Display slug used in instance IDs — lowercased, punctuation collapsed to '-'. */
export function displaySlug(displayName: string): string {
  return displayName.toLowerCase().replace(SLUG_UNSAFE, '-').replace(/^-|-$/g, '');
}

/** `<display-slug>:<runId>:<taskId>:<attempt>` — deterministic, so a retry is a new instance of one task. */
export function buildAgentInstanceId(displayName: string, runId: string, taskId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('buildAgentInstanceId: attempt must be a positive integer.');
  return `${displaySlug(displayName)}:${runId}:${taskId}:${attempt}`;
}

/** Inverse of buildAgentInstanceId. Returns null when the value is not a well-formed instance ID. */
export function parseAgentInstanceId(id: string): { slug: string; runId: string; taskId: string; attempt: number } | null {
  const parts = id.split(':');
  if (parts.length !== 4) return null;
  const attempt = Number(parts[3]);
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  if (!parts[0] || !parts[1] || !parts[2]) return null;
  return { slug: parts[0], runId: parts[1], taskId: parts[2], attempt };
}

// ---------------------------------------------------------------------------------------------
// Digests — stable content identity for plans, facts, artifacts, and prompts.
// ---------------------------------------------------------------------------------------------

/** Key-sorted JSON so a digest depends on content, not on property insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** `sha256:<hex>` over key-sorted JSON. The one digest function for plans, facts, artifacts, prompts. */
export function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

// ---------------------------------------------------------------------------------------------
// References — messages and facts carry pointers + bounded summaries, never large content (§6).
// ---------------------------------------------------------------------------------------------

export const factRefSchema = z.object({
  factId: z.string(),
  kind: z.string(),
  key: z.string().nullable().optional(),
  digest: z.string(),
});
export type FactRef = z.infer<typeof factRefSchema>;

export const ARTIFACT_KINDS = [
  'dom', 'screenshot', 'metadata', 'source', 'requirements', 'test_plan', 'suite',
  'cases', 'abstract_plan', 'script', 'execution_evidence', 'investigation', 'report',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const artifactRefSchema = z.object({
  artifactId: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  digest: z.string(),
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

/** Runtime-stamped artifact provenance. Lineage is what makes a defect traceable back to source evidence. */
export const artifactLineageSchema = z.object({
  artifactId: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  digest: z.string(),
  producer: agentIdentitySchema.pick({ agentRoleId: true, agentKey: true, agentDefinitionVersion: true, agentInstanceId: true }),
  createdAt: z.string(),
  derivedFromArtifactIds: z.array(z.string()).default([]),
  supersededByArtifactId: z.string().nullable().default(null),
  humanEdited: z.boolean().default(false),
  /** Review gate decision that produced a human edit, when applicable. */
  reviewCorrelationId: z.string().nullable().default(null),
});
export type ArtifactLineage = z.infer<typeof artifactLineageSchema>;

/** Lineage must be acyclic — a cycle would make "trace this defect backward" non-terminating. */
export function assertAcyclicLineage(all: ArtifactLineage[]): void {
  const byId = new Map(all.map((a) => [a.artifactId, a]));
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string, trail: string[]): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') throw new Error(`Artifact lineage cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const parent of byId.get(id)?.derivedFromArtifactIds ?? []) walk(parent, [...trail, id]);
    state.set(id, 'done');
  };
  for (const a of all) walk(a.artifactId, []);
}

// ---------------------------------------------------------------------------------------------
// Shared facts — proposed by agents, promoted only by the coordinator (§6.1).
// ---------------------------------------------------------------------------------------------

/** `legacy` is reserved for pre-Phase-1 rows: readable, never authoritative (backward-compat item 13). */
export const FACT_STATUSES = ['proposed', 'accepted', 'rejected', 'superseded', 'legacy'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** One-way lifecycle. Nothing returns to `proposed`, and `legacy` can never be promoted. */
const FACT_TRANSITIONS: Record<FactStatus, readonly FactStatus[]> = {
  proposed: ['accepted', 'rejected'],
  accepted: ['superseded'],
  rejected: [],
  superseded: [],
  legacy: [],
};

export function canTransitionFact(from: FactStatus, to: FactStatus): boolean {
  return (FACT_TRANSITIONS[from] ?? []).includes(to);
}

export const factScopeSchema = z.object({
  tenantId: z.string(),
  applicationId: z.string().nullable(),
  runId: z.string(),
});
export type FactScope = z.infer<typeof factScopeSchema>;

export const sharedFactEnvelopeSchema = z.object({
  factId: z.string(),
  scope: factScopeSchema,
  kind: z.string(),
  key: z.string().nullable().default(null),
  schemaVersion: z.number().int().nonnegative(),
  status: z.enum(FACT_STATUSES),
  digest: z.string(),
  /** The accepted fact this one replaces; set only when transitioning that fact to `superseded`. */
  supersedesFactId: z.string().nullable().default(null),
  producedByTaskId: z.string().nullable().default(null),
  producer: agentIdentitySchema.partial().optional(),
  artifactRefs: z.array(artifactRefSchema).default([]),
  /** Historical memory is labelled so it can never satisfy a live evidence gate (§6.2 rule 4). */
  historical: z.boolean().default(false),
});
export type SharedFactEnvelope = z.infer<typeof sharedFactEnvelopeSchema>;

// ---------------------------------------------------------------------------------------------
// Tasks — the durable ledger the coordinator schedules against.
// ---------------------------------------------------------------------------------------------

export const TASK_STATUSES = [
  'queued', 'dispatched', 'running', 'awaiting_input', 'accepted', 'rejected', 'failed', 'cancelled', 'skipped',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['dispatched', 'cancelled', 'skipped'],
  dispatched: ['running', 'failed', 'cancelled'],
  running: ['awaiting_input', 'accepted', 'rejected', 'failed', 'cancelled'],
  // A retry re-queues the same task under a new attempt; that is the only way back to work.
  awaiting_input: ['running', 'failed', 'cancelled'],
  rejected: ['queued', 'failed'],
  failed: ['queued'],
  accepted: [],
  cancelled: [],
  skipped: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

/** Terminal for scheduling purposes — dependents of a non-accepted terminal task can never become ready. */
export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return s === 'accepted' || s === 'cancelled' || s === 'skipped';
}

/** LangGraph folds concurrent writes in arbitrary order, so rank keeps the ledger monotonic. */
const TASK_STATUS_RANK: Record<TaskStatus, number> = {
  queued: 0, dispatched: 1, running: 2, awaiting_input: 3,
  rejected: 4, failed: 5, skipped: 6, cancelled: 7, accepted: 8,
};

/** The winner of two views of the same task: higher attempt wins, then higher status rank. */
export function mergeTask(left: AgentTask, right: AgentTask): AgentTask {
  if (right.attempt !== left.attempt) return right.attempt > left.attempt ? right : left;
  return TASK_STATUS_RANK[right.status] >= TASK_STATUS_RANK[left.status] ? right : left;
}

export const budgetSchema = z.object({
  maxCodexTurns: z.number().int().positive(),
  maxToolCalls: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative().nullable().default(null),
});
export type Budget = z.infer<typeof budgetSchema>;

export const agentTaskSchema = z.object({
  taskId: z.string(),
  runId: z.string(),
  planId: z.string(),
  missionKind: z.enum(MISSION_KINDS),
  agentRoleId: z.string(),
  agentKey: z.string(),
  displayName: z.string(),
  agentDefinitionVersion: z.number().int().positive(),
  /** Set when the task is dispatched; a retry produces a new instance ID under the same taskId. */
  agentInstanceId: z.string().nullable().default(null),
  codexThreadId: z.string().nullable().default(null),
  objective: z.string(),
  status: z.enum(TASK_STATUSES),
  inputFactRefs: z.array(factRefSchema).default([]),
  /** Name of the registered output schema this task's result is validated against. */
  outputContract: z.string(),
  dependsOn: z.array(z.string()).default([]),
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(2),
  /** Stable across retries — what makes a deterministic capability run exactly once. */
  idempotencyKey: z.string(),
  budget: budgetSchema,
  createdAt: z.string(),
  updatedAt: z.string().nullable().default(null),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;

/** A task is ready when it is queued and every dependency has been ACCEPTED — not merely finished. */
export function readyTasks(tasks: AgentTask[]): AgentTask[] {
  const accepted = new Set(tasks.filter((t) => t.status === 'accepted').map((t) => t.taskId));
  return tasks.filter((t) => t.status === 'queued' && t.dependsOn.every((d) => accepted.has(d)));
}

/** Dependencies must be acyclic and resolvable, or the plan can deadlock instead of failing loudly. */
export function assertSchedulableTasks(tasks: AgentTask[]): void {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) throw new Error(`Task ${t.taskId} depends on unknown task ${dep}.`);
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string, trail: string[]): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') throw new Error(`Task dependency cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) walk(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const t of tasks) walk(t.taskId, []);
}

// ---------------------------------------------------------------------------------------------
// Plans — what the supervisor proposes, pinned to an immutable registry snapshot.
// ---------------------------------------------------------------------------------------------

/** One roster entry, version-pinned when the run starts so mid-run prompt edits cannot alter it (M16). */
export const rosterEntrySchema = z.object({
  agentRoleId: z.string(),
  agentKey: z.string(),
  displayName: z.string(),
  agentDefinitionVersion: z.number().int().positive(),
  promptHash: z.string(),
  executionPolicy: executionPolicySchema,
  /** Read/inspect tools this agent may call natively; state-changing tools are never listed here. */
  allowedToolNames: z.array(z.string()).default([]),
  /** Blackboard fact kinds this agent may read and may propose. */
  readableFactKinds: z.array(z.string()).default([]),
  writableFactKinds: z.array(z.string()).default([]),
});
export type RosterEntry = z.infer<typeof rosterEntrySchema>;

export const registrySnapshotSchema = z.object({
  registryDigest: z.string(),
  capturedAt: z.string(),
  entries: z.array(rosterEntrySchema),
});
export type RegistrySnapshot = z.infer<typeof registrySnapshotSchema>;

export const agentExecutionPlanSchema = z.object({
  planId: z.string(),
  contractVersion: z.number().int().positive(),
  missionKind: z.enum(MISSION_KINDS),
  /** Digest over the plan's decision-bearing content — recomputed on load to detect tampering/drift. */
  digest: z.string(),
  registryDigest: z.string(),
  roster: z.array(rosterEntrySchema),
  tasks: z.array(agentTaskSchema),
  /** Gates policy adds and the supervisor may not remove. */
  mandatoryGates: z.array(z.string()).default([]),
  budget: budgetSchema,
  createdAt: z.string(),
});
export type AgentExecutionPlan = z.infer<typeof agentExecutionPlanSchema>;

/** Digest input excludes the digest itself and mutable task runtime fields, so it is stable across execution. */
export function computePlanDigest(plan: Omit<AgentExecutionPlan, 'digest'>): string {
  return digestOf({
    missionKind: plan.missionKind,
    registryDigest: plan.registryDigest,
    mandatoryGates: [...plan.mandatoryGates].sort(),
    roster: plan.roster.map((r) => ({ role: r.agentRoleId, key: r.agentKey, version: r.agentDefinitionVersion, promptHash: r.promptHash })),
    tasks: plan.tasks.map((t) => ({
      taskId: t.taskId, role: t.agentRoleId, objective: t.objective,
      outputContract: t.outputContract, dependsOn: [...t.dependsOn].sort(), idempotencyKey: t.idempotencyKey,
    })),
  });
}

/** Structural validation only — registry/policy validation belongs to the coordinator (Phase 2). */
export function validatePlanShape(plan: AgentExecutionPlan): string[] {
  const problems: string[] = [];
  if (plan.contractVersion !== ORCHESTRATION_CONTRACT_VERSION) {
    problems.push(`Plan contractVersion ${plan.contractVersion} != runtime ${ORCHESTRATION_CONTRACT_VERSION}.`);
  }
  if (computePlanDigest(plan) !== plan.digest) problems.push('Plan digest does not match plan content.');
  const rosterRoles = new Set(plan.roster.map((r) => r.agentRoleId));
  for (const t of plan.tasks) {
    if (!rosterRoles.has(t.agentRoleId)) problems.push(`Task ${t.taskId} uses role ${t.agentRoleId}, absent from the pinned roster.`);
    if (t.planId !== plan.planId) problems.push(`Task ${t.taskId} belongs to plan ${t.planId}, not ${plan.planId}.`);
    if (t.missionKind !== plan.missionKind) problems.push(`Task ${t.taskId} mission ${t.missionKind} != plan mission ${plan.missionKind}.`);
  }
  const ids = plan.tasks.map((t) => t.taskId);
  if (new Set(ids).size !== ids.length) problems.push('Duplicate taskId in plan.');
  const keys = plan.tasks.map((t) => t.idempotencyKey);
  if (new Set(keys).size !== keys.length) problems.push('Duplicate idempotencyKey in plan — would break exactly-once.');
  try { assertSchedulableTasks(plan.tasks); } catch (e) { problems.push((e as Error).message); }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Results — what a specialist returns; nothing here is authoritative until the coordinator accepts.
// ---------------------------------------------------------------------------------------------

export const RESULT_KINDS = ['result', 'critique', 'question', 'error'] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

/** The bounded set of next actions a supervisor may propose. Anything else is rejected, not interpreted. */
export const NEXT_ACTIONS = ['proceed', 'reground', 'revise', 'investigate', 'request_human_review', 'terminate'] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  reasoningOutputTokens: z.number().int().nonnegative().default(0),
  codexTurns: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
});
export type AgentUsage = z.infer<typeof usageSchema>;

export const agentResultEnvelopeSchema = z.object({
  taskId: z.string(),
  agentInstanceId: z.string(),
  kind: z.enum(RESULT_KINDS),
  /** Bounded — the artifact store holds the full value; this is what reaches the supervisor. */
  summary: z.string().max(4000),
  proposedFactRefs: z.array(factRefSchema).default([]),
  artifactRefs: z.array(artifactRefSchema).default([]),
  usage: usageSchema,
  /** Calibration input only — can never authorize auto-approval on its own (§10.10). */
  selfConfidence: z.number().min(0).max(100).nullable().default(null),
  proposedNextAction: z.enum(NEXT_ACTIONS).nullable().default(null),
  errors: z.array(z.object({ code: z.string(), message: z.string() })).default([]),
  /** Set on QUESTION results — the single bounded blocker the specialist needs resolved. */
  question: z.string().nullable().default(null),
});
export type AgentResultEnvelope = z.infer<typeof agentResultEnvelopeSchema>;

/** Identity is stamped by the runtime; a model-supplied identity field is a spoof attempt, not a value. */
export const MODEL_FORBIDDEN_RESULT_FIELDS = [
  'agentRoleId', 'agentKey', 'displayName', 'agentDefinitionVersion',
  'promptHash', 'codexThreadId', 'traceId', 'spanId', 'runId', 'planId', 'registryDigest',
] as const;

/** Strips runtime-owned identity keys from a raw model result before validation. Returns what it removed. */
export function stripModelSuppliedIdentity(raw: unknown): { value: unknown; removed: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, removed: [] };
  const removed: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((MODEL_FORBIDDEN_RESULT_FIELDS as readonly string[]).includes(k)) { removed.push(k); continue; }
    out[k] = v;
  }
  return { value: out, removed };
}

// ---------------------------------------------------------------------------------------------
// Human review labels — item-level observations, richer than approved/rejected (§10.10).
// ---------------------------------------------------------------------------------------------

export const HUMAN_REVIEW_LABELS = [
  'accepted_unchanged', 'edited', 'rejected', 'added_by_human', 'removed_by_human',
] as const;
export type HumanReviewLabel = (typeof HUMAN_REVIEW_LABELS)[number];

export const humanReviewObservationSchema = z.object({
  correlationId: z.string(),
  itemId: z.string(),
  label: z.enum(HUMAN_REVIEW_LABELS),
  reasonCode: z.string().nullable().default(null),
  beforeArtifactId: z.string().nullable().default(null),
  afterArtifactId: z.string().nullable().default(null),
  /** Role/version being evaluated — scorecards must never mix unlike cohorts. */
  agentRoleId: z.string().nullable().default(null),
  agentDefinitionVersion: z.number().int().positive().nullable().default(null),
  promptHash: z.string().nullable().default(null),
  actor: z.string(),
  decidedAt: z.string(),
});
export type HumanReviewObservation = z.infer<typeof humanReviewObservationSchema>;

// ---------------------------------------------------------------------------------------------
// Trace envelope — the common shape for every orchestration span (§10.9).
// ---------------------------------------------------------------------------------------------

export const TRACE_EVENT_TYPES = [
  'plan', 'dispatch', 'message_received', 'context_assembled', 'codex_turn', 'tool_request',
  'tool_result', 'fact_proposed', 'validation', 'retry', 'handoff', 'completion',
] as const;
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export const traceEnvelopeSchema = correlationSchema.extend({
  timestamp: z.string(),
  agentRoleId: z.string(),
  agentKey: z.string(),
  displayName: z.string(),
  agentDefinitionVersion: z.number().int().positive(),
  promptHash: z.string(),
  agentInstanceId: z.string(),
  eventType: z.enum(TRACE_EVENT_TYPES),
  status: z.string(),
  inputRefs: z.array(z.string()).default([]),
  memoryRefs: z.array(z.string()).default([]),
  outputRefs: z.array(z.string()).default([]),
  artifactIds: z.array(z.string()).default([]),
  durationMs: z.number().nonnegative().nullable().default(null),
  usage: usageSchema.nullable().default(null),
  selfConfidence: z.number().min(0).max(100).nullable().default(null),
  errorCode: z.string().nullable().default(null),
});
export type TraceEnvelope = z.infer<typeof traceEnvelopeSchema>;
