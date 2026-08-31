import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSupervisorTools } from '../../server/ai/supervisor';
import { discoverableTargetOperations } from '../../server/ai/agent-runtime/openapi-tools';
import type { ApiEndpoint } from '../../server/features/api-intelligence/types';
import { buildAgentRuntimeContext } from '../../server/ai/agent-runtime/context-builder';
import { loginPathCandidates } from '../../server/ai/tools/targetMetadata';
import { withEvidence } from '../../server/ai/tools/evidenceEnvelope';
import { acceptGroundedTargetAnswer } from '../../server/ai/agent-runtime/evidence-acceptance';

test('live results preserve payload fields and identify exact scope and completeness', () => {
  const result = withEvidence({ objects: [{ id: 'one' }, { id: 'two' }] }, {
    subject: 'objects', scope: { kind: 'application', id: 'app-1', label: 'CRM' },
    method: 'GET', operation: '/objects', complete: true, total: 2,
  });
  assert.equal(result.objects.length, 2);
  assert.deepEqual(result.evidence.scope, { kind: 'application', id: 'app-1', label: 'CRM' });
  assert.deepEqual(result.evidence.completeness, { complete: true, returned: 2, total: 2 });
});

test('target answers require current-turn evidence and name its scope', () => {
  const ctx = { targetApps: [{ name: 'Any target', baseUrl: 'https://target.example' }] };
  assert.equal(acceptGroundedTargetAnswer({ finalText: 'There are 7.', steps: [], ctx }).ok, false);
  const steps = [{ index: 0, toolCalls: [{ id: '1', name: 'list_objects', arguments: {}, result: withEvidence({ objects: [] }, {
    subject: 'objects', scope: { kind: 'application', id: 'app-1', label: 'CRM' }, method: 'GET', operation: '/objects', complete: true, total: 0,
  }) }] }];
  assert.equal(acceptGroundedTargetAnswer({ finalText: 'There are 7.', steps, ctx }).ok, false);
  assert.equal(acceptGroundedTargetAnswer({ finalText: 'CRM contains 7 objects.', steps, ctx }).ok, true);
});

test('answer scope follows the final evidence subject, not intermediate discovery', () => {
  const ctx = { targetApps: [{ name: 'Any target', baseUrl: 'https://target.example' }] };
  const evidenceCall = (id: string, subject: string, label: string) => ({ id, name: 'read', arguments: {}, result: withEvidence({ items: [] }, {
    subject, scope: { kind: 'application', label }, method: 'GET', operation: '/read', complete: true, total: 0,
  }) });
  const steps = [{ index: 0, toolCalls: [evidenceCall('1', 'applications', 'Admin target')] }, { index: 1, toolCalls: [evidenceCall('2', 'objects', 'CRM')] }];
  assert.equal(acceptGroundedTargetAnswer({ finalText: 'CRM contains 7 objects.', steps, ctx }).ok, true);
});

test('authentication discovery prefers target configuration without product-specific routing', () => {
  assert.deepEqual(loginPathCandidates('/v1/session'), ['/v1/session', '/auth/login', '/api/auth/login']);
});

test('selected targets receive generic read tools without entity-name routing', () => {
  const ctx = buildAgentRuntimeContext({ userMessage: 'anything', role: 'admin', targets: [{ id: 'site', name: 'Any target', baseUrl: 'https://target.example' }] });
  const names = buildSupervisorTools(ctx).map((tool) => tool.spec.name);
  assert.ok(names.includes('list_apps'));
  assert.ok(names.includes('list_objects'));
  assert.ok(names.includes('search_relevant_objects'));
  assert.ok(names.includes('count_records'));
  assert.ok(names.includes('execute_platform_api_write'));
  assert.ok(names.includes('author_core_platform_flow'));
  assert.match(String(buildSupervisorTools(ctx).find((tool) => tool.spec.name === 'prepare_test_scope')?.spec.description), /explicitly asks to test/i);
  assert.equal(names.includes('explore_page'), false);
  assert.equal(names.includes('discover_apps'), false);
  assert.equal(names.includes('create_record'), false);
});

test('load-test scope stays advisory instead of starting the functional generation pipeline', async () => {
  const ctx = buildAgentRuntimeContext({ userMessage: 'Can we run a 100-user stress/load test?', role: 'admin', targets: [] });
  const tool = buildSupervisorTools(ctx).find((candidate) => candidate.spec.name === 'prepare_test_scope');
  const result = await tool?.execute({ scope: 'read-only load test', targetUrl: 'https://target.example' }, ctx) as any;
  assert.equal(result.startReviewedGeneration, false);
});

test('OpenAPI discovery exposes reads and safe staged writes, never destructive or reserved routes', () => {
  const endpoint = (method: ApiEndpoint['method'], path: string): ApiEndpoint => ({ id: `${method}-${path}`, method, path, tags: [], baseUrl: 'https://target.example', contract: { request: { params: [], headers: [] }, responses: {}, auth: { required: true } }, contractHash: 'hash', source: 'openapi' });
  const visible = discoverableTargetOperations([endpoint('GET', '/items'), endpoint('POST', '/flows'), endpoint('PATCH', '/flows/{id}'), endpoint('PUT', '/flows/{id}'), endpoint('DELETE', '/items/{id}'), endpoint('POST', '/auth/login')]);
  assert.deepEqual(visible.map(({ method, path }) => `${method} ${path}`), ['GET /items', 'POST /flows', 'PATCH /flows/{id}']);
});

test('only the server-derived admin role can execute a target mutation', () => {
  const ctx = buildAgentRuntimeContext({ userMessage: 'update it', role: 'tester', targets: [{ id: 'site', name: 'Any target', baseUrl: 'https://target.example' }] });
  assert.equal(buildSupervisorTools(ctx).some((tool) => tool.spec.name === 'execute_platform_api_write'), false);
  assert.equal(buildSupervisorTools(ctx).some((tool) => tool.spec.name === 'author_core_platform_flow'), false);
});
