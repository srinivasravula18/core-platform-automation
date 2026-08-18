/**
 * What Vitals does at boot, and what it lets go of at shutdown.
 *
 * Everything here is best-effort and non-blocking: an unreachable or unconfigured observability
 * store must never stop Test Flow AI from starting. Failures are reported once and the console shows
 * the same problem on the Connect page.
 */

import { syncAlertEvaluator, stopAlertEvaluator } from './alerts';
import { seedBuiltinDashboards } from './builtinDashboards';
import { closeVitalsPool } from './db';
import { isConfigured } from './db';
import { resetControlSession } from './control';

export async function startVitals(): Promise<void> {
  if (!(await isConfigured())) return;

  try {
    const seeded = await seedBuiltinDashboards();
    const written = seeded.filter((outcome) => outcome.seeded);
    if (written.length) console.log(`[vitals] starter dashboards ready: ${written.map((outcome) => outcome.uid).join(', ')}`);
    for (const skipped of seeded.filter((outcome) => !outcome.seeded)) {
      console.log(`[vitals] skipped dashboard "${skipped.uid}" — ${skipped.reason}`);
    }
  } catch (error) {
    // Almost always "the product has not run its own migration yet", which fixes itself.
    console.warn('[vitals] could not seed starter dashboards:', (error as Error).message);
  }

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
