/**
 * API Knowledge Graph (Phase B). TYPED collections (mirror of the normalized PostgreSQL tables — no
 * polymorphic edges). Deterministic. Upserts endpoints/DTOs/executions/evidence links from a completed
 * run, and exposes bounded ego-graph + evidence-chain traversal. Integrity is by construction: every
 * link references an endpoint rowId; deleting an endpoint's links is a filtered removal.
 */
import { db, persistDataInBackground } from '../../shared/storage';
import type { ApiEndpoint, ApiRun } from './types';

const g = () => db.apiGraph as Record<string, any[]>;

export function endpointRowId(projectId: string | undefined, appId: string | undefined, method: string, path: string): string {
  return `${projectId || '_'}::${appId || '_'}::${method.toUpperCase()} ${path}`;
}

function upsert(coll: any[], match: (r: any) => boolean, value: any): void {
  const idx = coll.findIndex(match);
  if (idx >= 0) coll[idx] = { ...coll[idx], ...value };
  else coll.push(value);
}

/** Promote a completed API run into the graph. Idempotent (keyed by rowId / natural keys). */
export function upsertGraphFromRun(run: ApiRun): void {
  try {
    const now = new Date().toISOString();
    for (const ep of run.endpoints) {
      const rowId = endpointRowId(run.projectId, run.appId, ep.method, ep.path);
      const existing = g().endpoints.find((e) => e.rowId === rowId);
      upsert(g().endpoints, (e) => e.rowId === rowId, {
        rowId,
        projectId: run.projectId || '',
        appId: run.appId || '',
        method: ep.method,
        path: ep.path,
        summary: ep.summary || '',
        tags: ep.tags,
        contractHash: ep.contractHash,
        source: ep.source,
        riskScore: existing?.riskScore ?? 0,
        riskTier: existing?.riskTier ?? 'Low',
        riskFactors: existing?.riskFactors ?? {},
        firstSeen: existing?.firstSeen || now,
        lastSeen: now,
      });
      // DTOs (request + response) as typed nodes + typed links.
      recordDto(run, rowId, 'request', ep.contract.request.bodySchema);
      for (const [code, resp] of Object.entries(ep.contract.responses)) {
        if (resp?.schema) recordDto(run, rowId, 'response', resp.schema, code);
      }
      // Execution history (redacted metadata only) + daily rollup.
      for (const ex of run.executions.filter((x) => x.endpointId === ep.id)) {
        g().executions.push({
          endpointRowId: rowId, runId: run.id, scenarioId: ex.scenarioId,
          status: ex.status, statusCode: ex.response?.status ?? null, latencyMs: ex.latencyMs,
          environment: run.environment, createdAt: now,
        });
        rollup(rowId, ex.status, ex.latencyMs, now);
      }
    }
    // Evidence links (endpoint ↔ evidence) for the Evidence Explorer.
    for (const ev of run.api_evidence) {
      const ep = run.endpoints.find((e) => e.path === ev.endpoint && e.method === ev.method);
      if (!ep) continue;
      const rowId = endpointRowId(run.projectId, run.appId, ep.method, ep.path);
      g().endpointEvidence.push({ endpointRowId: rowId, runId: run.id, evidenceId: ev.scenarioId, kind: 'api' });
    }
    // Bound history growth (retention proxy for the JSON store).
    if (g().executions.length > 5000) g().executions.splice(0, g().executions.length - 5000);
    persistDataInBackground('api graph upserted');
  } catch (e) {
    console.error('[api-intelligence] graph upsert error:', (e as any)?.message || e);
  }
}

function recordDto(run: ApiRun, endpointRowIdVal: string, direction: 'request' | 'response', schema: unknown, code = ''): void {
  if (schema == null) return;
  const name = (schema as any)?.$ref || `${direction}${code ? `-${code}` : ''}`;
  const hash = JSON.stringify(schema).slice(0, 200);
  const dtoRowId = `${run.projectId || '_'}::${run.appId || '_'}::${name}`;
  upsert(g().dtos, (d) => d.rowId === dtoRowId, { rowId: dtoRowId, projectId: run.projectId || '', appId: run.appId || '', name, kind: direction, schema, hash });
  upsert(
    g().endpointDtos,
    (l) => l.endpointRowId === endpointRowIdVal && l.dtoRowId === dtoRowId && l.direction === direction,
    { endpointRowId: endpointRowIdVal, dtoRowId, direction },
  );
}

function rollup(rowId: string, status: string, latencyMs: number, now: string): void {
  const day = now.slice(0, 10);
  const row = g().executionDaily.find((r) => r.endpointRowId === rowId && r.day === day);
  const pass = status === 'pass' ? 1 : 0;
  const fail = status === 'fail' || status === 'error' ? 1 : 0;
  if (row) {
    row.runs += 1; row.passes += pass; row.fails += fail;
    row.p50 = Math.round((row.p50 + latencyMs) / 2); // cheap running estimate (JSON store)
    row.p95 = Math.max(row.p95, latencyMs);
  } else {
    g().executionDaily.push({ endpointRowId: rowId, day, runs: 1, passes: pass, fails: fail, p50: latencyMs, p95: latencyMs });
  }
}

