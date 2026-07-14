/**
 * Review node helpers — durable human-review interrupt/resume (Phase 5).
 *
 * Wraps LangGraph's `interrupt()` for the review_cases/review_scripts gates. `interrupt()` pauses by
 * THROWING GraphInterrupt on the first pass and returns the human's resume value when the thread is
 * re-invoked with a Command — so the node re-runs from the top on resume, and everything before the
 * interrupt call must be pure/idempotent. That is why the correlation id is derived deterministically
 * from the artifact digest: the resumed re-run rebuilds the exact same id, making a stale or
 * mismatched decision detectable instead of silently approving the wrong artifact.
 */
import { interrupt } from '@langchain/langgraph';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES } from '../errors';
import type { PendingReview, ReviewResolution, WorkflowReview } from '../state';

export const REVIEW_DECISIONS = ['approved', 'rejected', 'revised'] as const;

function isReviewDecision(value: unknown): value is ReviewResolution['decision'] {
  return (REVIEW_DECISIONS as readonly unknown[]).includes(value);
}

/** correlationId is deterministic (`kind:digest`) — the post-resume re-run of the node MUST rebuild the same id so duplicate/stale decisions are detectable. */
export function buildPendingReview(kind: 'cases' | 'scripts', artifactDigest: string): PendingReview {
  return {
    correlationId: `${kind}:${artifactDigest}`,
    kind,
    requestedAt: new Date().toISOString(),
    digest: artifactDigest,
  };
}

/** The ONLY node helper allowed to throw: LangGraph's interrupt() itself works by throwing (so no try/catch around it), and a mismatched resume must abort rather than approve the wrong artifact. */
export function requestReviewInterrupt(kind: 'cases' | 'scripts', artifactDigest: string): ReviewResolution {
  const pending = buildPendingReview(kind, artifactDigest);
  const resumed = interrupt<PendingReview, unknown>(pending);
  return validateResolution(pending, resumed);
}

/** Trust-boundary check on the human resume payload — it must answer exactly the pending request. */
function validateResolution(pending: PendingReview, resumed: unknown): ReviewResolution {
  if (!resumed || typeof resumed !== 'object') {
    throw new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
      `Review resume payload for ${pending.correlationId} is not an object.`,
      { expectedCorrelationId: pending.correlationId },
      'review',
    );
  }
  const r = resumed as Partial<ReviewResolution>;
  if (r.correlationId !== pending.correlationId) {
    // A stale/mismatched decision must never approve the wrong artifact — hard invariant, not recoverable.
    throw new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
      'Review resume correlationId does not match the pending review.',
      { expectedCorrelationId: pending.correlationId, receivedCorrelationId: r.correlationId ?? null },
      'review',
    );
  }
  if (!isReviewDecision(r.decision)) {
    throw new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
      `Review decision "${String(r.decision)}" is not one of ${REVIEW_DECISIONS.join('/')}.`,
      { correlationId: pending.correlationId, decision: r.decision ?? null },
      'review',
    );
  }
  return {
    correlationId: pending.correlationId,
    decision: r.decision,
    // Actor is audit metadata — defaulted rather than rejecting an otherwise-valid decision.
    actor: typeof r.actor === 'string' && r.actor ? r.actor : 'unknown',
    // decidedAt is filled here when the resume layer omitted it.
    decidedAt: typeof r.decidedAt === 'string' && r.decidedAt ? r.decidedAt : new Date().toISOString(),
  };
}

/** LangGraph node body: interrupt for a decision, return the `review` state update recording request + resolution. */
export function reviewNodeUpdate(kind: 'cases' | 'scripts', artifactDigest: string): { review: WorkflowReview } {
  const pending = buildPendingReview(kind, artifactDigest);
  const resolution = requestReviewInterrupt(kind, artifactDigest);
  return { review: { pending, resolution } };
}
