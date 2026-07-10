/**
 * Phase A tests — API Intelligence vertical slice (unit + integration).
 * Convention: standalone tsx script (no jest). Integration test spins a LOCAL mock HTTP server, so it
 * is fully offline and deterministic. Run: npx tsx scripts/test-api-intelligence.ts (npm run test:api).
 */
import http from 'http';
import { redactHeaders, redactValue, redactRequest, REDACTED } from '../server/features/api-intelligence/redact';
import { parseOpenApi, parsePostman, contractHash } from '../server/features/api-intelligence/discovery';
import { planScenariosForEndpoint, isMutating } from '../server/features/api-intelligence/planner';
import { shapeOf, diffShape, makeBaseline, regressionDiff, baselineKey, validateExecution } from '../server/features/api-intelligence/validation';
import { executeScenario, isProduction } from '../server/features/api-intelligence/executor';
import { buildApiEvidence } from '../server/features/api-intelligence/evidence';
import { createApiRun, getBaseline } from '../server/features/api-intelligence/store';
import { runApiIntelligence } from '../server/features/api-intelligence/pipeline';
import { inferDependencies } from '../server/features/api-intelligence/dependencies';
import { listGraphEndpoints, graphAround, evidenceChain, endpointRowId } from '../server/features/api-intelligence/graph';
import { listVersions, diffVersions } from '../server/features/api-intelligence/versioning';
import { scoreEndpoint } from '../server/features/api-intelligence/risk';
import { evaluateFlaky } from '../server/features/api-intelligence/flaky';
import { computeCoverage } from '../server/features/api-intelligence/coverage';
import { getMission } from '../server/features/api-intelligence/mission';
import { listFlaky } from '../server/features/api-intelligence/flaky';
import { db } from '../server/shared/storage';
import type { ApiEndpoint } from '../server/features/api-intelligence/types';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const OPENAPI = {
  openapi: '3.0.0',
  servers: [{ url: '' }],
  security: [{ bearer: [] }],
  paths: {
    '/login': {
      // No auth required to log in; produces a token consumed by the auth-required endpoints.
      post: { operationId: 'login', summary: 'Log in', security: [], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } } },
    },
    '/users': {
      get: { operationId: 'listUsers', summary: 'List users', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array' } } } } } },
      post: { operationId: 'createUser', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '201': { description: 'created' } } },
    },
  },
};

