/** Plan-target validation — permanently on. Rejects invented target names before the compiler,
 * repairing them against the evidence catalog instead of silently dropping the case. */
export function isPlanTargetValidationEnabled(): boolean {
  return true;
}
