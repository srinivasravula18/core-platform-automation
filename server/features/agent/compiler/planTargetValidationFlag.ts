/** PLAN_TARGET_VALIDATION_V1 — on: the plan-authoring node validates every locator-bearing target against
 * the verified evidence catalog BEFORE the all-or-nothing compiler sees it. A target that matches no catalog
 * entry (the LLM invented a name / phrased it differently than the catalog) is rejected as a validation
 * issue, so the node's single repair call re-authors it with an exact catalog name — instead of the invented
 * target reaching the compiler, failing to ground, and silently dropping the whole case (a top source of the
 * run-to-run non-determinism). Off (default) = legacy behavior. OPEN_MODULE and context asserts (advisory
 * text targets) are never validated. */
export function isPlanTargetValidationEnabled(): boolean {
  const raw = String(process.env.PLAN_TARGET_VALIDATION_V1 || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
