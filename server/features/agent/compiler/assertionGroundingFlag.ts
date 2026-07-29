/** ASSERTION_GROUNDING_V1 — on: correct an expectText value that reformats the target's real label to the
 * actual observed text (literal toContainText else fails a correct app). Off (default) = legacy. */
export function isAssertionGroundingEnabled(): boolean {
  const raw = String(process.env.ASSERTION_GROUNDING_V1 || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
