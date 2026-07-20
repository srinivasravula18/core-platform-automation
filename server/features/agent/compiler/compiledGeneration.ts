/**
 * Compiled Generation (Phase 5) — the flag-gated seam that replaces "LLM writes Playwright" with
 * "LLM writes a Test Plan → deterministic Compiler writes Playwright". It composes the existing reviewed
 * cases: classify → Coverage Plan, weight → Risk Analysis, author → Test Plan (LLM, injected), compile →
 * Playwright, then enforce the validation gate. Any case whose targets cannot be grounded is reported as a
 * diagnostic (for targeted re-discovery) — never emitted as a guessed script.
 *
 * `generatePlan` is injected so this module stays pure/testable; routes.ts passes the real LLM call, tests
 * pass a deterministic stub. Selectors/URLs/login never originate here — only verified evidence + intent.
 */
import type { MissionContext } from '../mission/missionContext';
import { buildEvidenceGraphFromRun, type EvidenceGraph } from '../graph/evidenceGraph';
import { renderTargetCatalogForPrompt } from './renderCatalogForPrompt';
import { playwrightCompiler } from './playwrightCompiler';
import { validateCompiledOutput } from './validateCompiledOutput';
import { coveragePlanFromCases } from './coveragePlan';
import { prioritizeCoverage } from '../graph/riskAnalysis';
import type { TestPlan } from './testPlan';

export interface CompiledScript { test_case_title: string; filename: string; code: string }
export interface CompiledCaseDiagnostic { caseIndex: number; title: string; kind: string; message: string; target?: string }
export interface CompiledGenResult {
  scripts: CompiledScript[];
  diagnostics: CompiledCaseDiagnostic[];
  /** Risk-ordered coverage (for transparency / the QA Knowledge Graph). */
  coverage: { kind: string; title: string; score: number; caseIndex?: number }[];
  usedCompiler: true;
}

export type PlanGenerator = (args: { testCase: any; caseIndex: number; catalog: string; mission: MissionContext; evidenceGraph: EvidenceGraph }) => Promise<TestPlan | null>;

function slugFilename(title: string, i: number): string {
  const base = String(title || `case-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `case-${i + 1}`;
  return `${base}.spec.ts`;
}

export async function generateCompiledScripts(opts: {
  run: any;
  mission: MissionContext;
  testCases: any[];
  generatePlan: PlanGenerator;
}): Promise<CompiledGenResult> {
  const { run, mission, testCases, generatePlan } = opts;

  // Evidence Graph (built in the registry phase; fall back to building it here). Wraps the Selector Registry.
  const graph: EvidenceGraph = run?.evidence_graph?.nodes
    ? run.evidence_graph
    : buildEvidenceGraphFromRun(run, { platform: mission.platform, application: mission.application?.name ?? null, module: mission.module?.id ?? null });
  const catalog = renderTargetCatalogForPrompt(graph);

  // Coverage Plan → Risk Analysis: process cases highest-risk first (transparent, deterministic).
  const coveragePlan = coveragePlanFromCases(testCases, mission.module?.id);
  const ranked = prioritizeCoverage(coveragePlan.items, { platform: mission.platform, application: mission.application?.name ?? null });

  const scripts: CompiledScript[] = [];
  const diagnostics: CompiledCaseDiagnostic[] = [];
  const usedFilenames = new Set<string>();

  // Plans are independent. Resolve them concurrently, then compile in ranked order so
  // filenames, diagnostics, and output remain deterministic.
  const planned = await Promise.all(ranked.map(async (scored) => {
    const i = scored.item.caseIndex ?? 0;
    const testCase = testCases[i];
    if (!testCase) return { scored, testCase, plan: null, diagnostic: null };
    const title = String(testCase.title || scored.item.title || `Case ${i + 1}`);
    if (String(testCase.type || '').toLowerCase() === 'manual') {
      return { scored, testCase, plan: null, diagnostic: { caseIndex: i, title, kind: 'MANUAL_CASE', message: 'Manual case was not executed as automated proof.' } };
    }
    try {
      const plan = await generatePlan({ testCase, caseIndex: i, catalog, mission, evidenceGraph: graph });
      return { scored, testCase, plan, diagnostic: null };
    } catch (e: any) {
      return { scored, testCase, plan: null, diagnostic: { caseIndex: i, title, kind: 'PLAN_ERROR', message: String(e?.message || e) } };
    }
  }));

  for (const item of planned) {
    const { scored, testCase, plan, diagnostic } = item;
    const i = scored.item.caseIndex ?? 0;
    if (!testCase) continue;
    const title = String(testCase.title || scored.item.title || `Case ${i + 1}`);
    if (diagnostic) { diagnostics.push(diagnostic); continue; }
    if (!plan) { diagnostics.push({ caseIndex: i, title, kind: 'PLAN_MISSING', message: 'Planner returned no valid Test Plan.' }); continue; }
    if (plan.sourceStepCount != null && (plan.mappedSourceSteps?.length || 0) < plan.sourceStepCount) {
      const mapped = new Set(plan.mappedSourceSteps || []);
      const missing = Array.from({ length: plan.sourceStepCount }, (_, index) => index + 1).filter((step) => !mapped.has(step - 1));
      diagnostics.push({ caseIndex: i, title, kind: 'PLAN_INCOMPLETE', message: `Planner could not map source step(s): ${missing.join(', ')}.` });
      continue;
    }

    const compiled = playwrightCompiler.compile({ mission, plan: { ...plan, title }, evidenceGraph: graph, run });
    const gate = validateCompiledOutput(compiled.code);
    if (!compiled.ok) {
      for (const d of compiled.diagnostics) diagnostics.push({ caseIndex: i, title, kind: d.kind, message: d.message, target: d.target });
      continue; // ungrounded → never emit a guessed script
    }
    if (!gate.ok) {
      for (const v of gate.violations) diagnostics.push({ caseIndex: i, title, kind: `GATE_${v.rule}`, message: v.message });
      continue;
    }

    let filename = slugFilename(title, i);
    let n = 2;
    while (usedFilenames.has(filename)) filename = filename.replace(/\.spec\.ts$/, `-${n++}.spec.ts`);
    usedFilenames.add(filename);
    scripts.push({ test_case_title: title, filename, code: compiled.code });
  }

  return {
    scripts,
    diagnostics,
    coverage: ranked.map((r) => ({ kind: r.item.kind, title: r.item.title, score: r.score, caseIndex: r.item.caseIndex })),
    usedCompiler: true,
  };
}

/** Whether the deterministic compiler path is enabled (dark by default; legacy path runs unless set). */
export function aiqaCompilerEnabled(): boolean {
  return process.env.AIQA_COMPILER === '1';
}