async function main() {
  // ---------------------------------------------------------------- redact
  console.log('redact');
  eq(redactHeaders({ Authorization: 'Bearer x', 'X-Api-Key': 'k', accept: 'json' }), { Authorization: REDACTED, 'X-Api-Key': REDACTED, accept: 'json' }, 'sensitive headers masked');
  eq(redactValue({ password: 'p', nested: { token: 't', keep: 1 } }), { password: REDACTED, nested: { token: REDACTED, keep: 1 } }, 'sensitive body keys masked (deep)');
  ok((redactRequest({ headers: { authorization: 'Bearer x' }, body: { name: 'a', secret: 's' } }).body as any).secret === REDACTED, 'redactRequest masks body secret');
  ok((redactRequest({ headers: { authorization: 'Bearer x' } }).headers as any).authorization === REDACTED, 'redactRequest masks auth header');
  // Evidence redaction: a stored execution carrying sensitive data must be masked in the evidence record.
  const sensEp: any = { id: 'POST /login', method: 'POST', path: '/login', tags: [], baseUrl: '', contract: { request: { params: [], headers: [] }, responses: {}, auth: { required: true } }, contractHash: 'h', source: 'openapi' };
  const sensScen: any = { id: 's', endpointId: sensEp.id, kind: 'positive', title: '', request: {}, expected: { statusOneOf: [200] }, mutating: true };
  const sensExec: any = { scenarioId: 's', endpointId: sensEp.id, request: { method: 'POST', path: '/login', headers: { authorization: 'Bearer LEAK' }, body: { user: 'a', password: 'LEAK' } }, response: { status: 200, headers: {}, body: { token: 'LEAK' } }, latencyMs: 1, status: 'pass' };
  const ev = buildApiEvidence(sensEp, sensScen, sensExec, [], 'staging');
  ok(!JSON.stringify(ev).includes('LEAK'), 'buildApiEvidence masks auth header + password + response token');
  ok(JSON.stringify(ev).includes(REDACTED), 'evidence carries redaction markers when sensitive data is present');

  // ---------------------------------------------------------------- discovery
  console.log('discovery');
  const d = parseOpenApi(OPENAPI, 'http://x');
  eq(d.endpoints.length, 3, 'parseOpenApi finds 3 operations');
  ok(d.endpoints.filter((e) => e.path === '/users').every((e) => e.contract.auth.required), 'global security → /users require auth');
  ok(!d.endpoints.find((e) => e.path === '/login')!.contract.auth.required, 'op-level security:[] overrides global (login is open)');
  ok(d.endpoints.find((e) => e.method === 'POST')!.contract.request.bodySchema !== undefined, 'POST has a request body schema');
  ok(!!contractHash(d.endpoints[0].contract), 'contract hash produced');
  const pm = parsePostman({ item: [{ name: 'Get', request: { method: 'GET', url: { path: ['users'], host: ['api'] }, header: [{ key: 'Authorization', value: 'x' }] } }] }, 'http://x');
  eq(pm.endpoints.length, 1, 'parsePostman finds 1 request');
  ok(pm.endpoints[0].contract.auth.required, 'postman auth header → auth required');

  // ---------------------------------------------------------------- planner
  console.log('planner');
  const ep = d.endpoints.find((e) => e.method === 'GET')!;
  const scen = planScenariosForEndpoint(ep);
  ok(scen.some((s) => s.kind === 'positive'), 'planner emits positive');
  ok(scen.some((s) => s.kind === 'authz'), 'auth endpoint → authz scenario');
  ok(isMutating('POST') && !isMutating('GET'), 'isMutating classifies verbs');

  // ---------------------------------------------------------------- validation + regression
  console.log('validation');
  eq(shapeOf([{ id: 1, name: 'a' }]), ['array', { id: 'number', name: 'string' }], 'shapeOf array-of-objects');
  ok(diffShape({ id: 'number', name: 'string' }, { id: 'number' }).some((x) => x.includes('missing field')), 'diffShape detects missing field');
  ok(diffShape({ id: 'number' }, { id: 'string' }).some((x) => x.includes('type changed')), 'diffShape detects type change');
  const okExec: any = { scenarioId: 's', endpointId: ep.id, request: {} as any, response: { status: 200, headers: {}, body: [{ id: 1, name: 'a' }] }, latencyMs: 5, status: 'pass' };
  eq(validateExecution({ ...scen[0], expected: { statusOneOf: [200] } }, okExec).length, 0, 'valid 200 → no findings');
  const base = makeBaseline(ep, okExec, 'staging');
  eq(regressionDiff(base, ep, scen[0], okExec).length, 0, 'same response → no regression');
  const drift: any = { ...okExec, response: { status: 200, headers: {}, body: [{ id: 1 }] } };
  ok(regressionDiff(base, ep, scen[0], drift).some((f) => f.kind === 'regression'), 'dropped field → regression finding');

  // ---------------------------------------------------------------- write-safety
  console.log('write-safety');
  const postScen = planScenariosForEndpoint(d.endpoints.find((e) => e.method === 'POST')!)[0];
  eq((await executeScenario(postScen, { baseUrl: 'http://127.0.0.1:1', environment: 'staging', writeEnabled: false })).status, 'skipped', 'mutating + writes disabled → skipped');
  eq((await executeScenario(postScen, { baseUrl: 'http://127.0.0.1:1', environment: 'production', writeEnabled: true })).status, 'skipped', 'mutating + production → skipped');
  ok(isProduction('prod-us') && !isProduction('staging'), 'isProduction detects prod');

  // ---------------------------------------------------------------- Phase B–F unit checks
  console.log('phase B: dependencies + graph');
  const runB: any = { id: 'unit', projectId: 'p', appId: 'a', endpoints: parseOpenApi(OPENAPI, 'http://x').endpoints };
  const depEdges = inferDependencies(runB);
  ok(depEdges.some((e) => e.kind === 'requires_auth'), 'login → requires_auth edges to auth endpoints');
  console.log('phase C: versioning');
  eq(diffVersions('nope', 1, 2).changes.length > 0, true, 'diffVersions handles missing versions');
  console.log('phase D: risk + flaky');
  const financialEp: any = { method: 'DELETE', path: '/payments/{id}', tags: [], baseUrl: '', contract: { request: { params: [], headers: [] }, responses: {}, auth: { required: true } }, contractHash: 'h', source: 'openapi' };
  const r = scoreEndpoint(financialEp, { environment: 'production', inboundDeps: 2, recentFails: 0 });
  ok(r.tier === 'Critical', `financial+delete+prod+auth → Critical (got ${r.tier}, score ${r.score})`);
  const lowEp: any = { method: 'GET', path: '/health', tags: [], baseUrl: '', contract: { request: { params: [], headers: [] }, responses: {}, auth: { required: false } }, contractHash: 'h', source: 'openapi' };
  ok(scoreEndpoint(lowEp, { environment: 'staging', inboundDeps: 0, recentFails: 0 }).tier === 'Low', 'GET /health → Low risk');
  eq(evaluateFlaky('no-history').isFlaky, false, 'flaky: insufficient data → not flaky');

  // ---------------------------------------------------------------- INTEGRATION: full pipeline vs a mock API
  console.log('integration (mock server)');
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi.json') return res.end(JSON.stringify(OPENAPI));
    if (req.url?.startsWith('/login') && req.method === 'POST') { res.statusCode = 200; return res.end(JSON.stringify({ access_token: 'flow-token-xyz' })); }
    if (req.url?.startsWith('/users') && req.method === 'GET') {
      if (!auth) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
      res.statusCode = 200; return res.end(JSON.stringify([{ id: 1, name: 'a' }]));
    }
    if (req.url?.startsWith('/users') && req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ id: 2 })); }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base_ = `http://127.0.0.1:${(server.address() as any).port}`;

  try {
    const run = createApiRun({ targetUrl: base_, projectId: 'itp', appId: 'ita', environment: 'staging', writeEnabled: false });
    await runApiIntelligence(run, { token: 'secret-token-123', fetchLive: true });
    eq(run.status, 'completed', 'pipeline completes');
    eq(run.endpoints.length, 3, 'discovered 3 endpoints from mock /openapi.json');
    ok(run.executions.some((e) => e.status === 'pass'), 'at least one execution passed');
    ok(run.executions.some((e) => e.status === 'skipped'), 'POST scenarios skipped (writes disabled)');
    // GET positive (with token) 200, GET authz (no auth) 401 both PASS their expectation.
    const authzExec = run.executions.find((e) => run.scenarios.find((s) => s.id === e.scenarioId)?.kind === 'authz');
    eq(authzExec?.status, 'pass', 'authz scenario: unauthenticated → 401 as expected');
    // Redaction: the bearer token is held in memory only and must NEVER appear in stored evidence.
    ok(!JSON.stringify(run.api_evidence).includes('secret-token-123'), 'token never persisted in evidence (held in memory only)');
    ok(!JSON.stringify(run).includes('secret-token-123'), 'token never persisted anywhere on the run');
    // Baseline created for GET /users in staging.
    ok(!!getBaseline(baselineKey(run.endpoints.find((e) => e.method === 'GET') as ApiEndpoint), 'staging'), 'baseline stored for GET /users');
    ok(!!run.report && run.report.totals.endpoints === 3, 'developer report produced');

    // Second run → baseline exists → regression path runs with no drift.
    const run2 = createApiRun({ targetUrl: base_, projectId: 'itp', appId: 'ita', environment: 'staging', writeEnabled: false });
    await runApiIntelligence(run2, { token: 'secret-token-123', fetchLive: true });
    ok(!run2.findings.some((f) => f.kind === 'regression'), 'second identical run → no regression drift');

    // ---- Phase B: graph populated + traversal ----
    const graphEps = listGraphEndpoints({ projectId: 'itp', appId: 'ita' });
    ok(graphEps.length >= 3, `graph has the discovered endpoints (${graphEps.length})`);
    const getUsersRow = endpointRowId('itp', 'ita', 'GET', '/users');
    ok(graphAround(getUsersRow, 1).nodes.length > 0, 'graphAround returns an ego-graph');
    ok(evidenceChain(getUsersRow).some((n) => n.type === 'endpoint'), 'evidenceChain includes the endpoint');
    ok((db.apiGraph as any).dependencies.some((d: any) => d.kind === 'requires_auth'), 'dependency edges stored (requires_auth)');

    // ---- Phase C: versions + business rules ----
    ok(listVersions(getUsersRow).length >= 1, 'contract version snapshotted for GET /users');
    ok((db.apiGraph as any).businessRules.length > 0, 'business rules harvested');

    // ---- Phase D: risk scored + flaky evaluated ----
    ok(graphEps.every((e: any) => e.riskTier), 'every graph endpoint has a risk tier');
    ok(Array.isArray(listFlaky()), 'flaky list computed');

    // ---- Phase F: coverage + mission ----
    const cov = computeCoverage({ projectId: 'itp', appId: 'ita' });
    ok(cov.discovered >= 3 && cov.tested >= 1, `coverage: discovered ${cov.discovered}, tested ${cov.tested}`);
    const mission = getMission(run.id);
    ok(!!mission && mission.tasks.every((t) => t.state === 'completed' || t.state === 'failed'), 'mission tasks all resolved');

    // ---- Phase E: flow-mode run (writes enabled, staging) with token carry-over + teardown ----
    const flowRun = createApiRun({ targetUrl: base_, projectId: 'itp', appId: 'ita', environment: 'staging', mode: 'flow', writeEnabled: true });
    await runApiIntelligence(flowRun, { fetchLive: true });
    eq(flowRun.status, 'completed', 'flow-mode run completes');
    const flowRuns = (db.apiGraph as any).flowRuns.filter((f: any) => f.runId === flowRun.id);
    ok(flowRuns.length === 1, 'a flow run was recorded');
    const steps = flowRuns[0].stepResults || [];
    ok(steps.some((s: any) => s.path === '/login' && s.status === 200), 'flow executed the login step');
    ok(steps.some((s: any) => s.path === '/users' && s.method === 'POST' && s.status === 201), 'flow created a user (writes enabled, staging)');
    ok(!JSON.stringify(flowRuns[0]).includes('flow-token-xyz'), 'flow token not leaked in stored step results');

    // ---- Phase E write-safety: flow against production blocks mutations ----
    const prodFlow = createApiRun({ targetUrl: base_, projectId: 'itp', appId: 'ita', environment: 'production', mode: 'flow', writeEnabled: true });
    await runApiIntelligence(prodFlow, { fetchLive: true });
    const prodSteps = ((db.apiGraph as any).flowRuns.find((f: any) => f.runId === prodFlow.id)?.stepResults) || [];
    ok(prodSteps.some((s: any) => s.method === 'POST' && s.skipped), 'production flow blocks mutating steps');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  // Set the exit code and let the loop drain; force-exit after a grace period (undici keep-alive
  // sockets otherwise keep the process alive). The unref'd timer never blocks a clean early exit.
  process.exitCode = failed === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 300).unref();
}
main().catch((e) => { console.error('TEST ERROR:', e?.stack || e); process.exitCode = 1; setTimeout(() => process.exit(1), 300).unref(); });
