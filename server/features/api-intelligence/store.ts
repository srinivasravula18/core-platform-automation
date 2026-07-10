/**
 * API Intelligence persistence (Phase A). Run envelopes + regression baselines live in the JSON store
 * (db.apiRuns / db.apiBaselines), mirroring the agentRuns pattern. Normalized PostgreSQL intelligence
 * tables arrive in Phase B+. Best-effort persistence; never throws for normal inputs.
 */
import { db, persistDataInBackground } from '../../shared/storage';
import type { ApiBaseline, ApiRun } from './types';

function uid(): string {
  return `api-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export function createApiRun(input: {
  projectId?: string;
  appId?: string;
  ownerId?: string;
  targetUrl: string;
  environment?: string;
  mode?: 'single' | 'flow';
  writeEnabled?: boolean;
}): ApiRun {
  const now = new Date().toISOString();
  const run: ApiRun = {
    id: uid(),
    projectId: input.projectId,
    appId: input.appId,
    ownerId: input.ownerId,
    targetUrl: input.targetUrl,
    environment: input.environment || 'unknown',
    mode: input.mode || 'single',
    writeEnabled: Boolean(input.writeEnabled),
    status: 'running',
    messages: [],
    endpoints: [],
    scenarios: [],
    executions: [],
    findings: [],
    api_evidence: [],
    created_at: now,
    updated_at: now,
  };
  db.apiRuns.unshift(run);
  if (db.apiRuns.length > 200) db.apiRuns.length = 200; // bound the in-memory store
  persistDataInBackground('api run created');
  return run;
}

export function getApiRun(id: string): ApiRun | null {
  return db.apiRuns.find((r: ApiRun) => r.id === id) || null;
}

export function listApiRuns(scope?: { projectId?: string; appId?: string }): ApiRun[] {
  let runs = db.apiRuns as ApiRun[];
  if (scope?.projectId) runs = runs.filter((r) => !r.projectId || r.projectId === scope.projectId);
  if (scope?.appId) runs = runs.filter((r) => !r.appId || r.appId === scope.appId);
  return runs.slice(0, 100);
}

export function saveApiRun(run: ApiRun): void {
  run.updated_at = new Date().toISOString();
  persistDataInBackground('api run updated');
}

// --------------------------------------------------------------- regression baselines
export function getBaseline(key: string, environment: string): ApiBaseline | null {
  return db.apiBaselines.find((b: ApiBaseline) => b.key === key && b.environment === environment) || null;
}

export function upsertBaseline(baseline: ApiBaseline): void {
  const idx = db.apiBaselines.findIndex((b: ApiBaseline) => b.key === baseline.key && b.environment === baseline.environment);
  if (idx >= 0) db.apiBaselines[idx] = baseline;
  else db.apiBaselines.push(baseline);
  persistDataInBackground('api baseline upserted');
}
