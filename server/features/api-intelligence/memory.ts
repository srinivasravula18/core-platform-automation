/**
 * QA Memory (Phase F) — a RECALL service over the normalized graph tables (no separate store, no vector
 * index). Assembles prior knowledge for a new run so the platform "reuses knowledge in future runs":
 * latest contract + versions, last-good baseline, flaky flags, recent failures, prior report summaries.
 */
import { db } from '../../shared/storage';
import { endpointRowId } from './graph';
import type { ApiRun } from './types';

const g = () => db.apiGraph as Record<string, any[]>;

export interface ApiMemory {
  endpointRowId: string;
  latestContractHash: string | null;
  contractVersionCount: number;
  lastGoodBaseline: any | null;
  flaky: { isFlaky: boolean; likelyReason: string } | null;
  recentFailures: number;
  priorReportSummaries: string[];
}

/** Recall memory for one endpoint (used to enrich planning/validation context in AI phases). */
export function recallForEndpoint(endpointRowIdVal: string, environment = 'unknown'): ApiMemory {
  const versions = g().contractVersions.filter((v) => v.endpointRowId === endpointRowIdVal).sort((a, b) => a.version - b.version);
  const flaky = (g().flakyFlags as any[]).find((f) => f.endpointRowId === endpointRowIdVal) || null;
  const recentFailures = g().executions.filter((e) => e.endpointRowId === endpointRowIdVal && (e.status === 'fail' || e.status === 'error')).length;
  const ep = g().endpoints.find((e) => e.rowId === endpointRowIdVal);
  const baseline = (db.apiBaselines as any[]).find((b) => ep && b.key === `${ep.method} ${ep.path}` && b.environment === environment) || null;
  return {
    endpointRowId: endpointRowIdVal,
    latestContractHash: versions.length ? versions[versions.length - 1].contractHash : ep?.contractHash || null,
    contractVersionCount: versions.length,
    lastGoodBaseline: baseline,
    flaky: flaky ? { isFlaky: flaky.isFlaky, likelyReason: flaky.likelyReason } : null,
    recentFailures,
    priorReportSummaries: [],
  };
}

/** Recall memory for a whole run's endpoints — the shape injected into ApiRunContext in AI phases. */
export function recallForRun(run: ApiRun): ApiMemory[] {
  return run.endpoints.map((ep) => recallForEndpoint(endpointRowId(run.projectId, run.appId, ep.method, ep.path), run.environment));
}
