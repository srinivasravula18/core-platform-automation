/**
 * Versioned LangGraph shared-state schema and reducers (LangGraph migration, Phase 1; Appendix A.4).
 *
 * WorkflowState is a serializable workflow envelope: identity, mission, evidence/authoring/compilation
 * refs, control counters, and diagnostics. Large payloads (DOM, screenshots, repo contents, prompts,
 * secrets) NEVER live here — only refs/digests/summaries into artifact/run storage. Every field has
 * exactly one owning node and uses LangGraph's default last-write-wins merge UNLESS Section 6.2 calls
 * for a reducer (bounded error/warning append, per-case plan/compile results, per-attempt execution
 * results) — those three are the only custom reducers in this file.
 *
 * Pure-ish leaf module: imports only `./errors` (sibling, already built) plus `zod` and
 * `@langchain/langgraph`. Does NOT import `./events` or `./checkpointer` (built in parallel, not ready).
 */
import { z } from 'zod';
import { Annotation } from '@langchain/langgraph';
import { WORKFLOW_ERROR_CLASSES, type WorkflowError, type WorkflowErrorClass } from './errors';
import { COVERAGE_KINDS, type CoverageItem, type CoveragePlan } from '../compiler/coveragePlan';
import type { RiskFactor, RiskScore } from '../graph/riskAnalysis';

export const WORKFLOW_STATE_SCHEMA_VERSION = 1;
export const WORKFLOW_GRAPH_VERSION = 1;

/** Prevents a checkpoint written by one execution engine from being resumed by a different one. */
export const WORKFLOW_ENGINES = ['langgraph'] as const;
export type WorkflowEngine = (typeof WORKFLOW_ENGINES)[number];

/** Existing external run status (Section 6.2 "Workflow"). `running`/`review_required`/`completed`/`failed`/`cancelled`
 * are verified live values from `server/features/agent/routes.ts`; `queued` is new — a graph thread can exist
 * before its first node runs, a state the legacy run object (which starts at `running`) never modeled. */
