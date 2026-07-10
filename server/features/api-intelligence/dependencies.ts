/**
 * Dependency inference (Phase B) — DETERMINISTIC. Discovers execution-order edges between endpoints:
 *  - produces_token / requires_auth: an auth endpoint (login/token) feeds every auth-required endpoint.
 *  - data_dep: an endpoint whose response yields an id feeds endpoints that take that id as a path param.
 * No LLM. Edges are confidence-scored and stored in the graph; the planner/flows consume them.
 */
import { db, persistDataInBackground } from '../../shared/storage';
import { endpointRowId } from './graph';
import type { ApiEndpoint, ApiRun } from './types';

const g = () => db.apiGraph as Record<string, any[]>;

const AUTH_PATH_RE = /login|auth|token|session|sign[-_]?in/i;

export interface DependencyEdge {
  fromRowId: string;
  toRowId: string;
  kind: 'produces_token' | 'requires_auth' | 'data_dep';
  confidence: number;
  fieldMap?: Record<string, string>;
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/** True if this endpoint looks like it authenticates (a POST to a login/token path). */
function isAuthProducer(ep: ApiEndpoint): boolean {
  return ep.method === 'POST' && AUTH_PATH_RE.test(ep.path);
}

export function inferDependencies(run: ApiRun): DependencyEdge[] {
  const endpoints = run.endpoints;
  const rowId = (ep: ApiEndpoint) => endpointRowId(run.projectId, run.appId, ep.method, ep.path);
  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();
  const add = (e: DependencyEdge) => {
    const k = `${e.fromRowId}|${e.toRowId}|${e.kind}`;
    if (seen.has(k) || e.fromRowId === e.toRowId) return;
    seen.add(k);
    edges.push(e);
  };

  const authProducers = endpoints.filter(isAuthProducer);
  for (const producer of authProducers) {
    for (const ep of endpoints) {
      if (ep === producer) continue;
      if (ep.contract.auth.required) {
        add({ fromRowId: rowId(producer), toRowId: rowId(ep), kind: 'requires_auth', confidence: 0.9 });
      }
    }
  }

  // data_dep: an endpoint that returns a collection/object (typically a create/list) → endpoints taking
  // a matching path param. Heuristic: a producer whose path is a prefix of a consumer that adds a {param}.
  for (const producer of endpoints) {
    const producesId = producer.method === 'POST' || producer.method === 'GET';
    if (!producesId) continue;
    for (const consumer of endpoints) {
      if (consumer === producer) continue;
      const params = pathParamNames(consumer.path);
      if (!params.length) continue;
      const producerBase = producer.path.replace(/\{[^}]+\}/g, '').replace(/\/+$/, '');
      const consumerBase = consumer.path.replace(/\/\{[^}]+\}$/, '');
      if (producerBase && consumerBase && producerBase === consumerBase) {
        add({ fromRowId: rowId(producer), toRowId: rowId(consumer), kind: 'data_dep', confidence: 0.6, fieldMap: { [params[0]]: 'id' } });
      }
    }
  }

  return edges;
}

/** Persist inferred edges into the graph (idempotent by from|to|kind). */
export function storeDependencies(edges: DependencyEdge[]): void {
  for (const e of edges) {
    const idx = g().dependencies.findIndex((x) => x.fromRowId === e.fromRowId && x.toRowId === e.toRowId && x.kind === e.kind);
    if (idx >= 0) g().dependencies[idx] = e;
    else g().dependencies.push(e);
  }
  persistDataInBackground('api dependencies stored');
}

/** Topological-ish ordering: auth producers first, then endpoints by inbound dependency count. */
export function dependencyOrder(run: ApiRun): string[] {
  const rowId = (ep: ApiEndpoint) => endpointRowId(run.projectId, run.appId, ep.method, ep.path);
  const edges = g().dependencies;
  const inbound = new Map<string, number>();
  for (const ep of run.endpoints) inbound.set(rowId(ep), 0);
  for (const e of edges) inbound.set(e.toRowId, (inbound.get(e.toRowId) || 0) + 1);
  return run.endpoints
    .map(rowId)
    .sort((a, b) => (inbound.get(a) || 0) - (inbound.get(b) || 0));
}
