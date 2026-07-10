/**
 * Coverage intelligence (Phase F) — a READ MODEL computed on demand over the graph + rollups (small
 * cache to avoid recompute per request). Reports discovered/tested/regression/critical/flow coverage,
 * risk distribution, and untested endpoints.
 */
import { db } from '../../shared/storage';

const g = () => db.apiGraph as Record<string, any[]>;

export interface CoverageReport {
  discovered: number;
  tested: number;
  regression: number;
  criticalTested: number;
  flowTested: number;
  riskDistribution: { Critical: number; High: number; Medium: number; Low: number };
  untested: Array<{ rowId: string; method: string; path: string; tier: string }>;
  computedAt: string;
}

let cache: { key: string; at: number; report: CoverageReport } | null = null;
const TTL_MS = 5000;

export function computeCoverage(scope?: { projectId?: string; appId?: string }): CoverageReport {
  const key = `${scope?.projectId || '_'}:${scope?.appId || '_'}`;
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.report;

  let endpoints = g().endpoints;
  if (scope?.projectId) endpoints = endpoints.filter((e) => !e.projectId || e.projectId === scope.projectId);
  if (scope?.appId) endpoints = endpoints.filter((e) => !e.appId || e.appId === scope.appId);

  const testedRowIds = new Set(g().executions.map((e) => e.endpointRowId));
  const regressionRowIds = new Set(
    (db.apiBaselines as any[]).map((b) => {
      const ep = endpoints.find((e) => `${e.method} ${e.path}` === b.key);
      return ep?.rowId;
    }).filter(Boolean),
  );
  const flowRowIds = new Set(g().flows.flatMap((f: any) => (f.journey || []).map((s: any) => s.endpointRowId)));

  const tested = endpoints.filter((e) => testedRowIds.has(e.rowId));
  const report: CoverageReport = {
    discovered: endpoints.length,
    tested: tested.length,
    regression: endpoints.filter((e) => regressionRowIds.has(e.rowId)).length,
    criticalTested: endpoints.filter((e) => e.riskTier === 'Critical' && testedRowIds.has(e.rowId)).length,
    flowTested: endpoints.filter((e) => flowRowIds.has(e.rowId)).length,
    riskDistribution: {
      Critical: endpoints.filter((e) => e.riskTier === 'Critical').length,
      High: endpoints.filter((e) => e.riskTier === 'High').length,
      Medium: endpoints.filter((e) => e.riskTier === 'Medium').length,
      Low: endpoints.filter((e) => e.riskTier === 'Low').length,
    },
    untested: endpoints.filter((e) => !testedRowIds.has(e.rowId)).map((e) => ({ rowId: e.rowId, method: e.method, path: e.path, tier: e.riskTier })),
    computedAt: new Date().toISOString(),
  };
  cache = { key, at: Date.now(), report };
  return report;
}
