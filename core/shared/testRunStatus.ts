const CLOSED_RUN_STATUS = /completed|closed|failed|cancelled/i;
const PENDING_REVIEW_RUN_STATUS = /pending review|review required/i;
export const MANUAL_RUN_STALE_MS = 15 * 60 * 1000;

export function isPendingReviewTestRun(run: { status?: unknown }): boolean {
  return PENDING_REVIEW_RUN_STATUS.test(String(run?.status || ''));
}

export function isClosedTestRun(run: { status?: unknown }): boolean {
  if (isPendingReviewTestRun(run)) return false;
  return CLOSED_RUN_STATUS.test(String(run?.status || ''));
}

export function isActiveTestRun(run: { status?: unknown }): boolean {
  return !isClosedTestRun(run);
}

export function agentRunStatusForList(status: unknown): string {
  switch (String(status || '').toLowerCase()) {
    case 'completed': return 'Completed — Pending Review';
    case 'failed': return 'Failed — Pending Review';
    case 'cancelled': return 'Draft';
    case 'review_required': return 'Review Required';
    case 'coverage_options': return 'Coverage Options';
    case 'running': return 'In Progress';
    default: return 'Draft';
  }
}

/**
 * A manual run left in `Running` after its worker stopped is not active.  The
 * runs endpoint repairs these records on read; consumers that only aggregate
 * run data (such as the dashboard) use this predicate so their count agrees
 * before that repair has been persisted.
 */
export function isStaleManualTestRun(run: any, now = Date.now()): boolean {
  if (!/^running$/i.test(String(run?.status || ''))) return false;
  const execution = run?.triggerMeta?.manualExecution || {};
  if (!execution.attemptId && run?.triggerMeta?.automationJobId) return false;
  const heartbeat = Date.parse(String(
    execution.heartbeatAt || execution.startedAt || run?.updatedAt || run?.startedAt || '',
  ));
  return Number.isFinite(heartbeat) && now - heartbeat > MANUAL_RUN_STALE_MS;
}
