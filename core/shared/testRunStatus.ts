const CLOSED_RUN_STATUS = /completed|closed|failed|cancelled/i;
export const MANUAL_RUN_STALE_MS = 15 * 60 * 1000;

export function isClosedTestRun(run: { status?: unknown }): boolean {
  return CLOSED_RUN_STATUS.test(String(run?.status || ''));
}

export function isActiveTestRun(run: { status?: unknown }): boolean {
  return !isClosedTestRun(run);
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
