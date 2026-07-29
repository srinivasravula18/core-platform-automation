/** Run-scoped in-memory artifact stash — transient by design: state carries only refs/digests, so a resumed thread whose stash is gone must route back through rediscovery (the evidence gate / compile INVARIANT diagnostics make that explicit, never silent). */
import { mirrorArtifactsToRunStore } from '../../../agent-core/runstore/runStoreMirror';
import type { EvidenceGraph } from '../graph/evidenceGraph';
import type { VerifiedSelector } from '../pipelineDelta';
import type { TestPlan } from '../compiler/testPlan';

export interface RunArtifacts {
  evidenceGraph?: EvidenceGraph;
  verifiedSelectors?: VerifiedSelector[];
  /** FULL authored TestPlans keyed by case id — state holds only CasePlanResult refs/digests. */
  plansByCase?: Record<string, TestPlan>;
  /** Full emitted spec sources keyed by case id — state holds only CompiledScriptRef digests. */
  compiledSources?: Record<string, string>;
  /** UI-ready evidence cards (title + served screenshotUrl) — state holds only evidenceRefs strings. */
  evidenceShots?: Array<{ title: string; url: string; screenshotUrl: string; status?: string }>;
  /** Full per-test execution records (status/error/step evidence paths) — the defect-reporter/investigation substrate. */
  executionTests?: import('../../playwright/executionService').TestResult[];
  /** Investigation output (findings + suspicious passes) — merged into defects/analyst at terminal time. */
  investigation?: import('./nodes/investigation').InvestigationSummary;
  /** Visual-regression findings (VISUAL_REGRESSION, report-only) — surfaced as analyst observations. */
  visualFindings?: import('../validation/visualBaseline').VisualFinding[];
  /** Backend object schema(s) for API-acceptance-conformant test data — fetched once at context load. */
  objectSchema?: import('../testdata/types').ObjectSchema[];
  /** FULL app metadata map (objects/fields) — fetched at context load; state holds only a summary digest.
   * RC-0: graph mode previously dropped this after computing the summary, leaving authoring un-grounded. */
  metadataMap?: import('../../../ai/tools/corePlatformData').CorePlatformMetadataMap;
}

const stash = new Map<string, RunArtifacts>();

/** Shallow-merge the partial into the run's stash; the per-case records merge by key, never clobbering siblings. */
export function stashArtifacts(runId: string, partial: RunArtifacts): void {
  const prev = stash.get(runId) ?? {};
  stash.set(runId, {
    ...prev,
    ...partial,
    ...(partial.plansByCase ? { plansByCase: { ...prev.plansByCase, ...partial.plansByCase } } : {}),
    ...(partial.compiledSources ? { compiledSources: { ...prev.compiledSources, ...partial.compiledSources } } : {}),
  });
  // Phase 5: best-effort write-through to the shared run store for horizontal resume. No-op unless
  // AGENT_NATIVE_V1 is on; fire-and-forget so it can never affect the in-process hot path.
  mirrorArtifactsToRunStore(runId, partial as Record<string, unknown>);
}

export function readArtifacts(runId: string): RunArtifacts {
  return stash.get(runId) ?? {};
}

export function clearArtifacts(runId: string): void {
  stash.delete(runId);
}
