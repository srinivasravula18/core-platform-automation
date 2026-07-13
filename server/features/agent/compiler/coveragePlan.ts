/**
 * Coverage Plan (Phase 5) — enumerated QA scenario kinds + Case Specifications. This COMPOSES the existing
 * case writer: rather than replacing reviewed cases, it classifies each into a closed coverage kind so Risk
 * Analysis can weight them before the Test Plan is authored. The LLM (if used) is constrained to the closed
 * `COVERAGE_KINDS` enum; a deterministic classifier derives a plan from existing cases with no LLM at all.
 */
import { z } from 'zod';

export const COVERAGE_KINDS = [
  'Selection', 'Filtering', 'Sorting', 'Pagination', 'CRUD', 'Permissions', 'Validation', 'ErrorHandling',
  'Lookup', 'Relationship', 'Import', 'Export', 'Performance', 'Accessibility', 'ApiBehaviour', 'Regression',
] as const;
export type CoverageKind = typeof COVERAGE_KINDS[number];

export interface CoverageItem {
  kind: CoverageKind;
  title: string;
  targetObject?: string;
  rationale?: string;
  /** Index of the source case (when derived from reviewed cases). */
  caseIndex?: number;
}
export interface CoveragePlan { items: CoverageItem[] }

export const coverageItemSchema = z.object({
  kind: z.enum(COVERAGE_KINDS),
  title: z.string().min(1),
  targetObject: z.string().optional(),
  rationale: z.string().optional(),
  caseIndex: z.number().optional(),
}).strict();

export const coveragePlanSchema = z.object({ items: z.array(coverageItemSchema).min(1) });

// Deterministic keyword → coverage-kind classifier (transparent; no LLM). First match wins; default CRUD.
const RULES: { kind: CoverageKind; re: RegExp }[] = [
  { kind: 'Permissions', re: /permission|role|access|unauthor|forbidden|rbac/i },
  { kind: 'Validation', re: /valid|required|constraint|format|invalid input/i },
  { kind: 'ErrorHandling', re: /error|fail|timeout|offline|retry/i },
  { kind: 'Filtering', re: /filter|search|query|no matches/i },
  { kind: 'Sorting', re: /sort|order by|ascending|descending/i },
  { kind: 'Pagination', re: /paginat|page \d|next page|later rows|load more|scroll/i },
  { kind: 'Lookup', re: /lookup|reference field|related record/i },
  { kind: 'Relationship', re: /relationship|child|parent|related list/i },
  { kind: 'Import', re: /import|upload|bulk load/i },
  { kind: 'Export', re: /export|download|csv/i },
  { kind: 'Performance', re: /performance|latency|slow|throttled|load time/i },
  { kind: 'Accessibility', re: /accessib|a11y|aria|keyboard|screen reader/i },
  { kind: 'ApiBehaviour', re: /api|endpoint|response|schema|contract/i },
  { kind: 'Regression', re: /regression|baseline|drift/i },
  { kind: 'Selection', re: /select|open|view|list appears|table view|reopen/i },
];

function classify(text: string): CoverageKind {
  for (const r of RULES) if (r.re.test(text)) return r.kind;
  return 'CRUD';
}

/** Derive a Coverage Plan from reviewed test cases (no LLM). Each case → one classified coverage item. */
export function coveragePlanFromCases(cases: any[], targetObject?: string): CoveragePlan {
  const items: CoverageItem[] = (cases || []).map((c, i) => {
    const title = String(c?.title || `Case ${i + 1}`);
    const hay = `${title} ${String(c?.description || '')} ${(Array.isArray(c?.tags) ? c.tags.join(' ') : '')}`;
    return { kind: classify(hay), title, targetObject, rationale: 'derived from reviewed case', caseIndex: i };
  });
  return { items };
}