export const WORKFLOW_STATUSES = ['queued', 'running', 'review_required', 'completed', 'failed', 'cancelled'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** Detailed internal progress — the node currently owning the run, for UI/diagnostics; distinct from `status`. */
export type WorkflowStage = string;

// ---------------------------------------------------------------------------------------------
// Nested sub-shapes (Section 6.2 groups). Each is a small, named object — never an open-ended blob.
// ---------------------------------------------------------------------------------------------

/** A named reference to a runtime secret — NEVER a resolved credential (Never-checkpoint list). */
export interface CredentialRef {
  websiteId: string;
  role: string;
}

/** Normalized goal/count/policy — the validated input to the whole run (Identity/Request group). */
export interface WorkflowRequest {
  goal: string;
  requestedCaseCount: number;
  reviewPolicy: 'auto' | 'manual';
  executionPolicy: 'auto' | 'manual' | 'skip';
  /** The chat's approved, code-grounded understanding of the feature (behaviors, rules, edges). Threaded
   * into case authoring so the writer grounds on the analysis too, not just the bare prompt + live DOM. */
  understanding?: string;
}

/** Frozen mission reference — the execution-scope authority resolved by `resolve_mission`. */
export interface MissionRef {
  platformType: 'ADMIN' | 'RUNTIME';
  platform: string;
  runtimeSurface: 'shockwave' | 'keystone' | null;
  applicationId: string | null;
  moduleId: string | null;
  tabId: string | null;
  targetUrl: string;
  executionScope: string;
}

/** Metadata/repository/role context — summaries and refs only, never full payloads (Context group). */
export interface ContextMetadataSummary {
  ref: string;
  digest: string;
  objectCount: number;
  source: 'live' | 'cached' | 'unavailable';
}
export interface ContextRepositorySummary {
  ref: string;
  digest: string;
  revision: string;
  filesSearched: number;
  source: 'live' | 'cached' | 'unavailable';
}
export interface ContextRoleRef {
  role: string;
  testDataRef: string;
}
/** Explicit include/exclude ledger — WHY something entered or was left out of context (never silent truncation). */
export interface ContextBudgetEntry {
  key: string;
  included: boolean;
  reason: string;
  tokenEstimate?: number;
}
export interface WorkflowContext {
  metadata: ContextMetadataSummary | null;
  repository: ContextRepositorySummary | null;
  roles: ContextRoleRef[];
  budget: ContextBudgetEntry[];
}

/** Evidence counts by provenance — a compact catalog summary, never the graph payload itself. */
export interface EvidenceCountsByProvenance {
  live: number;
  cached: number;
  inferred: number;
  unverified: number;
}
/** Only the executable target vocabulary — enumerated names, not full node payloads. */
export interface TargetCatalogEntry {
  semanticName: string;
  evidenceKind: 'UI' | 'API' | 'DB' | 'PERF' | 'A11Y' | 'LOG';
  confidence: 'verified-live' | 'verified-static' | 'inferred' | 'unverified';
}
/** Safe-block/continue decision from the evidence gate — the gate is the sole writer. */
export interface EvidenceGateDecision {
  decision: 'continue' | 'targeted_retry' | 'blocked';
  reasons: string[];
  missingRequirements: string[];
}
export interface WorkflowEvidence {
  registryRef: string | null;
  metadataGraphRef: string | null;
  evidenceGraphRef: string | null;
  countsByProvenance: EvidenceCountsByProvenance;
  targetCatalog: TargetCatalogEntry[];
  gate: EvidenceGateDecision | null;
}

/** Strict case output (Authoring group) — the reviewed/approved test cases driving everything downstream. */
export interface WorkflowCase {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
}

/** Per-case semantic plan result — keyed by case ID so parallel authoring branches merge without clobbering. */
export interface CasePlanResult {
  caseId: string;
  status: 'pending' | 'planned' | 'failed';
  planRef: string | null;
  modelResponseId?: string;
  error?: WorkflowError;
}

/** Compiled script artifact ref/digest — NOT the repeated source (Compilation group). */
export interface CompiledScriptRef {
  caseId: string;
  scriptRef: string;
  digest: string;
  ok: boolean;
}
export interface CompilationDiagnostic {
  caseId: string;
  kind: 'AMBIGUOUS_SELECTOR' | 'UNRESOLVED_SELECTOR' | 'INVALID_STEP' | 'EMPTY_PLAN';
  message: string;
  target?: string;
}
export interface WorkflowCompilation {
  scripts: CompiledScriptRef[];
  diagnostics: CompilationDiagnostic[];
  compilerVersion: string | null;
}

/** Durable interrupt correlation + decision audit (Review group) — one shape reused by review_cases/review_scripts. */
export interface PendingReview {
  correlationId: string;
  kind: 'cases' | 'scripts';
  requestedAt: string;
  /** Digest of the artifact under review, so a resume can detect a stale/edited mismatch. */
  digest: string;
}
export interface ReviewResolution {
  correlationId: string;
  decision: 'approved' | 'rejected' | 'revised';
  actor: string;
  decidedAt: string;
}
export interface WorkflowReview {
  pending: PendingReview | null;
  resolution: ReviewResolution | null;
}

/** Replay-safe execution attempt — keyed by `(runId, scriptSetDigest, logicalAttempt)` per A.3.3. */
export interface ExecutionAttempt {
  scriptSetDigest: string;
  logicalAttempt: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  endedAt?: string;
  resultRef: string | null;
}
export interface ExecutionAggregate {
  totalCases: number;
  passed: number;
  failed: number;
  durationMs: number;
}
export interface WorkflowExecution {
  attempts: ExecutionAttempt[];
  aggregate: ExecutionAggregate | null;
  evidenceRefs: string[];
}

/** Model/node cost+performance — one row per node call, never a raw prompt (Authoring/Diagnostics group). */
export interface UsageRecord {
  node: string;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  timestamp: string;
}

/** Finalizer-owned terminal summary — the compact answer, never a re-dump of upstream state. */
export interface WorkflowOutput {
  summary: string;
  reportRef: string | null;
  reason?: string;
}

// ---------------------------------------------------------------------------------------------
// Reducers (Section 6.2) — used ONLY for the three fields that need merge-not-replace semantics.
// ---------------------------------------------------------------------------------------------

const MAX_IN_STATE_ERRORS = 100;

/** Dedupe key mirrors events.ts's idempotency shape so a retried node can't duplicate the same error. */
function errorDedupeKey(e: WorkflowError): string {
  return `${e.nodeName ?? ''}:${e.class}:${e.message}`;
}

/** Bounded append + dedupe for typed errors/warnings — never grows unbounded, never silently drops the newest. */
function appendErrors(existing: WorkflowError[], incoming: WorkflowError | WorkflowError[]): WorkflowError[] {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  if (list.length === 0) return existing;
  const seen = new Set(existing.map(errorDedupeKey));
  const merged = existing.slice();
  for (const e of list) {
    const key = errorDedupeKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  return merged.length > MAX_IN_STATE_ERRORS ? merged.slice(merged.length - MAX_IN_STATE_ERRORS) : merged;
}

/** Reducer keyed by case ID — parallel per-case plan/compile branches merge without clobbering siblings. */
function mergePlansByCase(
  existing: Record<string, CasePlanResult>,
  incoming: CasePlanResult | CasePlanResult[],
): Record<string, CasePlanResult> {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  const merged = { ...existing };
  for (const result of list) merged[result.caseId] = result;
  return merged;
}

/** Append/reducer keyed by `(scriptSetDigest, logicalAttempt)` — replay-safe, matches A.3.3's idempotency key. */
function appendExecutionAttempts(existing: ExecutionAttempt[], incoming: ExecutionAttempt | ExecutionAttempt[]): ExecutionAttempt[] {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  if (list.length === 0) return existing;
  const merged = existing.slice();
  for (const attempt of list) {
    const idx = merged.findIndex((a) => a.scriptSetDigest === attempt.scriptSetDigest && a.logicalAttempt === attempt.logicalAttempt);
    if (idx >= 0) merged[idx] = attempt;
    else merged.push(attempt);
  }
  return merged;
}

function appendUsage(existing: UsageRecord[], incoming: UsageRecord | UsageRecord[]): UsageRecord[] {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  return list.length === 0 ? existing : existing.concat(list);
}

function appendEvidenceRefs(existing: string[], incoming: string | string[]): string[] {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  return list.length === 0 ? existing : existing.concat(list);
}

// ---------------------------------------------------------------------------------------------
// Top-level Annotation.Root — every field from Appendix A.4's table.
// ---------------------------------------------------------------------------------------------

export const WorkflowStateAnnotation = Annotation.Root({
  // Identity — immutable for the life of the thread.
  schemaVersion: Annotation<number>,
  graphVersion: Annotation<number>,
  engine: Annotation<WorkflowEngine>,
  runId: Annotation<string>,
  threadId: Annotation<string>,
  requestId: Annotation<string>,
  tenantId: Annotation<string>,
  workspaceId: Annotation<string>,
  projectId: Annotation<string>,
  applicationId: Annotation<string | null>,
  requestedBy: Annotation<string>,
  createdAt: Annotation<string>,
  request: Annotation<WorkflowRequest>,
  credentialRef: Annotation<CredentialRef | null>,
  mission: Annotation<MissionRef | null>,

  // Workflow control — mutable, single-writer-per-update but no merge semantics needed.
  status: Annotation<WorkflowStatus>,
  stage: Annotation<WorkflowStage>,
  cancelRequested: Annotation<boolean>,
  startedAt: Annotation<string | null>,
  updatedAt: Annotation<string | null>,
  completedAt: Annotation<string | null>,
  retryCounters: Annotation<Record<string, number>>,
  rediscoveryAttempts: Annotation<number>,

  // Context — single writer per branch, joined by join_context.
  context: Annotation<WorkflowContext>,

  // Evidence — replaced wholesale per build/rediscovery; the gate is the sole writer of `gate`.
  evidence: Annotation<WorkflowEvidence>,

  // Authoring — cases replace only through approved review; coverage/risk replace when cases change.
  cases: Annotation<WorkflowCase[]>,
  coveragePlan: Annotation<CoveragePlan | null>,
  riskScores: Annotation<RiskScore[]>,
  plansByCase: Annotation<Record<string, CasePlanResult>, CasePlanResult | CasePlanResult[]>({ reducer: mergePlansByCase, default: () => ({}) }),

  // Compilation — replaced wholesale per compilation pass.
  compilation: Annotation<WorkflowCompilation>,

  // Review — durable interrupt correlation and the resulting decision.
  review: Annotation<WorkflowReview>,

  // Execution — attempts are append/reducer (replay-safe); aggregate/evidenceRefs per A.4.
  execution: Annotation<WorkflowExecution>({
    reducer: (left, right) => ({
      attempts: appendExecutionAttempts(left.attempts, right.attempts),
      aggregate: right.aggregate !== undefined ? right.aggregate : left.aggregate,
      evidenceRefs: right.evidenceRefs ? appendEvidenceRefs(left.evidenceRefs, right.evidenceRefs) : left.evidenceRefs,
    }),
    default: () => ({ attempts: [], aggregate: null, evidenceRefs: [] }),
  }),

  // Diagnostics — bounded append/dedupe; never a silent drop of the newest error.
  errors: Annotation<WorkflowError[]>({ reducer: appendErrors, default: () => [] }),
  usage: Annotation<UsageRecord[]>({ reducer: appendUsage, default: () => [] }),

  // Event ordering + terminal output.
  eventCursor: Annotation<number>,
  output: Annotation<WorkflowOutput | null>,
});

export type WorkflowState = typeof WorkflowStateAnnotation.State;
export type WorkflowStateUpdate = typeof WorkflowStateAnnotation.Update;

// ---------------------------------------------------------------------------------------------
// Zod validation — for rehydrated checkpoints crossing the trust boundary (Section 17.1).
// ---------------------------------------------------------------------------------------------

/** Local mirror of errors.ts's private schema (that module doesn't export it) — kept in exact lockstep with WorkflowError. */
const workflowErrorSchema = z.object({
  class: z.enum(Object.values(WORKFLOW_ERROR_CLASSES) as [WorkflowErrorClass, ...WorkflowErrorClass[]]),
  message: z.string(),
  retryable: z.boolean(),
  maxAttempts: z.number().int().nonnegative(),
  details: z.record(z.string(), z.unknown()).optional(),
  nodeName: z.string().optional(),
  timestamp: z.string().optional(),
}) satisfies z.ZodType<WorkflowError>;

const credentialRefSchema = z.object({ websiteId: z.string(), role: z.string() });

const workflowRequestSchema = z.object({
  goal: z.string(),
  requestedCaseCount: z.number().int().nonnegative(),
  reviewPolicy: z.enum(['auto', 'manual']),
  executionPolicy: z.enum(['auto', 'manual', 'skip']),
  understanding: z.string().optional(),
});

const missionRefSchema = z.object({
  platformType: z.enum(['ADMIN', 'RUNTIME']),
  platform: z.string(),
  runtimeSurface: z.enum(['shockwave', 'keystone']).nullable(),
  applicationId: z.string().nullable(),
  moduleId: z.string().nullable(),
  tabId: z.string().nullable(),
  targetUrl: z.string(),
  executionScope: z.string(),
});

const contextBudgetEntrySchema = z.object({
  key: z.string(),
  included: z.boolean(),
  reason: z.string(),
  tokenEstimate: z.number().optional(),
});

const workflowContextSchema = z.object({
  metadata: z.object({
    ref: z.string(), digest: z.string(), objectCount: z.number(), source: z.enum(['live', 'cached', 'unavailable']),
  }).nullable(),
  repository: z.object({
    ref: z.string(), digest: z.string(), revision: z.string(), filesSearched: z.number(), source: z.enum(['live', 'cached', 'unavailable']),
  }).nullable(),
  roles: z.array(z.object({ role: z.string(), testDataRef: z.string() })),
  budget: z.array(contextBudgetEntrySchema),
});

const evidenceCountsSchema = z.object({ live: z.number(), cached: z.number(), inferred: z.number(), unverified: z.number() });

const targetCatalogEntrySchema = z.object({
  semanticName: z.string(),
  evidenceKind: z.enum(['UI', 'API', 'DB', 'PERF', 'A11Y', 'LOG']),
  confidence: z.enum(['verified-live', 'verified-static', 'inferred', 'unverified']),
});

const workflowEvidenceSchema = z.object({
  registryRef: z.string().nullable(),
  metadataGraphRef: z.string().nullable(),
  evidenceGraphRef: z.string().nullable(),
  countsByProvenance: evidenceCountsSchema,
  targetCatalog: z.array(targetCatalogEntrySchema),
  gate: z.object({
    decision: z.enum(['continue', 'targeted_retry', 'blocked']),
    reasons: z.array(z.string()),
    missingRequirements: z.array(z.string()),
  }).nullable(),
});

const workflowCaseSchema = z.object({
  id: z.string(), title: z.string(), description: z.string().optional(), tags: z.array(z.string()).optional(),
});

const casePlanResultSchema = z.object({
  caseId: z.string(),
  status: z.enum(['pending', 'planned', 'failed']),
  planRef: z.string().nullable(),
  modelResponseId: z.string().optional(),
  error: workflowErrorSchema.optional(),
});

const workflowCompilationSchema = z.object({
  scripts: z.array(z.object({ caseId: z.string(), scriptRef: z.string(), digest: z.string(), ok: z.boolean() })),
  diagnostics: z.array(z.object({
    caseId: z.string(),
    kind: z.enum(['AMBIGUOUS_SELECTOR', 'UNRESOLVED_SELECTOR', 'INVALID_STEP', 'EMPTY_PLAN']),
    message: z.string(),
    target: z.string().optional(),
  })),
  compilerVersion: z.string().nullable(),
});

const workflowReviewSchema = z.object({
  pending: z.object({
    correlationId: z.string(), kind: z.enum(['cases', 'scripts']), requestedAt: z.string(), digest: z.string(),
  }).nullable(),
  resolution: z.object({
    correlationId: z.string(), decision: z.enum(['approved', 'rejected', 'revised']), actor: z.string(), decidedAt: z.string(),
  }).nullable(),
});

const executionAttemptSchema = z.object({
  scriptSetDigest: z.string(),
  logicalAttempt: z.number().int().nonnegative(),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  resultRef: z.string().nullable(),
});

const workflowExecutionSchema = z.object({
  attempts: z.array(executionAttemptSchema),
  aggregate: z.object({
    totalCases: z.number(), passed: z.number(), failed: z.number(), durationMs: z.number(),
  }).nullable(),
  evidenceRefs: z.array(z.string()),
});

const usageRecordSchema = z.object({
  node: z.string(),
  modelName: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  latencyMs: z.number().optional(),
  timestamp: z.string(),
});

const workflowOutputSchema = z.object({
  summary: z.string(), reportRef: z.string().nullable(), reason: z.string().optional(),
});

// Mirrors coveragePlan.ts's own coverageItemSchema / riskAnalysis.ts's RiskScore shape exactly (kept in
// lockstep by importing the same COVERAGE_KINDS enum rather than re-declaring it).
const coverageItemSchema = z.object({
  kind: z.enum(COVERAGE_KINDS),
  title: z.string(),
  targetObject: z.string().optional(),
  rationale: z.string().optional(),
  caseIndex: z.number().optional(),
}) satisfies z.ZodType<CoverageItem>;
const coveragePlanSchema = z.object({ items: z.array(coverageItemSchema) }).nullable() satisfies z.ZodType<CoveragePlan | null>;
const riskFactorSchema = z.object({ name: z.string(), weight: z.number() }) satisfies z.ZodType<RiskFactor>;
const riskScoreSchema = z.object({
  item: coverageItemSchema, score: z.number(), factors: z.array(riskFactorSchema),
}) satisfies z.ZodType<RiskScore>;
const riskScoresSchema = z.array(riskScoreSchema);

export const workflowStateSchema = z.object({
  schemaVersion: z.number().int(),
  graphVersion: z.number().int(),
  engine: z.enum(WORKFLOW_ENGINES),
  runId: z.string(),
  threadId: z.string(),
  requestId: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  applicationId: z.string().nullable(),
  requestedBy: z.string(),
  createdAt: z.string(),
  request: workflowRequestSchema,
  credentialRef: credentialRefSchema.nullable(),
  mission: missionRefSchema.nullable(),
  status: z.enum(WORKFLOW_STATUSES),
  stage: z.string(),
  cancelRequested: z.boolean(),
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  retryCounters: z.record(z.string(), z.number()),
  rediscoveryAttempts: z.number().int().nonnegative(),
  context: workflowContextSchema,
  evidence: workflowEvidenceSchema,
  cases: z.array(workflowCaseSchema),
  coveragePlan: coveragePlanSchema,
  riskScores: riskScoresSchema,
  plansByCase: z.record(z.string(), casePlanResultSchema),
  compilation: workflowCompilationSchema,
  review: workflowReviewSchema,
  execution: workflowExecutionSchema,
  errors: z.array(workflowErrorSchema),
  usage: z.array(usageRecordSchema),
  eventCursor: z.number().int().nonnegative(),
  output: workflowOutputSchema.nullable(),
});
// Not `satisfies z.ZodType<WorkflowState>`: zod v4's inferred output for this many nested nullable/optional
// layers structurally diverges from WorkflowState's required-key shape even though every value type matches
// (each leaf schema above is already `satisfies`-checked individually). parseWorkflowState below is the
// actual trust-boundary check; this schema is validated against real fixtures in the Phase 1 test file.

export function parseWorkflowState(json: unknown): WorkflowState | null {
  const r = workflowStateSchema.safeParse(json);
  return r.success ? (r.data as WorkflowState) : null;
}

// ---------------------------------------------------------------------------------------------
// Factory — seeds a brand-new thread from required identity fields.
// ---------------------------------------------------------------------------------------------

export interface CreateInitialWorkflowStateInput {
  runId: string;
  threadId: string;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  applicationId?: string | null;
  requestedBy: string;
  request: WorkflowRequest;
  mission: MissionRef | null;
  credentialRef?: CredentialRef | null;
}

/** Builds a valid empty/starting WorkflowState — call once per new thread, before the first node runs. */
export function createInitialWorkflowState(input: CreateInitialWorkflowStateInput): WorkflowState {
  const now = new Date().toISOString();
  return {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    graphVersion: WORKFLOW_GRAPH_VERSION,
    engine: 'langgraph',
    runId: input.runId,
    threadId: input.threadId,
    requestId: input.requestId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    applicationId: input.applicationId ?? null,
    requestedBy: input.requestedBy,
    createdAt: now,
    request: input.request,
    credentialRef: input.credentialRef ?? null,
    mission: input.mission,
    status: 'queued',
    stage: 'validate_request',
    cancelRequested: false,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    retryCounters: {},
    rediscoveryAttempts: 0,
    context: { metadata: null, repository: null, roles: [], budget: [] },
    evidence: { registryRef: null, metadataGraphRef: null, evidenceGraphRef: null, countsByProvenance: { live: 0, cached: 0, inferred: 0, unverified: 0 }, targetCatalog: [], gate: null },
    cases: [],
    coveragePlan: null,
    riskScores: [],
    plansByCase: {},
    compilation: { scripts: [], diagnostics: [], compilerVersion: null },
    review: { pending: null, resolution: null },
    execution: { attempts: [], aggregate: null, evidenceRefs: [] },
    errors: [],
    usage: [],
    eventCursor: 0,
    output: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Secret-leakage guard — defense-in-depth structural check, not a cryptographic guarantee.
// ---------------------------------------------------------------------------------------------

/** Key-name denylist (case/separator-insensitive) for anything that must never appear in checkpointed state. */
const FORBIDDEN_KEY_PATTERN = /(password|passwd|secret|apikey|api_key|cookie|authorization|bearer|privatekey|private_key)/i;
/**
 * `token` is checked separately: a bare/plain "token" key (authToken, accessToken, refreshToken) is a real
 * secret, but this schema also has legitimate token *counts* (inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens, tokenEstimate) that must NOT trip the guard. Only the plural or Count/Estimate-suffixed
 * forms are counts; a bare singular "...token" is always treated as a secret.
 */
const FORBIDDEN_TOKEN_PATTERN = /token/i;
const TOKEN_COUNT_ALLOWLIST = /tokens(count|estimate)?$|token(count|estimate)$/i;
/** Structural denylist for objects that must never be embedded (only refs/digests of these are allowed). */
const FORBIDDEN_CONSTRUCTOR_NAMES = new Set(['Browser', 'BrowserContext', 'Page', 'ChildProcess', 'AbortSignal']);

/** Thrown by `assertNoSecretLeakage` — carries the offending key path for a fast, precise fix. */
export class SecretLeakageError extends Error {
  constructor(public readonly path: string) {
    super(`WorkflowState secret-leakage guard tripped at "${path}" — checkpointed state must hold only refs/digests, never secrets or live objects.`);
    this.name = 'SecretLeakageError';
  }
}

/**
 * Recursively scans a (rehydrated or about-to-be-persisted) state object for forbidden key names or
 * structurally forbidden object types. Throws SecretLeakageError on the first hit; pragmatic denylist,
 * not exhaustive — the real guarantee is that these fields are structurally absent from WorkflowState's
 * own type, this is a defense-in-depth test-hook for the Phase 1 exit-gate test.
 */
export function assertNoSecretLeakage(state: unknown, path = '$'): void {
  if (state == null || typeof state !== 'object') return;
  const ctorName = (state as { constructor?: { name?: string } }).constructor?.name;
  if (ctorName && FORBIDDEN_CONSTRUCTOR_NAMES.has(ctorName)) throw new SecretLeakageError(path);

  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_KEY_PATTERN.test(key)) throw new SecretLeakageError(childPath);
    if (FORBIDDEN_TOKEN_PATTERN.test(key) && !TOKEN_COUNT_ALLOWLIST.test(key)) throw new SecretLeakageError(childPath);
    if (Array.isArray(value)) {
      value.forEach((item, i) => assertNoSecretLeakage(item, `${childPath}[${i}]`));
    } else if (value && typeof value === 'object') {
      assertNoSecretLeakage(value, childPath);
    }
  }
}
