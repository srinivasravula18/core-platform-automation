/**
 * Autonomous QA Analyst (bug-investigation framework, Phase 8; flag `AGENT_ANALYST`) — per-run release
 * intelligence. Deterministic feature extraction answers, with evidence: what changed vs prior runs
 * (pass-rate/duration deltas), what regressed, what looks suspicious (intent mismatches on passes), what's
 * flaky vs product bug, which business rules were violated, and what visually drifted. The numbers come
 * from data; an optional ONE-call LLM narrative writes the judgment prose. Output = AnalystReport, stored
 * on the run record (`analyst_report`). Report-only: never throws, never affects the run verdict.
 */
import { z } from 'zod';
import { systemPromptFor } from '../../../ai/systemPrompts';
import type { Observation } from '../../../shared/schemas';
import type { DefectReport, PriorRunSummary, TestResultLike } from './defectReporter';
import type { InvestigationSummary } from './nodes/investigation';
import type { VisualFinding } from '../validation/visualBaseline';
import { generateStrictObject } from './nodes/authoring';

/** Flag reader (lazy, per the dotenv load-order convention). */
export function isAnalystEnabled(): boolean {
  return ['1', 'true'].includes(String(process.env.AGENT_ANALYST || '').toLowerCase());
}

export interface AnalystInput {
  runId: string;
  aggregate: { totalCases: number; passed: number; failed: number; durationMs: number } | null;
  tests: TestResultLike[];
  /** Newest-first prior-run per-case verdicts (the same shape regression detection uses). */
  priorRuns: PriorRunSummary[];
  /** The defect report filed for THIS run (drafts carry risk/regression metadata). */
  defectReport?: DefectReport | null;
  investigation?: InvestigationSummary | null;
  visualFindings?: VisualFinding[] | null;
  /** Optional ONE-call LLM narrative seam — injectable for tests; defaults to the strict loop when flagged on. */
  narrate?: ((report: AnalystReport) => Promise<string | null>) | null;
}

export interface AnalystReport {
  runId: string;
  generatedAt: string;
  totals: { cases: number; passed: number; failed: number; durationMs: number };
  passRate: number;
  priorPassRate: number | null;
  passRateDelta: number | null;
  durationDeltaMs: number | null;
  regressions: string[];
  newlyPassing: string[];
  intentMismatches: Array<{ title: string; reason: string; confidence: number }>;
  flaky: string[];
  businessRuleViolations: string[];
  visualObservations: Observation[];
  defectSummary: { total: number; bySeverity: Record<string, number>; highestRisk: number };
  riskScore: number;
  recommendation: 'ship' | 'ship-with-caution' | 'block';
  rationale: string[];
  observations: Observation[];
  narrative: string | null;
}

const round1 = (n: number) => Math.round(n * 1000) / 1000;

/** Latest prior verdict for a case title (priorRuns newest-first); null when never seen. */
function latestPriorVerdict(title: string, priorRuns: PriorRunSummary[]): string | null {
  for (const run of priorRuns) {
    const v = run.verdicts?.[title];
    if (v) return String(v).toLowerCase();
  }
  return null;
}

