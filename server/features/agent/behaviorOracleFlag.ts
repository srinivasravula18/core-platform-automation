/** Behavior Oracle (observe-then-assert) — ON by default in code. Set BEHAVIOR_ORACLE_V1=0/false/off to opt out
 * (an app whose create form must never be touched during discovery). */
export function isBehaviorOracleEnabled(): boolean {
  const raw = String(process.env.BEHAVIOR_ORACLE_V1 ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return true;
}
