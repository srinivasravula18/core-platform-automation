/** Grounding disambiguation — permanently on. Rescues non-unique row controls with a row-key-scoped
 * locator instead of dropping them from the evidence catalog. */
export function isGroundingDisambiguationEnabled(): boolean {
  return true;
}
