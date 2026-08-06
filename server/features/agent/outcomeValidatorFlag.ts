/** Validator loop (observe outcome → classify) — permanently on, no env flag. After execution each failure is
 * classified against the behaviour oracle as assertion-defect (bad test), app-defect (real bug), or infra/flake,
 * so a genuine product defect is never confused with a wrong assertion. Report-only (logs + stash; never changes
 * pass/fail). */
export function isOutcomeValidatorEnabled(): boolean {
  return true;
}
