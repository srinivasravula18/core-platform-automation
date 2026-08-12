/**
 * Shared, deterministic (no LLM) classification of a raw Playwright/mission-runner failure string
 * into an error kind, and whether that kind is a tooling/harness fault rather than a real application
 * defect. Used on both sides so "is this a bug" means the same thing everywhere it's decided:
 * server/features/agent/workflow/defectReporter.ts (defect filing), src/lib/failureAnalysis.ts (the
 * failure breakdown card), and src/components/DeepRunResult.tsx (the live Bugs tab) all import this
 * instead of each re-deriving their own answer.
 */

export type ErrorKind =
  | 'scope-violation' | 'context-mismatch' | 'tooling-obscured' | 'timeout' | 'assertion'
  | 'ambiguous-locator' | 'locator-not-found' | 'navigation' | 'unknown';

/** Deterministic error-kind classification from the raw failure text. */
export function classifyErrorKind(error?: string): ErrorKind {
  const e = String(error || '');
  if (!e) return 'unknown';
  if (/MISSION SCOPE VIOLATION/i.test(e)) return 'scope-violation';
  if (/MISSION CONTEXT MISMATCH/i.test(e)) return 'context-mismatch';
  // A locator that matched a background control obscured by an open overlay is a grounding/tooling fault, not a
  // product defect — classified before 'timeout' since the runtime marks it while relabeling the click timeout.
  if (/\bTOOLING_OBSCURED\b|\[tooling\]/i.test(e)) return 'tooling-obscured';
  if (/Timed?\s?out|timeout/i.test(e)) return 'timeout';
  if (/toBeVisible|toBeHidden|toContainText|toHaveValue|toBeEnabled|toBeDisabled|toBeGreaterThan|expect\(/i.test(e)) return 'assertion';
  if (/strict mode violation|resolved to \d+ elements/i.test(e)) return 'ambiguous-locator';
  if (/no verified selector|not found|unable to find|waiting for locator/i.test(e)) return 'locator-not-found';
  if (/net::|ERR_|ECONNREFUSED|navigation/i.test(e)) return 'navigation';
  return 'unknown';
}

/** Failure kinds that are tooling/harness faults, never real product defects: the test could not be
 *  driven (obscured/ambiguous/missing locator), it ran against the wrong target (scope/context), or the
 *  platform failed internally (unknown). Only the APPLICATION misbehaving (an assertion contradicted by
 *  the live app) belongs in the bug section. */
export const NON_PRODUCT_ERROR_KINDS: ReadonlySet<ErrorKind> = new Set([
  'tooling-obscured', 'ambiguous-locator', 'locator-not-found', 'scope-violation', 'context-mismatch', 'navigation', 'unknown',
]);

export function isNonProductFailure(error?: string): boolean {
  return NON_PRODUCT_ERROR_KINDS.has(classifyErrorKind(error));
}
