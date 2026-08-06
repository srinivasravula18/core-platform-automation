/** Evidence-grounded bug finding — permanently on. Observed element state flows to the compiler
 * so state assertions are validated against reality instead of guessed. */
export function isEvidenceOracleEnabled(): boolean {
  return true;
}
