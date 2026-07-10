/**
 * Flow testing (Phase E) — business journeys, not isolated calls. Plans an ordered journey from the
 * dependency graph and executes it statefully: an auth step's token and a create step's returned id are
 * CARRIED into later steps. Write-gated + production-blocked (reuse §write-safety). On completion it runs
 * compensating TEARDOWN (reverse DELETE of created resources) so failed/!idempotent flows don't leak state.
 */
import { db, persistDataInBackground } from '../../shared/storage';
import { endpointRowId } from './graph';
import { dependencyOrder } from './dependencies';
import { isProduction } from './executor';
import { isMutating } from './planner';
import { redactValue, redactHeaders } from './redact';
import type { ApiEndpoint, ApiRun, HttpMethod } from './types';

const g = () => db.apiGraph as Record<string, any[]>;
const AUTH_RE = /login|auth|token|session|sign[-_]?in/i;

export interface FlowStep {
  endpointRowId: string;
  method: HttpMethod;
  path: string;
  /** capture directives: e.g. { token: 'access_token', id: 'id' } read from this step's response body. */
  captures?: Record<string, string>;
  mutating: boolean;
}
export interface ApiFlow {
  id: string;
  projectId?: string;
  appId?: string;
  name: string;
  journey: FlowStep[];
  source: 'ai' | 'deterministic';
  status: string;
  createdAt: string;
}

/** Deterministically plan one coherent journey for the run: auth (if present) → dependency-ordered steps. */
export function planFlow(run: ApiRun): ApiFlow {
  const order = dependencyOrder(run);
  const rowToEp = new Map(run.endpoints.map((e) => [endpointRowId(run.projectId, run.appId, e.method, e.path), e]));
  const journey: FlowStep[] = [];
  for (const rowId of order) {
    const ep = rowToEp.get(rowId);
    if (!ep) continue;
    const captures: Record<string, string> = {};
    if (ep.method === 'POST' && AUTH_RE.test(ep.path)) captures.token = 'access_token';
    if (ep.method === 'POST' && !AUTH_RE.test(ep.path)) captures.id = 'id';
    journey.push({ endpointRowId: rowId, method: ep.method, path: ep.path, captures, mutating: isMutating(ep.method) });
  }
  return {
    id: `flow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    projectId: run.projectId,
    appId: run.appId,
    name: `${run.appId || 'app'} journey (${journey.length} steps)`,
    journey,
    source: 'deterministic',
    status: 'planned',
    createdAt: new Date().toISOString(),
  };
}

export function storeFlow(flow: ApiFlow): void {
  const idx = g().flows.findIndex((f) => f.id === flow.id);
  if (idx >= 0) g().flows[idx] = flow;
  else g().flows.push(flow);
  persistDataInBackground('api flow stored');
}

export interface FlowExecOpts { baseUrl: string; token?: string; environment: string; writeEnabled: boolean; timeoutMs?: number }

/** Execute a flow with token/data carry-over + teardown. Step results are REDACTED before storage. */
export async function executeFlow(flow: ApiFlow, run: ApiRun, opts: FlowExecOpts): Promise<any> {
  const ctx: Record<string, string> = {};
  if (opts.token) ctx.token = opts.token;
  const created: Array<{ path: string; id: string }> = [];
  const stepResults: any[] = [];

  const doStep = async (step: FlowStep, isTeardown = false): Promise<{ ok: boolean; status: number | null }> => {
    // write-safety
    if (isMutating(step.method) && (!opts.writeEnabled || isProduction(opts.environment))) {
      stepResults.push({ path: step.path, method: step.method, skipped: true, reason: isProduction(opts.environment) ? 'production blocked' : 'writes disabled' });
      return { ok: false, status: null };
    }
    let path = step.path.replace(/\{([^}]+)\}/g, (_m, name) => encodeURIComponent(ctx[name] || ctx.id || '1'));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;
    const hasBody = step.method !== 'GET' && step.method !== 'HEAD' && step.method !== 'DELETE';
    if (hasBody) headers['content-type'] = 'application/json';
    try {
      const res = await fetch(`${opts.baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`, {
        method: step.method, headers, body: hasBody ? JSON.stringify({}) : undefined, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      });
      const text = await res.text();
      let body: any = text; try { body = text ? JSON.parse(text) : null; } catch { /* raw */ }
      // captures
      for (const [k, field] of Object.entries(step.captures || {})) {
        const v = body && typeof body === 'object' ? body[field] : undefined;
        if (v != null) ctx[k] = String(v);
      }
      if (!isTeardown && step.method === 'POST' && !AUTH_RE.test(step.path) && ctx.id) {
        created.push({ path: step.path, id: ctx.id });
      }
      stepResults.push({
        path: step.path, method: step.method, status: res.status, ok: res.status < 400,
        response: redactValue(body), reqHeaders: redactHeaders(headers),
      });
      return { ok: res.status < 400, status: res.status };
    } catch (e: any) {
      stepResults.push({ path: step.path, method: step.method, error: e?.message || String(e) });
      return { ok: false, status: null };
    }
  };

  let ok = true;
  for (const step of flow.journey) {
    const r = await doStep(step);
    if (!r.ok && step.mutating) { ok = false; break; } // stop the journey on a failed mutation
  }

  // Compensating teardown: reverse-DELETE created resources (best-effort, write-gated).
  if (opts.writeEnabled && !isProduction(opts.environment)) {
    for (const c of created.reverse()) {
      await doStep({ endpointRowId: '', method: 'DELETE', path: `${c.path}/{id}`, mutating: true }, true);
      ctx.id = c.id;
    }
  }

  const flowRun = { id: `flowrun-${Date.now()}`, flowId: flow.id, runId: run.id, status: ok ? 'passed' : 'failed', stepResults, createdAt: new Date().toISOString() };
  g().flowRuns.push(flowRun);
  persistDataInBackground('api flow run recorded');
  return flowRun;
}

export function listFlows(scope?: { projectId?: string; appId?: string }): ApiFlow[] {
  let flows = g().flows as ApiFlow[];
  if (scope?.projectId) flows = flows.filter((f) => !f.projectId || f.projectId === scope.projectId);
  return flows;
}