// --------------------------------------------------------------------- typed links (used by later phases)
export function linkEndpointRequirement(endpointRowIdVal: string, requirementId: string): void {
  upsert(g().endpointRequirements, (l) => l.endpointRowId === endpointRowIdVal && l.requirementId === requirementId, { endpointRowId: endpointRowIdVal, requirementId });
  persistDataInBackground('api graph link');
}
export function linkEndpointCase(endpointRowIdVal: string, caseId: string): void {
  upsert(g().endpointCases, (l) => l.endpointRowId === endpointRowIdVal && l.caseId === caseId, { endpointRowId: endpointRowIdVal, caseId });
  persistDataInBackground('api graph link');
}
export function linkEndpointTable(endpointRowIdVal: string, tableName: string, access: 'read' | 'write', confidence = 0.7): void {
  upsert(g().endpointTables, (l) => l.endpointRowId === endpointRowIdVal && l.tableName === tableName && l.access === access, { endpointRowId: endpointRowIdVal, tableName, access, confidence });
  persistDataInBackground('api graph link');
}

// --------------------------------------------------------------------- reads
export function listGraphEndpoints(scope?: { projectId?: string; appId?: string }): any[] {
  let rows = g().endpoints;
  if (scope?.projectId) rows = rows.filter((e) => !e.projectId || e.projectId === scope.projectId);
  if (scope?.appId) rows = rows.filter((e) => !e.appId || e.appId === scope.appId);
  return rows;
}

export function getGraphEndpoint(rowId: string): any | null {
  return g().endpoints.find((e) => e.rowId === rowId) || null;
}

/** Bounded ego-graph: the node + its one-hop typed links, up to `depth` (endpoints reachable via deps). */
export function graphAround(rowId: string, depth = 1): { nodes: any[]; edges: any[] } {
  const nodes: any[] = [];
  const edges: any[] = [];
  const seen = new Set<string>();
  const visit = (id: string, d: number) => {
    if (seen.has(id) || d < 0) return;
    seen.add(id);
    const ep = getGraphEndpoint(id);
    if (ep) nodes.push({ type: 'endpoint', id, label: `${ep.method} ${ep.path}`, riskTier: ep.riskTier });
    // typed one-hop links
    for (const l of g().endpointDtos.filter((x) => x.endpointRowId === id)) {
      const dto = g().dtos.find((x) => x.rowId === l.dtoRowId);
      nodes.push({ type: 'dto', id: l.dtoRowId, label: dto?.name || l.dtoRowId });
      edges.push({ from: id, to: l.dtoRowId, kind: `${l.direction}_dto` });
    }
    for (const l of g().endpointRequirements.filter((x) => x.endpointRowId === id)) { nodes.push({ type: 'requirement', id: l.requirementId, label: l.requirementId }); edges.push({ from: id, to: l.requirementId, kind: 'requirement' }); }
    for (const l of g().endpointCases.filter((x) => x.endpointRowId === id)) { nodes.push({ type: 'case', id: l.caseId, label: l.caseId }); edges.push({ from: id, to: l.caseId, kind: 'covered_by' }); }
    for (const l of g().endpointTables.filter((x) => x.endpointRowId === id)) { nodes.push({ type: 'table', id: l.tableName, label: l.tableName }); edges.push({ from: id, to: l.tableName, kind: `${l.access}_table` }); }
    for (const l of g().endpointEvidence.filter((x) => x.endpointRowId === id)) { nodes.push({ type: 'evidence', id: `${l.runId}:${l.evidenceId}`, label: l.evidenceId }); edges.push({ from: id, to: `${l.runId}:${l.evidenceId}`, kind: 'evidence' }); }
    // dependency hop
    for (const dep of g().dependencies.filter((x) => x.fromRowId === id)) {
      edges.push({ from: id, to: dep.toRowId, kind: `depends:${dep.kind}` });
      visit(dep.toRowId, d - 1);
    }
  };
  visit(rowId, Math.max(0, Math.min(depth, 3)));
  // dedup nodes by id
  const uniq = new Map(nodes.map((n) => [`${n.type}:${n.id}`, n]));
  return { nodes: [...uniq.values()], edges };
}

/** Ordered evidence chain for an endpoint: requirement → table → endpoint → evidence. Lazy/bounded. */
export function evidenceChain(rowId: string): Array<{ type: string; id: string; label: string }> {
  const ep = getGraphEndpoint(rowId);
  if (!ep) return [];
  const chain: Array<{ type: string; id: string; label: string }> = [];
  for (const l of g().endpointRequirements.filter((x) => x.endpointRowId === rowId)) chain.push({ type: 'requirement', id: l.requirementId, label: l.requirementId });
  for (const l of g().endpointFiles.filter((x) => x.endpointRowId === rowId)) chain.push({ type: 'repo', id: l.filePath, label: l.filePath });
  chain.push({ type: 'endpoint', id: rowId, label: `${ep.method} ${ep.path}` });
  for (const l of g().endpointTables.filter((x) => x.endpointRowId === rowId)) chain.push({ type: 'db', id: l.tableName, label: `${l.access} ${l.tableName}` });
  for (const l of g().endpointEvidence.filter((x) => x.endpointRowId === rowId)) chain.push({ type: 'evidence', id: `${l.runId}:${l.evidenceId}`, label: l.evidenceId });
  return chain;
}
