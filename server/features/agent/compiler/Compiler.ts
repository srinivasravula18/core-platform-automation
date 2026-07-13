/**
 * Compiler interface (Phase 3) — the backend-agnostic contract. Playwright is the FIRST implementation, not
 * a privileged one: Cypress/Selenium/API/perf/a11y backends implement this same interface and reuse the
 * Grounding Engine. A compiler turns verified evidence + abstract QA intent into an executable artifact; it
 * NEVER invents selectors/URLs/appIds/labels/login — anything it cannot ground becomes a diagnostic.
 */
import type { MissionContext } from '../mission/missionContext';
import type { EvidenceGraph } from '../graph/evidenceGraph';
import type { TestPlan } from './testPlan';

export type DiagnosticKind = 'AMBIGUOUS_SELECTOR' | 'UNRESOLVED_SELECTOR' | 'INVALID_STEP' | 'EMPTY_PLAN';

export interface Diagnostic {
  kind: DiagnosticKind;
  message: string;
  target?: string;
  stepIndex?: number;
}

export interface CompileInput {
  mission: MissionContext;
  plan: TestPlan;
  evidenceGraph: EvidenceGraph;
  /** The run, so the compiler/grounding can re-read the authoritative Selector Registry (never copies). */
  run?: any;
}

export interface CompileResult {
  /** The compiled artifact (e.g. a Playwright spec). Empty string when the plan could not be grounded. */
  code: string;
  diagnostics: Diagnostic[];
  /** True iff zero blocking diagnostics — the artifact is safe to execute. */
  ok: boolean;
}

export interface Compiler {
  readonly name: string;
  compile(input: CompileInput): CompileResult;
}
