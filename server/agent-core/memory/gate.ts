/** Recall gate over the memory store — ranks by recency and weight; historical memory never satisfies a live evidence gate. */
import { getMemoryStore, type MemoryRecord, type MemoryScope, type MemoryStore } from './store';

export interface SelectorHealthVerdict {
  selector: string;
  /** True when recent episodic evidence says this selector is unreliable → the caller should avoid it. */
  knownBroken: boolean;
  passes: number;
  failures: number;
  flakes: number;
  /** failures+flakes over total; drives the knownBroken decision. */
  failureRate: number;
  lastOutcome: string | null;
}

export interface MemoryGateOptions {
  /** Minimum episodic samples before a health verdict is trusted (below this → not knownBroken). */
  minSamples?: number;
  /** failureRate at/above which a selector is declared broken. */
  breakThreshold?: number;
}

/** Record a selector's live outcome so future runs can gate on it (episodic write). */
export async function recordSelectorOutcome(
  scope: MemoryScope,
  selector: string,
  outcome: 'pass' | 'fail' | 'flaky',
  opts: { runId?: string | null; feature?: string; store?: MemoryStore } = {},
): Promise<void> {
  const store = opts.store ?? getMemoryStore();
  // Subject = the selector itself (the SAME key recall uses) — this is the anti-inversion discipline.
  await store.write({
    scope, kind: 'episodic', subject: selector, outcome,
    weight: outcome === 'pass' ? 1 : 2, // failures/flakes weigh more so one bad run isn't drowned out
    value: { feature: opts.feature ?? null }, runId: opts.runId ?? null,
  });
}

/** Decide whether a selector is known-unreliable from episodic memory — a BRANCH input, not prompt text. */
export async function selectorHealth(
  scope: MemoryScope,
  selector: string,
  opts: MemoryGateOptions & { store?: MemoryStore } = {},
): Promise<SelectorHealthVerdict> {
  const store = opts.store ?? getMemoryStore();
  const minSamples = opts.minSamples ?? 2;
  const breakThreshold = opts.breakThreshold ?? 0.5;

  const recs = await store.recall({ scope, kind: 'episodic', subject: selector, limit: 50 });
  let passes = 0, failures = 0, flakes = 0;
  for (const r of recs) {
    if (r.outcome === 'pass') passes++;
    else if (r.outcome === 'fail') failures++;
    else if (r.outcome === 'flaky') flakes++;
  }
  const total = passes + failures + flakes;
  const failureRate = total === 0 ? 0 : (failures + flakes) / total;
  const knownBroken = total >= minSamples && failureRate >= breakThreshold;
  return { selector, knownBroken, passes, failures, flakes, failureRate, lastOutcome: recs[0]?.outcome ?? null };
}

/** Convenience branch guard: true → the caller should AVOID this selector and pick an alternative. */
export async function isSelectorKnownBroken(
  scope: MemoryScope, selector: string, opts: MemoryGateOptions & { store?: MemoryStore } = {},
): Promise<boolean> {
  return (await selectorHealth(scope, selector, opts)).knownBroken;
}

/** Record a proven approach for a feature (procedural write). */
export async function recordProvenApproach(
  scope: MemoryScope, feature: string, approach: unknown, opts: { runId?: string | null; store?: MemoryStore } = {},
): Promise<void> {
  const store = opts.store ?? getMemoryStore();
  await store.write({ scope, kind: 'procedural', subject: feature, value: approach, weight: 2, runId: opts.runId ?? null });
}

/** Retrieve the most relevant proven approach for a feature, or null — a branch input for the planner. */
export async function preferredApproach(
  scope: MemoryScope, feature: string, opts: { store?: MemoryStore } = {},
): Promise<MemoryRecord | null> {
  const store = opts.store ?? getMemoryStore();
  const recs = await store.recall({ scope, kind: 'procedural', subject: feature, text: feature, limit: 1 });
  return recs[0] ?? null;
}

/** Relevance-ranked recall for prompt enrichment (bounded, never a firehose) — the non-gating read. */
export async function recallRelevant(
  scope: MemoryScope, text: string, opts: { kind?: 'episodic' | 'semantic' | 'procedural'; limit?: number; store?: MemoryStore } = {},
): Promise<MemoryRecord[]> {
  const store = opts.store ?? getMemoryStore();
  return store.recall({ scope, kind: opts.kind, text, limit: opts.limit ?? 5 });
}
