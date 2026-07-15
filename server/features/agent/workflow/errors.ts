/**
 * Workflow error taxonomy and retry classification (LangGraph migration, Phase 1).
 *
 * Retries happen at exactly ONE layer: the LangGraph node retry policy consults
 * `getRetryPolicy` to decide attempts/backoff. This module never retries or sleeps itself —
 * it only classifies errors and declares policy. Serialized/logged errors carry only class,
 * message, and a small `details` bag — never credentials, cookies, raw DOM, or prompt text.
 *
 * Pure leaf module: no imports from LangGraph or from any other workflow file (state.ts,
 * events.ts import FROM here, not the reverse).
 */
import { z } from 'zod';

/** The 10 error classes from the architecture plan (Section 10.5). Never conflate assertion/product failures with infrastructure failures. */
export const WORKFLOW_ERROR_CLASSES = {
  /** Network timeout, connection reset, 429, retryable 5xx. */
  NETWORK_TRANSIENT: 'NETWORK_TRANSIENT',
  /** Model declined to answer the unchanged request; retrying as-is cannot help. */
  MODEL_REFUSAL: 'MODEL_REFUSAL',
  /** Model output failed schema validation; one repair call is allowed, invalid steps are never silently dropped. */
  SCHEMA_INVALID_OUTPUT: 'SCHEMA_INVALID_OUTPUT',
  /** Compiler/grounding could not find enough verified live evidence for a target. */
  EVIDENCE_INSUFFICIENT: 'EVIDENCE_INSUFFICIENT',
  /** Compiler target is ambiguous or unresolved against the catalog. */
  TARGET_UNRESOLVED: 'TARGET_UNRESOLVED',
  /** Browser session could not authenticate. */
  AUTH_FAILURE: 'AUTH_FAILURE',
  /** Execution environment (browser/runner) failed, independent of the script under test. */
  EXECUTION_INFRA_FAILURE: 'EXECUTION_INFRA_FAILURE',
  /** The generated test ran and asserted correctly against the product; a real result, not an orchestration fault. */
  TEST_ASSERTION_FAILURE: 'TEST_ASSERTION_FAILURE',
  /** Checkpoint/state write lost a race; safe to retry idempotently. */
  PERSISTENCE_CONFLICT: 'PERSISTENCE_CONFLICT',
  /** Programmer/schema invariant violated; always a bug, never a transient condition. */
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
} as const;

export type WorkflowErrorClass = (typeof WORKFLOW_ERROR_CLASSES)[keyof typeof WORKFLOW_ERROR_CLASSES];

export type BackoffStrategy = 'exponential-jitter' | 'none';

export interface RetryPolicy {
  maxAttempts: number;
  retryable: boolean;
  backoff: BackoffStrategy;
}

export interface WorkflowError {
  class: WorkflowErrorClass;
  message: string;
  retryable: boolean;
  maxAttempts: number;
  details?: Record<string, unknown>;
  nodeName?: string;
  timestamp?: string;
}

const workflowErrorSchema = z.object({
  class: z.enum(Object.values(WORKFLOW_ERROR_CLASSES) as [WorkflowErrorClass, ...WorkflowErrorClass[]]),
  message: z.string(),
  retryable: z.boolean(),
  maxAttempts: z.number().int().nonnegative(),
  details: z.record(z.string(), z.unknown()).optional(),
  nodeName: z.string().optional(),
  timestamp: z.string().optional(),
}) satisfies z.ZodType<WorkflowError>;

