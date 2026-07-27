const CLOSED_RUN_STATUS = /completed|closed|failed|cancelled/i;

export function isClosedTestRun(run: { status?: unknown }): boolean {
  return CLOSED_RUN_STATUS.test(String(run?.status || ''));
}

export function isActiveTestRun(run: { status?: unknown }): boolean {
  return !isClosedTestRun(run);
}
