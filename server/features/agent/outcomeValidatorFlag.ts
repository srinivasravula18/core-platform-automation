/** Validator loop (observe outcome → classify) — ON by default in code. After execution each failure is
 * classified against the behaviour oracle as assertion-defect (bad test), app-defect (real bug), or infra/flake,
 * so a genuine product defect is never confused with a wrong assertion. Report-only (logs + stash; never changes
 * pass/fail). Set VALIDATE_OUTCOME_V1=0/false/off to opt out. */
export function isOutcomeValidatorEnabled(): boolean {
  const raw = String(process.env.VALIDATE_OUTCOME_V1 ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return true;
}
