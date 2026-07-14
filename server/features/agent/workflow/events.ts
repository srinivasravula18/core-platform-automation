/**
 * Redacted node-attempt event contract for the LangGraph.js workflow runtime (Phase 1).
 *
 * Every graph node attempt emits a `start` event and exactly one terminal event (`success` |
 * `error` | `interrupt` | `retry`). Events are appended into WorkflowState via `appendWorkflowEvents`
 * (an Annotation reducer) and persisted append-only to Postgres `agent_run_events`
 * (server/db/schema.sql) — this module defines the shape + pure helpers only, no DB I/O.
 *
 * Redaction is structural, not a convention to remember: WorkflowEvent has room for counts, refs,
 * digests, and ids — never prompts, raw tool results, credentials, cookies, or unrestricted DOM/source.
 *
 * Provider-agnostic by hard requirement: model fields are named generically (modelName,
 * modelRequestId, modelResponseId) because Anthropic, OpenAI, and Gemini calls all emit through
 * this same contract.
 *
 * Pure leaf module: no LangGraph import, no `server/db/*` import, no import from any other
 * workflow file (state.ts, checkpointer.ts import FROM here, not the reverse).
 */

export type WorkflowEventStatus = 'start' | 'success' | 'error' | 'interrupt' | 'retry';

/** Local mirror of workflow/errors.ts's WorkflowErrorClass shape — kept as a string, not an import (see header). */
export type WorkflowErrorClassRef = string;

export interface EvidenceCountsByProvenance {
  live?: number;
  cached?: number;
  inferred?: number;
  unverified?: number;
}

export interface WorkflowEvent {
  runId: string;
  threadId: string;
  node: string;
  status: WorkflowEventStatus;
  timestamp: string;

  traceId?: string;
  graphVersion?: string;
  /** Logical attempt number for this node within this run (1-based); distinct from LangGraph's own retry count. */
  attempt?: number;
  checkpointId?: string;

  startedAt?: string;
  endedAt?: string;
  latencyMs?: number;
  errorClass?: WorkflowErrorClassRef;
  interruptReason?: string;
  resumeReason?: string;

  modelRequestId?: string;
  modelResponseId?: string;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  refusal?: boolean;
  schemaValid?: boolean;

  evidenceCounts?: EvidenceCountsByProvenance;
  verifiedTargetCount?: number;
  artifactDigests?: string[];
  artifactRefs?: string[];

  compilerDiagnosticCounts?: Record<string, number>;
  validationOutcome?: 'pass' | 'fail';
  executionAttemptRef?: string;
  executionResultRef?: string;

  /** Sanitized only — never a raw message/stack; see errors.ts classifyError for the class this fingerprints. */
  errorCode?: string;
  stackFingerprint?: string;
}

/** In-state window; full history lives in Postgres. Tune if state payloads grow too large for checkpoint writes. */
export const MAX_IN_STATE_EVENTS = 500;

/**
 * Deterministic idempotency key — same (runId, node, attempt, status) always collides, so a retried
 * append of the same logical attempt never creates a duplicate row. This is the caller's `event_id`.
 */
export function eventIdempotencyKey(event: Pick<WorkflowEvent, 'runId' | 'node' | 'attempt' | 'status'>): string {
  const attempt = event.attempt ?? 0;
  return `${event.runId}:${event.node}:${attempt}:${event.status}`;
}

function dedupeAppend(existing: WorkflowEvent[], incoming: WorkflowEvent[]): WorkflowEvent[] {
  const seen = new Set(existing.map(eventIdempotencyKey));
  const merged = existing.slice();
  for (const event of incoming) {
    const key = eventIdempotencyKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.length > MAX_IN_STATE_EVENTS ? merged.slice(merged.length - MAX_IN_STATE_EVENTS) : merged;
}

/** LangGraph Annotation reducer: `Annotation<WorkflowEvent[]>({ reducer: appendWorkflowEvents, default: () => [] })`. */
export function appendWorkflowEvents(
  existing: WorkflowEvent[],
  incoming: WorkflowEvent | WorkflowEvent[],
): WorkflowEvent[] {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  if (list.length === 0) return existing;
  return dedupeAppend(existing, list);
}

export interface NodeAttemptIdentity {
  runId: string;
  threadId: string;
  node: string;
  traceId?: string;
  graphVersion?: string;
  attempt?: number;
  checkpointId?: string;
}

/** Fields beyond identity that a terminal event may carry; all optional since early phases populate a subset. */
export type TerminalEventFields = Omit<WorkflowEvent, keyof NodeAttemptIdentity | 'status' | 'timestamp' | 'startedAt'>;

/** Builds the `start` event for a node attempt. Call once per logical attempt, before any model/tool work. */
export function startEvent(identity: NodeAttemptIdentity): WorkflowEvent {
  const now = new Date().toISOString();
  return { ...identity, status: 'start', timestamp: now, startedAt: now };
}

/**
 * Builds the terminal event for a node attempt, deriving latencyMs from the paired start event's
 * startedAt so call sites never hand-compute elapsed time.
 */
export function terminalEvent(
  identity: NodeAttemptIdentity,
  status: Exclude<WorkflowEventStatus, 'start'>,
  startedAt: string,
  fields: TerminalEventFields = {},
): WorkflowEvent {
  const endedAt = new Date().toISOString();
  const latencyMs = Date.parse(endedAt) - Date.parse(startedAt);
  return {
    ...identity,
    ...fields,
    status,
    timestamp: endedAt,
    startedAt,
    endedAt,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : undefined,
  };
}
