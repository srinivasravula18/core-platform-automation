/** Coverage contract library — the grounding node emits its reports to the blackboard. */
import { goalTermCoverage } from '../../features/agent/workflow/goalTerms';

export type GroundingSource = 'DOM' | 'SWAGGER' | 'METADATA' | 'REPO';

export interface CoverageReport {
  source: GroundingSource;
  /** Goal intent terms this source was asked to cover. */
  requested: string[];
  covered: string[];
  missing: string[];
  /** 0..1 — coverage ratio (1 when nothing was requested; there is nothing to miss). */
  confidence: number;
  /** How many evidence-vocabulary entries this source contributed (for diagnostics). */
  vocabularySize: number;
}

/** Build a source's coverage report by matching goal terms against that source's evidence vocabulary. */
export function buildCoverageReport(source: GroundingSource, goalTerms: string[], vocabulary: string[]): CoverageReport {
  const { covered, missing } = goalTermCoverage(goalTerms, vocabulary);
  const requested = goalTerms.slice();
  const confidence = requested.length === 0 ? 1 : covered.length / requested.length;
  return { source, requested, covered, missing, confidence, vocabularySize: vocabulary.filter(Boolean).length };
}

export type GroundingDecision = 'proceed' | 'reground' | 'block';

export interface GroundingGateResult {
  decision: GroundingDecision;
  reasons: string[];
  reports: CoverageReport[];
  /** Union of goal terms no REQUIRED source covered — what the run still cannot ground. */
  uncoveredTerms: string[];
}

export interface GroundingGateOptions {
  /** Sources that MUST cover the goal for the run to proceed cleanly (default: none required → permissive). */
  requiredSources?: GroundingSource[];
  /** Re-ground attempts already spent — after this many, a still-uncovered required source blocks. */
  regroundAttempts?: number;
  maxRegroundAttempts?: number;
  /** Minimum union coverage ratio across required sources to proceed without re-grounding (default 0 = permissive). */
  minCoverage?: number;
}

/**
 * Evaluate the contract: PROCEED when required sources cover the goal (or nothing is required), REGROUND
 * a bounded number of times when a required source is missing terms, then BLOCK with a named cause. A term
 * counts as covered if ANY required source covers it (sources are complementary, not each-must-cover).
 */
export function evaluateGroundingContract(reports: CoverageReport[], opts: GroundingGateOptions = {}): GroundingGateResult {
  const required = opts.requiredSources ?? [];
  const attempts = opts.regroundAttempts ?? 0;
  const maxAttempts = opts.maxRegroundAttempts ?? 1;
  const minCoverage = opts.minCoverage ?? 0;

  // No required sources OR no goal terms → nothing to enforce; proceed (permissive by default).
  const requiredReports = reports.filter((r) => required.includes(r.source));
  const requestedTerms = new Set<string>();
  for (const r of requiredReports) for (const t of r.requested) requestedTerms.add(t);
  if (!required.length || requestedTerms.size === 0) {
    return { decision: 'proceed', reasons: ['No required grounding sources / no goal terms to enforce (permissive).'], reports, uncoveredTerms: [] };
  }

  // A term is covered if ANY required source covered it.
  const coveredUnion = new Set<string>();
  for (const r of requiredReports) for (const t of r.covered) coveredUnion.add(t);
  const uncovered = [...requestedTerms].filter((t) => !coveredUnion.has(t));
  const coverageRatio = 1 - uncovered.length / requestedTerms.size;

  // Setting requiredSources opts INTO enforcement: full coverage by default, relaxed only by an explicit
  // minCoverage > 0. (Global permissiveness comes from NOT marking a source required, handled above.)
  if (uncovered.length === 0 || (minCoverage > 0 && coverageRatio >= minCoverage)) {
    return {
      decision: 'proceed',
      reasons: [`Required sources cover ${coveredUnion.size}/${requestedTerms.size} goal terms (ratio ${coverageRatio.toFixed(2)}${minCoverage > 0 ? ` ≥ min ${minCoverage}` : ''}).`],
      reports,
      uncoveredTerms: uncovered,
    };
  }

  const missingSources = required.filter((s) => !requiredReports.some((r) => r.source === s));
  const cause = `Required grounding incomplete — uncovered goal terms [${uncovered.join(', ')}]${missingSources.length ? `; sources not reported: ${missingSources.join(', ')}` : ''}`;
  if (attempts < maxAttempts) {
    return { decision: 'reground', reasons: [`${cause}; re-grounding (attempt ${attempts + 1} of ${maxAttempts}).`], reports, uncoveredTerms: uncovered };
  }
  return { decision: 'block', reasons: [`${cause}; exhausted ${maxAttempts} re-ground attempt(s) — surfacing a named gate instead of guessing.`], reports, uncoveredTerms: uncovered };
}
