/**
 * What Vitals does at boot, and what it lets go of at shutdown.
 *
 * Deliberately almost nothing: Vitals is a reader, and a reader has no business writing to a store
 * it does not own just because a process started. Dashboard layouts are compiled into the console
 * (src/lib/vitals/builtinDashboards.ts) and only become rows when somebody edits one.
 *
 * Everything here is best-effort and non-blocking: an unreachable or unconfigured observability
 * store must never stop Test Flow AI from starting.
 */

import { syncAlertEvaluator, stopAlertEvaluator } from './alerts';
import { closeVitalsPool } from './db';
import { isConfigured } from './db';
import { resetControlSession } from './control';

export async function startVitals(): Promise<void> {
  if (!(await isConfigured())) return;

  try {
    await syncAlertEvaluator();
  } catch (error) {
    console.error('[vitals] could not start the alert evaluator:', (error as Error).message);
  }
}

export async function stopVitals(): Promise<void> {
  resetControlSession();
  await stopAlertEvaluator();
  await closeVitalsPool();
}
