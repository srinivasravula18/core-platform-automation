/**
 * Flaky detection (Phase D) — DETERMINISTIC statistics over execution history. An endpoint is flaky when
 * the same scenario alternates pass/fail across runs (instability) rather than failing consistently.
 * Cold-start safe: below a minimum sample it reports "insufficient data", never a guess. The AI failure
 * analyst supplies the human "likely reason" later; here we give a deterministic reason heuristic.
 */
import { db, persistDataInBackground } from '../../shared/storage';

const g = () => db.apiGraph as Record<string, any[]>;
const MIN_SAMPLES = 4;

export interface FlakyResult {
  endpointRowId: string;
  isFlaky: boolean;
  confidence: number;
  likelyReason: string;
  sampleWindow: number;
}

/** Evaluate flakiness for one endpoint from its recent per-scenario execution history. */
export function evaluateFlaky(endpointRowId: string, window = 20): FlakyResult {
  const history = g().executions
    .filter((e) => e.endpointRowId === endpointRowId)
    .slice(-window);
  if (history.length < MIN_SAMPLES) {
    return { endpointRowId, isFlaky: false, confidence: 0, likelyReason: 'insufficient data', sampleWindow: history.length };
  }
  // Group by scenario, count pass/fail transitions within each scenario's timeline.
  const byScenario = new Map<string, string[]>();
  for (const e of history) {
    const key = e.scenarioId || 'default';
    const arr = byScenario.get(key) || [];
    arr.push(e.status === 'pass' ? 'P' : e.status === 'skipped' ? 'S' : 'F');
    byScenario.set(key, arr);
  }
  let transitions = 0;
  let mixedScenarios = 0;
  for (const seq of byScenario.values()) {
    const relevant = seq.filter((s) => s !== 'S'); // ignore skips
    if (relevant.length < 2) continue;
    const hasP = relevant.includes('P');
    const hasF = relevant.includes('F');
    if (hasP && hasF) mixedScenarios += 1;
    for (let i = 1; i < relevant.length; i += 1) if (relevant[i] !== relevant[i - 1]) transitions += 1;
  }
  const isFlaky = mixedScenarios > 0 && transitions >= 2;
  const confidence = isFlaky ? Math.min(0.5 + transitions * 0.1, 0.95) : 0;
  const likelyReason = isFlaky
    ? 'Alternating pass/fail for the same scenario across runs — likely a timing/rate-limit, ordering, or shared-state dependency rather than a hard defect.'
    : 'stable';
  return { endpointRowId, isFlaky, confidence, likelyReason, sampleWindow: history.length };
}

/** Evaluate every endpoint touched by a run and persist the flags. */
export function evaluateFlakyForRun(endpointRowIds: string[]): FlakyResult[] {
  const results = endpointRowIds.map((id) => evaluateFlaky(id));
  for (const r of results) {
    const idx = g().flakyFlags.findIndex((f) => f.endpointRowId === r.endpointRowId);
    const row = { ...r, lastEvaluated: new Date().toISOString() };
    if (idx >= 0) g().flakyFlags[idx] = row;
    else g().flakyFlags.push(row);
  }
  persistDataInBackground('api flaky evaluated');
  return results;
}

export function listFlaky(): any[] {
  return g().flakyFlags.filter((f) => f.isFlaky);
}
