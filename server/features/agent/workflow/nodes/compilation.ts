/**
 * Compilation node — fourth node of the workflow (Phase 4): deterministic coverage→risk→ground→compile→validate.
 *
 * ZERO LLM calls. It only composes existing deterministic machinery: coveragePlanFromCases (compiler/
 * coveragePlan.ts) classifies reviewed cases, prioritizeCoverage (graph/riskAnalysis.ts) scores them, and each
 * authored TestPlan is compiled by the PlaywrightCompiler — whose every locator comes from the Grounding
 * Engine over the grounding node's in-memory EvidenceGraph + VerifiedSelector registry — then gated by
 * validateCompiledOutput. Anything ungrounded becomes an explicit diagnostic (never a guess), and the distinct
 * unresolved/ambiguous targets are returned as `rediscoveryTargets` so the graph can run TARGETED rediscovery
 * (plan Section 10.5: TARGET_UNRESOLVED → 2 attempts).
 *
 * Fully synchronous like grounding.ts (no browser/model/network work); errors are returned, never thrown.
 */
import { createHash } from 'crypto';
import type { MissionContext } from '../../mission/missionContext';
import type { VerifiedSelector } from '../../pipelineDelta';
import type { EvidenceGraph } from '../../graph/evidenceGraph';
import { prioritizeCoverage, type RiskScore } from '../../graph/riskAnalysis';
import { coveragePlanFromCases, type CoveragePlan } from '../../compiler/coveragePlan';
import { playwrightCompiler } from '../../compiler/playwrightCompiler';
import { validateCompiledOutput } from '../../compiler/validateCompiledOutput';
import type { TestPlan } from '../../compiler/testPlan';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, type WorkflowError } from '../errors';
import type { CompilationDiagnostic, CompiledScriptRef, WorkflowCase, WorkflowCompilation } from '../state';

/** Stamped into WorkflowCompilation.compilerVersion — bump when the emitted-spec shape changes. */
export const COMPILER_VERSION = `${playwrightCompiler.name}@2`;

export interface RunCompilationNodeInput {
  /** Frozen execution-scope authority — the compiler embeds it as the spec's MISSION constant. */
  mission: MissionContext;
  /** Reviewed/approved cases (WorkflowState.cases) — coverage/risk classify these, plans compile per case. */
  cases: WorkflowCase[];
  /** Authored semantic plans keyed by case id — full in-memory plans, not state's planRefs. */
  plansByCase: Record<string, TestPlan>;
  /** Grounding node's in-memory graph (RunGroundingNodeResult.evidenceGraph) — never read back from state. */
  evidenceGraph: EvidenceGraph;
  /** Grounding node's registry projection — re-read at resolve time so the registry stays authoritative. */
  verifiedSelectors: VerifiedSelector[];
  /** Backend object schema(s) from the artifact stash — threaded to the compiler for API-conformant test data. */
  objectSchema?: import('../../testdata/types').ObjectSchema[];
}

export interface RunCompilationNodeResult {
  /** Written to WorkflowState.coveragePlan — null when there are no cases to classify. */
  coveragePlan: CoveragePlan | null;
  /** Written to WorkflowState.riskScores — highest-risk coverage first, deterministic tie-break. */
  riskScores: RiskScore[];
  /** Bounded, checkpoint-safe — the ONLY compile output written into WorkflowState.compilation. */
  compilation: WorkflowCompilation;
  /** Full emitted specs keyed by case id, for same-process execution (Phase 5) — NEVER checkpointed. */
  compiledSources: Record<string, string>;
  /** Distinct unresolved/ambiguous semantic targets — drives targeted rediscovery (max 2 attempts). */
  rediscoveryTargets: string[];
  errors: WorkflowError[];
}

/** Same inline sha1 idiom as grounding.ts — state stores this digest of the source, never the source. */
function digestOfSource(code: string): string {
  return createHash('sha1').update(code).digest('hex');
}

