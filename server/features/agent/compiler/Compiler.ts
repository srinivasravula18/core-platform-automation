/**
 * Compiler interface (Phase 3) — the backend-agnostic contract. Playwright is the FIRST implementation, not
 * a privileged one: Cypress/Selenium/API/perf/a11y backends implement this same interface and reuse the
 * Grounding Engine. A compiler turns verified evidence + abstract QA intent into an executable artifact; it
 * NEVER invents selectors/URLs/appIds/labels/login — anything it cannot ground becomes a diagnostic.
 */
import type { MissionContext } from '../mission/missionContext';
import type { EvidenceGraph } from '../graph/evidenceGraph';
import type { TestPlan } from './testPlan';

export type DiagnosticKind = 'AMBIGUOUS_SELECTOR' | 'UNRESOLVED_SELECTOR' | 'INVALID_STEP' | 'EMPTY_PLAN' | 'UNRESOLVED_TEMPLATE';

/** Severity separates "this case cannot run" from "this one observation could not be grounded". A BLOCKING
 * diagnostic (an ACTION step whose control can't be grounded, an empty plan) drops the case — the flow is
 * broken. A SKIPPABLE diagnostic (an optional ASSERTION that can't be grounded, an unresolved template in an
 * assert) drops only that step: the case still ships a runnable script for its groundable steps. This is what
 * stops one bad step of eight from deleting an otherwise-good case (the cases→scripts skip). */
export type DiagnosticSeverity = 'blocking' | 'skippable';

export interface Diagnostic {
  kind: DiagnosticKind;
  message: string;
  target?: string;
  stepIndex?: number;
  /** blocking → the case cannot run (drop it); skippable → drop only this step, keep the script. */
  severity: DiagnosticSeverity;
}

export interface CompileInput {
  mission: MissionContext;
  plan: TestPlan;
  evidenceGraph: EvidenceGraph;
  /** The run, so the compiler/grounding can re-read the authoritative Selector Registry (never copies). */
  run?: any;
  /** Backend schema for API-conformant test data. */
  objectSchema?: import('../testdata/types').ObjectSchema[];
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
