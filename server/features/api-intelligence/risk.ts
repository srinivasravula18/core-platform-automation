/**
 * Risk engine (Phase D) — DETERMINISTIC, transparent, overridable. Scores each endpoint from explicit
 * weighted factors so the score is explainable (never a black box) and users can override it. The score
 * influences planning coverage and regression priority.
 */
import { db, persistDataInBackground } from '../../shared/storage';
import { endpointRowId } from './graph';
import type { ApiEndpoint, ApiRun } from './types';

const g = () => db.apiGraph as Record<string, any[]>;

const FINANCIAL_RE = /pay|payment|invoice|charge|refund|balance|wallet|transfer|withdraw|deposit|order|checkout|billing/i;
const ADMIN_RE = /admin|role|permission|grant|privilege|user|account|auth|security|setting/i;

export interface RiskFactors {
  auth: number; financial: number; admin: number; deleteOp: number; mutation: number; prod: number; deps: number; regression: number;
}
export interface RiskResult { score: number; tier: 'Critical' | 'High' | 'Medium' | 'Low'; factors: RiskFactors }

/** Weighted, transparent scoring. Each factor contributes a bounded number of points; total is clamped 0..100. */
export function scoreEndpoint(ep: ApiEndpoint, ctx: { environment: string; inboundDeps: number; recentFails: number }): RiskResult {
  const factors: RiskFactors = {
    auth: ep.contract.auth.required ? 10 : 0,
    financial: FINANCIAL_RE.test(ep.path) ? 30 : 0,
    admin: ADMIN_RE.test(ep.path) ? 20 : 0,
    deleteOp: ep.method === 'DELETE' ? 20 : 0,
    mutation: ['POST', 'PUT', 'PATCH'].includes(ep.method) ? 10 : 0,
    prod: /prod|production|live/i.test(ctx.environment) ? 15 : 0,
    deps: Math.min(ctx.inboundDeps * 3, 12),
    regression: Math.min(ctx.recentFails * 4, 20),
  };
  const score = Math.max(0, Math.min(100, Object.values(factors).reduce((a, b) => a + b, 0)));
  const tier = score >= 70 ? 'Critical' : score >= 45 ? 'High' : score >= 20 ? 'Medium' : 'Low';
  return { score, tier, factors };
}

/** Score every endpoint in a run and write the result onto its graph endpoint row. */
export function scoreRun(run: ApiRun): Array<{ rowId: string; result: RiskResult }> {
  const out: Array<{ rowId: string; result: RiskResult }> = [];
  for (const ep of run.endpoints) {
    const rowId = endpointRowId(run.projectId, run.appId, ep.method, ep.path);
    const inboundDeps = g().dependencies.filter((d) => d.toRowId === rowId).length;
    const recentFails = g().executions.filter((e) => e.endpointRowId === rowId && (e.status === 'fail' || e.status === 'error')).length;
    const result = scoreEndpoint(ep, { environment: run.environment, inboundDeps, recentFails });
    const row = g().endpoints.find((e) => e.rowId === rowId);
    if (row && !row.riskOverriddenBy) {
      row.riskScore = result.score;
      row.riskTier = result.tier;
      row.riskFactors = result.factors;
    }
    out.push({ rowId, result });
  }
  persistDataInBackground('api risk scored');
  return out;
}

export function overrideRisk(rowId: string, tier: RiskResult['tier'], by: string): boolean {
  const row = g().endpoints.find((e) => e.rowId === rowId);
  if (!row) return false;
  row.riskTier = tier;
  row.riskOverriddenBy = by;
  persistDataInBackground('api risk overridden');
  return true;
}

export function listRisk(scope?: { projectId?: string; appId?: string }): any[] {
  let rows = g().endpoints;
  if (scope?.projectId) rows = rows.filter((e) => !e.projectId || e.projectId === scope.projectId);
  return rows.map((e) => ({ rowId: e.rowId, method: e.method, path: e.path, score: e.riskScore, tier: e.riskTier, factors: e.riskFactors, overridden: !!e.riskOverriddenBy }));
}