/** LangGraph node: deterministic coverage→risk→ground→compile→validate over authored plans — no LLM anywhere. */
export function runCompilationNode(input: RunCompilationNodeInput): RunCompilationNodeResult {
  try {
    // Coverage + risk run over the reviewed cases so the pass records WHAT it covers and in what priority.
    // Use module.id (not .name) so the value threaded to riskAnalysis matches the module id the object
    // repository stores — the compiled-generation path already uses .id; this aligns the two producers.
    const coveragePlan = input.cases.length ? coveragePlanFromCases(input.cases, input.mission.module?.id) : null;
    const riskScores = coveragePlan
      ? prioritizeCoverage(coveragePlan.items, { platform: input.mission.platform, application: input.mission.application?.name ?? null })
      : [];

    // Minimal run-shaped wrapper — the same composition grounding.ts uses; the registry stays the locator authority.
    const run = { selector_registry: { verified_selectors: input.verifiedSelectors } };

    const scripts: CompiledScriptRef[] = [];
    const diagnostics: CompilationDiagnostic[] = [];
    const compiledSources: Record<string, string> = {};
    const rediscovery = new Set<string>();

    for (const testCase of input.cases) {
      const plan = input.plansByCase[testCase.id];
      if (!plan) {
        // A case without an authored plan is surfaced explicitly, never silently skipped.
        diagnostics.push({ caseId: testCase.id, kind: 'EMPTY_PLAN', message: 'No authored test plan for this case.' });
        continue;
      }
      const result = playwrightCompiler.compile({ mission: input.mission, plan: { ...plan, title: testCase.title }, evidenceGraph: input.evidenceGraph, run, objectSchema: input.objectSchema });
      for (const d of result.diagnostics) {
        // Compiler DiagnosticKind is exactly CompilationDiagnostic.kind — mapped 1:1, tagged with the case id.
        diagnostics.push({ caseId: testCase.id, kind: d.kind, message: d.message, target: d.target });
        if ((d.kind === 'AMBIGUOUS_SELECTOR' || d.kind === 'UNRESOLVED_SELECTOR') && d.target) rediscovery.add(d.target);
      }
      // Scripts are only for clean compiles; the diagnostics above already tell this case's story.
      if (!result.ok) continue;
      const gate = validateCompiledOutput(result.code);
      if (!gate.ok) {
        // A spec failing the static gate must never reach execution — surfaced as INVALID_STEP (closest kind).
        for (const v of gate.violations) {
          diagnostics.push({ caseId: testCase.id, kind: 'INVALID_STEP', message: `Validation gate ${v.rule} (line ${v.line}): ${v.message}` });
        }
        continue;
      }
      scripts.push({ caseId: testCase.id, scriptRef: `compiled:${playwrightCompiler.name}:${testCase.id}`, digest: digestOfSource(result.code), ok: true });
      compiledSources[testCase.id] = result.code;
    }

    const rediscoveryTargets = Array.from(rediscovery);
    const errors: WorkflowError[] = [];
    // Only a blocking error when NOTHING compiled. With usable scripts present, unresolved targets stay
    // reported as diagnostics and the run proceeds to evidence instead of looping back to rediscovery.
    if (rediscoveryTargets.length > 0 && scripts.length === 0) {
      // Returned (never thrown) so the graph routes to targeted rediscovery per the Section 10.5 retry table.
      errors.push(new WorkflowRuntimeError(
        WORKFLOW_ERROR_CLASSES.TARGET_UNRESOLVED,
        `${rediscoveryTargets.length} compile target(s) could not be uniquely grounded: ${rediscoveryTargets.join(', ')}`,
        { targets: rediscoveryTargets },
        'compilation',
      ).toWorkflowError());
    }

    return {
      coveragePlan,
      riskScores,
      compilation: { scripts, diagnostics, compilerVersion: COMPILER_VERSION },
      compiledSources,
      rediscoveryTargets,
      errors,
    };
  } catch (error) {
    // Deterministic composition should never throw — anything caught is a bug; classify + fail safe like grounding.ts.
    const err = new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
      error instanceof Error ? error.message : 'Compilation node failed.',
      undefined,
      'compilation',
    );
    return {
      coveragePlan: null,
      riskScores: [],
      compilation: { scripts: [], diagnostics: [], compilerVersion: null },
      compiledSources: {},
      rediscoveryTargets: [],
      errors: [err.toWorkflowError()],
    };
  }
}