/** Deterministic feature extraction + risk scoring — the analyst's factual core. Pure; never throws. */
export function buildAnalystFeatures(input: AnalystInput): AnalystReport {
  const tests = input.tests ?? [];
  const agg = input.aggregate;
  const totals = {
    cases: agg?.totalCases ?? tests.length,
    passed: agg?.passed ?? tests.filter((t) => t.status === 'passed').length,
    failed: agg?.failed ?? tests.filter((t) => t.status !== 'passed' && t.status !== 'skipped').length,
    durationMs: agg?.durationMs ?? 0,
  };
  const passRate = totals.cases > 0 ? round1(totals.passed / totals.cases) : 0;

  // Prior-run comparison uses the newest prior run that shares at least one case title.
  const titles = tests.map((t) => t.title);
  const comparable = (input.priorRuns ?? []).find((r) => titles.some((t) => r.verdicts?.[t]));
  let priorPassRate: number | null = null;
  if (comparable) {
    const verdicts = Object.values(comparable.verdicts ?? {});
    const priorPassed = verdicts.filter((v) => String(v).toLowerCase() === 'passed').length;
    priorPassRate = verdicts.length ? round1(priorPassed / verdicts.length) : null;
  }

  const regressions = tests
    .filter((t) => t.status !== 'passed' && t.status !== 'skipped' && latestPriorVerdict(t.title, input.priorRuns ?? []) === 'passed')
    .map((t) => t.title);
  const newlyPassing = tests
    .filter((t) => {
      if (t.status !== 'passed') return false;
      const prior = latestPriorVerdict(t.title, input.priorRuns ?? []);
      return prior !== null && prior !== 'passed';
    })
    .map((t) => t.title);

  const investigation = input.investigation ?? null;
  const intentMismatches = (investigation?.suspiciousPasses ?? []).map((sp) => ({ title: sp.title, reason: sp.reason, confidence: sp.confidence }));
  const flaky = (investigation?.findings ?? []).filter((f) => f.flaky).flatMap((f) => f.affectedTests);
  const businessRuleViolations = (investigation?.findings ?? []).flatMap((f) => f.businessRuleViolations ?? []);

  const visualObservations: Observation[] = (input.visualFindings ?? []).map((v) => ({
    statement: `Visual ${v.kind} on "${v.caseTitle}" step ${v.step}: ${v.message}`,
    confidence: v.confidence,
    verifiedBy: ['visual-baseline'],
  }));

  const drafts = input.defectReport?.drafts ?? [];
  const bySeverity: Record<string, number> = {};
  for (const d of drafts) bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1;
  const highestRisk = drafts.reduce((max, d) => Math.max(max, d.metadata?.risk?.score ?? 0), 0);
  const blockingDefects = (bySeverity['Critical'] ?? 0) + (bySeverity['High'] ?? 0);

  // Release-risk score — deterministic, weighted, clamped: failure ratio dominates; blocking defects,
  // regressions and intent mismatches add; pure flake noise is deliberately cheap.
  const failedRatio = totals.cases > 0 ? totals.failed / totals.cases : 1;
  const riskScore = Math.max(0, Math.min(100, Math.round(
    failedRatio * 50
    + Math.min(20, blockingDefects * 10)
    + Math.min(15, regressions.length * 7.5)
    + Math.min(15, intentMismatches.length * 7.5)
    + Math.min(5, flaky.length * 2.5),
  )));

  const recommendation: AnalystReport['recommendation'] =
    riskScore >= 60 ? 'block'
      : riskScore >= 25 || regressions.length > 0 || intentMismatches.length > 0 ? 'ship-with-caution'
        : 'ship';

  const rationale: string[] = [
    `${totals.passed}/${totals.cases} case(s) passed (${Math.round(passRate * 100)}%)${priorPassRate !== null ? `, prior run ${Math.round(priorPassRate * 100)}%` : ''}.`,
    ...(regressions.length ? [`${regressions.length} regression(s): previously passing case(s) now fail — ${regressions.slice(0, 3).join('; ')}.`] : []),
    ...(intentMismatches.length ? [`${intentMismatches.length} suspicious PASS(es): assertions passed but the intent was not satisfied.`] : []),
    ...(businessRuleViolations.length ? [`${businessRuleViolations.length} business-rule violation(s) found on stored records.`] : []),
    ...(flaky.length ? [`${flaky.length} failure(s) demoted to flaky by the re-run probe (timing, not product).`] : []),
    ...(visualObservations.length ? [`${visualObservations.length} visual drift observation(s) vs the baseline (report-only).`] : []),
    ...(blockingDefects ? [`${blockingDefects} High/Critical defect(s) filed; highest defect risk ${highestRisk}/100.`] : []),
  ];

  const observations: Observation[] = [
    ...(investigation?.findings ?? []).flatMap((f) => f.observations.slice(0, 3)),
    ...(investigation?.suspiciousPasses ?? []).flatMap((sp) => sp.observations.slice(0, 2)),
    ...visualObservations,
  ].slice(0, 30);

  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    totals,
    passRate,
    priorPassRate,
    passRateDelta: priorPassRate !== null ? round1(passRate - priorPassRate) : null,
    durationDeltaMs: null, // prior aggregate durations are not persisted per-run yet; wired when they are
    regressions,
    newlyPassing,
    intentMismatches,
    flaky: Array.from(new Set(flaky)),
    businessRuleViolations,
    visualObservations,
    defectSummary: { total: drafts.length, bySeverity, highestRisk },
    riskScore,
    recommendation,
    rationale,
    observations,
    narrative: null,
  };
}

const narrativeSchema = z.object({ narrative: z.string().min(1).max(2000) });

/** Default ONE-call LLM narrative over the deterministic features (never invents numbers). */
async function defaultNarrate(report: AnalystReport): Promise<string | null> {
  const facts = {
    totals: report.totals, passRate: report.passRate, priorPassRate: report.priorPassRate,
    regressions: report.regressions, intentMismatches: report.intentMismatches.map((i) => i.title),
    flaky: report.flaky, businessRuleViolations: report.businessRuleViolations.slice(0, 10),
    visualFindings: report.visualObservations.length, defects: report.defectSummary,
    riskScore: report.riskScore, recommendation: report.recommendation,
  };
  const result = await generateStrictObject<{ narrative: string }, { narrative: string }>({
    node: 'analyst',
    agent: 'defectTriage',
    schema: narrativeSchema,
    schemaName: 'analyst_narrative',
    system: `${systemPromptFor('defectTriage')}\n--- RELEASE INTELLIGENCE NARRATIVE ---\nWrite a short executive release assessment (3-6 sentences) STRICTLY from the facts JSON you receive. Never invent numbers, names, or causes not present in the facts. State the recommendation and the top reasons. Return ONLY the JSON object.`,
    prompt: `FACTS:\n${JSON.stringify(facts)}`,
    validate: (wire) => {
      const r = narrativeSchema.safeParse(wire);
      return r.success ? { value: r.data, issues: [] } : { value: null, issues: r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`) };
    },
  });
  return result.value?.narrative ?? null;
}

/** Deterministic features + optional bounded LLM narrative. Never throws. */
export async function buildAnalystReport(input: AnalystInput): Promise<AnalystReport> {
  const report = buildAnalystFeatures(input);
  try {
    const narrate = input.narrate ?? (isAnalystEnabled() ? defaultNarrate : null);
    if (narrate) report.narrative = await narrate(report);
  } catch { /* narrative is garnish — the deterministic report stands */ }
  return report;
}
