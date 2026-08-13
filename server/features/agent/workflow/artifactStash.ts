/** Run-scoped in-memory artifact stash — transient by design: state carries only refs/digests, so a resumed thread whose stash is gone must route back through rediscovery (the evidence gate / compile INVARIANT diagnostics make that explicit, never silent). */
import { hydrateArtifactsFromRunStore, mirrorArtifactsToRunStore } from '../../../agent-core/runstore/runStoreMirror';
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
  /** Observe-then-assert facts measured during discovery — fed to the case author + critic. */
  behaviorOracle?: import('../behaviorOracle').BehaviorObservation;
  /** Validator-loop output: each failure classified assertion-defect / app-defect / infra. */
  outcomeValidation?: import('../outcomeValidator').OutcomeSummary;
}

const stash = new Map<string, RunArtifacts>();
/** Runs whose durable artifacts have already been pulled back in, so a resume hydrates once. */
const hydrated = new Set<string>();

/** Written per case, so the durable store must receive the ACCUMULATED map, never the latest fragment. */
const PER_CASE_KEYS = ['plansByCase', 'compiledSources'] as const;

function merge(runId: string, partial: RunArtifacts): RunArtifacts {
  const prev = stash.get(runId) ?? {};
  const next: RunArtifacts = {
    ...prev,
    ...partial,
    ...(partial.plansByCase ? { plansByCase: { ...prev.plansByCase, ...partial.plansByCase } } : {}),
    ...(partial.compiledSources ? { compiledSources: { ...prev.compiledSources, ...partial.compiledSources } } : {}),
  };
  stash.set(runId, next);
  return next;
}

/**
 * What to mirror for this write. A per-case key mirrors the merged map: the store overwrites by key, so
 * sending only the fragment would leave a resumed run holding just the last case's plan.
 */
function durablePayload(partial: RunArtifacts, merged: RunArtifacts): Record<string, unknown> {
  const out: Record<string, unknown> = { ...partial };
  for (const key of PER_CASE_KEYS) if (key in partial) out[key] = merged[key];
  return out;
}

/** Shallow-merge the partial into the run's stash; the per-case records merge by key, never clobbering siblings. */
export function stashArtifacts(runId: string, partial: RunArtifacts): void {
  const merged = merge(runId, partial);
  // Write-through to the durable store. Fire-and-forget on the hot path; graph boundaries use the
  // awaited form below, because an artifact that never landed is an artifact a resume cannot recover.
  void mirrorArtifactsToRunStore(runId, durablePayload(partial, merged));
}

/** Stash AND wait for durability. Use at a boundary a resume must be able to restart from. */
export async function stashArtifactsDurable(runId: string, partial: RunArtifacts): Promise<void> {
  const merged = merge(runId, partial);
  await mirrorArtifactsToRunStore(runId, durablePayload(partial, merged));
}

export function readArtifacts(runId: string): RunArtifacts {
  return stash.get(runId) ?? {};
}

/**
 * Read-through for a resuming worker: a fresh process has an empty stash, so pull the run's durable
 * artifacts back in before any node reads them. Idempotent — a warm stash is left untouched.
 */
export async function hydrateRunArtifacts(runId: string): Promise<RunArtifacts> {
  if (hydrated.has(runId)) return readArtifacts(runId);
  hydrated.add(runId);
  const durable = await hydrateArtifactsFromRunStore(runId);
  const keys = Object.keys(durable);
  if (keys.length) {
    // Durable values lose their nominal types crossing JSON; the shapes are the same ones stashed.
    merge(runId, durable as RunArtifacts);
    console.log(`[run-store] rehydrated ${keys.length} artifact group(s) for run ${runId}: ${keys.join(', ')}`);
  }
  return readArtifacts(runId);
}

export function clearArtifacts(runId: string): void {
  stash.delete(runId);
  hydrated.delete(runId);
}