/** Table from Section 10.5 — the single source of truth for attempts/backoff per class. */
const RETRY_POLICY_TABLE: Record<WorkflowErrorClass, RetryPolicy> = {
  NETWORK_TRANSIENT: { maxAttempts: 3, retryable: true, backoff: 'exponential-jitter' },
  MODEL_REFUSAL: { maxAttempts: 1, retryable: false, backoff: 'none' },
  SCHEMA_INVALID_OUTPUT: { maxAttempts: 2, retryable: true, backoff: 'none' },
  EVIDENCE_INSUFFICIENT: { maxAttempts: 2, retryable: true, backoff: 'none' },
  TARGET_UNRESOLVED: { maxAttempts: 2, retryable: true, backoff: 'none' },
  AUTH_FAILURE: { maxAttempts: 2, retryable: true, backoff: 'none' },
  EXECUTION_INFRA_FAILURE: { maxAttempts: 2, retryable: true, backoff: 'none' },
  TEST_ASSERTION_FAILURE: { maxAttempts: 1, retryable: false, backoff: 'none' },
  PERSISTENCE_CONFLICT: { maxAttempts: 3, retryable: true, backoff: 'none' },
  INVARIANT_VIOLATION: { maxAttempts: 1, retryable: false, backoff: 'none' },
};

export function getRetryPolicy(errorClass: WorkflowErrorClass): RetryPolicy {
  return RETRY_POLICY_TABLE[errorClass];
}

/** Pure delay computation for the table's backoff strategy — callers sleep; this module never does. */
export function backoffDelayMs(errorClass: WorkflowErrorClass, attempt: number): number {
  const policy = RETRY_POLICY_TABLE[errorClass];
  if (!policy.retryable || policy.backoff !== 'exponential-jitter') return 0;
  // 4s, 8s, 16s… ±25% jitter — wide enough to outlive a short network blip, bounded by maxAttempts.
  return Math.round(4000 * 2 ** Math.max(0, attempt - 1) * (0.75 + Math.random() * 0.5));
}

/** Throwable/catchable in TS control flow; `toWorkflowError()` produces the plain JSONB-checkpointed shape. */
export class WorkflowRuntimeError extends Error {
  constructor(
    public readonly errorClass: WorkflowErrorClass,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly nodeName?: string,
  ) {
    super(message);
    this.name = 'WorkflowRuntimeError';
  }

  toWorkflowError(): WorkflowError {
    const policy = getRetryPolicy(this.errorClass);
    return {
      class: this.errorClass,
      message: this.message,
      retryable: policy.retryable,
      maxAttempts: policy.maxAttempts,
      details: this.details,
      nodeName: this.nodeName,
      timestamp: new Date().toISOString(),
    };
  }
}

export function isRetryableError(err: unknown): boolean {
  return getRetryPolicy(classifyError(err)).retryable;
}

/** Heuristic mapping from a raw thrown error to the closest class. Unrecognized errors default to no-retry (never broad/infinite retry for the unknown). */
export function classifyError(err: unknown): WorkflowErrorClass {
  if (err instanceof WorkflowRuntimeError) return err.errorClass;

  if (err && typeof err === 'object' && 'name' in err && (err as { name?: unknown }).name === 'ZodError') {
    return WORKFLOW_ERROR_CLASSES.SCHEMA_INVALID_OUTPUT;
  }

  const status = extractStatus(err);
  if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) {
    return WORKFLOW_ERROR_CLASSES.NETWORK_TRANSIENT;
  }
  if (status === 401 || status === 403) return WORKFLOW_ERROR_CLASSES.AUTH_FAILURE;

  const code = extractCode(err);
  if (code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return WORKFLOW_ERROR_CLASSES.NETWORK_TRANSIENT;
  }

  const message = extractMessage(err).toLowerCase();
  if (message.includes('refus')) return WORKFLOW_ERROR_CLASSES.MODEL_REFUSAL;
  if (message.includes('timeout') || message.includes('econnreset')) return WORKFLOW_ERROR_CLASSES.NETWORK_TRANSIENT;

  return WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION;
}

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const s = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' ? s : undefined;
}

function extractCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const c = (err as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
}

export function parseWorkflowError(json: unknown): WorkflowError | null {
  const r = workflowErrorSchema.safeParse(json);
  return r.success ? r.data : null;
}
