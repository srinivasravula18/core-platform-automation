/**
 * Risk Analysis (Phase 5) — runs BEFORE Test Plan authoring and weights/prioritizes coverage items so the
 * highest-risk QA scenarios are planned first. Deterministic and transparent (no LLM): every score is the sum
 * of explainable factors. Change-impact is read from the persistent Object Repository — a control that has
 * evolved across runs (version > 1) raises the risk of scenarios touching its object.
 *
 * Mirrors the weighted-scoring approach already used by api-intelligence/risk.ts, kept self-contained here so
 * the graph layer has no dependency on the API subsystem.
 */
import type { CoverageItem, CoverageKind } from '../compiler/coveragePlan';
import { listControls } from './objectRepository';

/** Base risk weight per coverage kind (higher = more important to test first). Transparent + tunable. */
const BASE_WEIGHT: Record<CoverageKind, number> = {
  Permissions: 9, CRUD: 8, Validation: 8, ErrorHandling: 7, ApiBehaviour: 7, Regression: 7,
  Lookup: 6, Relationship: 6, Import: 6, Export: 5, Filtering: 5, Selection: 4,
  Sorting: 3, Pagination: 3, Performance: 4, Accessibility: 4,
};

export interface RiskFactor { name: string; weight: number }
export interface RiskScore {
  item: CoverageItem;
  score: number;
  factors: RiskFactor[];
}

export interface RiskContext {
  platform?: string;
  application?: string | null;
}

/** Score a single coverage item = base kind weight + change-impact (Object Repository history). */
export function scoreCoverageItem(item: CoverageItem, ctx: RiskContext = {}): RiskScore {
  const factors: RiskFactor[] = [];
  factors.push({ name: `kind:${item.kind}`, weight: BASE_WEIGHT[item.kind] ?? 4 });

  // Change-impact: if the target object's controls have evolved (version > 1) since a prior run, the surface
  // is unstable → raise risk. Read-only over the persistent, versioned repository.
  if (item.targetObject) {
    const controls = listControls({ platform: ctx.platform, application: ctx.application || undefined, object: item.targetObject });
    const evolved = controls.filter((c) => c.current.version > 1).length;
    if (evolved > 0) factors.push({ name: `changed-controls:${evolved}`, weight: Math.min(5, evolved) });
  }

  const score = factors.reduce((s, f) => s + f.weight, 0);
  return { item, score, factors };
}

/**
 * Prioritize a coverage plan: highest risk first. Stable tie-break by original order (caseIndex) so results
 * are deterministic. Returns scored items (score + explainable factors) for transparency.
 */
export function prioritizeCoverage(items: CoverageItem[], ctx: RiskContext = {}): RiskScore[] {
  return items
    .map((it) => scoreCoverageItem(it, ctx))
    .sort((a, b) => b.score - a.score || (a.item.caseIndex ?? 0) - (b.item.caseIndex ?? 0));
}
