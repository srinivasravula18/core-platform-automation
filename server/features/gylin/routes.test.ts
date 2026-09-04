import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { assertGylinConfiguration } from './auth';
import { gylinRunRequestSchema } from './contract';
import { registerGylinRoutes } from './routes';
import { GylinServiceError, projectTerminalRun, runGylinRequest } from './service';

const token = '0123456789abcdef0123456789abcdef';
const request = {
  storyId: 'US-123',
  candidateCommit: '0123456789abcdef0123456789abcdef01234567',
  applicationUrl: 'https://app.example.test',
  acceptanceCriteria: [{ id: 'AC-1', description: 'Checkout succeeds.' }],
  idempotencyKey: 'US-123:sha:intensive-test',
};

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const previousEnabled = process.env.GYLIN_INTEGRATION_ENABLED;
  const previousToken = process.env.GYLIN_INTEGRATION_TOKEN;
  process.env.GYLIN_INTEGRATION_ENABLED = 'true';
  process.env.GYLIN_INTEGRATION_TOKEN = token;
  const app = express();
  registerGylinRoutes(app, async (input) => ({ status: 'passed', runId: 'tf-1', summary: input.storyId, candidateCommit: input.candidateCommit, applicationUrl: input.applicationUrl, url: '/reports?runId=tf-1' }));
  app.use(express.json());
  app.use('/api', (_req, res) => res.status(401).json({ error: 'Human authentication required' }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousEnabled === undefined) delete process.env.GYLIN_INTEGRATION_ENABLED; else process.env.GYLIN_INTEGRATION_ENABLED = previousEnabled;
    if (previousToken === undefined) delete process.env.GYLIN_INTEGRATION_TOKEN; else process.env.GYLIN_INTEGRATION_TOKEN = previousToken;
  }
}

test('route authenticates before parsing and the service token does not authorize human APIs', async () => {
  await withServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/gylin/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${baseUrl}/api/gylin/runs`, { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), await missing.json());
    const accepted = await fetch(`${baseUrl}/api/gylin/runs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json() as any).runId, 'tf-1');
    const human = await fetch(`${baseUrl}/api/agent/start`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(human.status, 401);
  });
});

test('contract rejects unknown fields, unsafe URLs, and invalid candidate digests', () => {
  assert.equal(gylinRunRequestSchema.safeParse({ ...request, extra: true }).success, false);
  assert.equal(gylinRunRequestSchema.safeParse({ ...request, applicationUrl: 'https://user:pass@app.example.test' }).success, false);
  assert.equal(gylinRunRequestSchema.safeParse({ ...request, applicationUrl: 'https://app.example.test/#secret' }).success, false);
  assert.equal(gylinRunRequestSchema.safeParse({ ...request, candidateCommit: 'main' }).success, false);
});

test('production contract requires HTTPS', () => {
  const previous = process.env.DEPLOYMENT_MODE;
  process.env.DEPLOYMENT_MODE = 'production';
  try { assert.equal(gylinRunRequestSchema.safeParse({ ...request, applicationUrl: 'http://app.example.test' }).success, false); }
  finally { if (previous === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = previous; }
});

test('service resolves configured scope, starts one existing graph run, and returns an evidence-backed pass', async () => {
  const starts: any[] = [];
  const order: string[] = [];
  let resourceId = '';
  const receipt = {
    idempotencyKey: 'hashed-key', status: 'running' as const, operation: 'gylin.run', requestHash: 'request-hash',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_000_000).toISOString(),
  };
  const response = await runGylinRequest(request, {
    apps: () => [{ id: 'app-1', projectId: 'project-1', name: 'App', slug: 'app', baseUrl: request.applicationUrl, createdAt: '', updatedAt: '' }],
    project: () => ({ id: 'project-1', name: 'Project', slug: 'project', repoKind: 'remote', syncStatus: 'ready', ownerId: 'owner-1', createdAt: '', updatedAt: '' }),
    credentials: () => ({ source: 'website-default', websiteId: 'site-1', userId: 'user-1', websiteName: 'App', role: 'tester', username: 'user', password: 'secret' }),
    beginReceipt: async () => ({ acquired: true, receipt, requestHash: 'request-hash' }),
    setResource: async (_key, id) => { order.push('receipt'); resourceId = id; },
    startRun: async (input) => { order.push('run'); starts.push(input); return input.runId; },
    getRun: async (id) => ({
      id, status: 'completed', integrationMetadata: { candidateCommit: request.candidateCommit },
      execution_result: { total: 1, passed: 1, failed: 0, tests: [{ title: 'Checkout', status: 'passed' }] },
      evidence_screenshots: [{ title: 'Checkout', screenshotUrl: '/evidence/final.png' }],
    }),
    completeReceipt: async (_key, value) => ({ ...receipt, status: 'completed', response: value }),
    uuid: () => 'run-1',
  } as any);
  assert.equal(response.status, 'passed');
  assert.equal(response.runId, 'tf-run-1');
  assert.equal(resourceId, 'tf-run-1');
  assert.equal(starts.length, 1);
  assert.deepEqual(order, ['receipt', 'run']);
  assert.equal(starts[0].reviewPolicy, 'auto');
  assert.equal(starts[0].executionPolicy, 'auto');
  assert.equal(starts[0].projectId, 'project-1');
  assert.equal(starts[0].appId, 'app-1');
  assert.equal(starts[0].safeMetadata.integrationMetadata.candidateCommit, request.candidateCommit);
  assert.equal(JSON.stringify(starts[0].safeMetadata).includes('secret'), false);
});

test('idempotency conflicts and evidence-free completions fail closed', async () => {
  await assert.rejects(
    runGylinRequest(request, {
      apps: () => [{ id: 'app-1', projectId: 'project-1', name: 'App', slug: 'app', baseUrl: request.applicationUrl, createdAt: '', updatedAt: '' }],
      project: () => ({ id: 'project-1', name: 'Project', slug: 'project', repoKind: 'remote', syncStatus: 'ready', ownerId: 'owner-1', createdAt: '', updatedAt: '' }),
      credentials: () => ({ source: 'website-default', websiteId: 'site-1', userId: 'user-1', websiteName: 'App', role: 'tester', username: 'user', password: 'secret' }),
      beginReceipt: async () => ({ acquired: false, receipt: { idempotencyKey: 'key', status: 'running', operation: 'gylin.run', requestHash: 'different', createdAt: '', expiresAt: '' }, requestHash: 'new' }),
    } as any),
    (error: any) => error instanceof GylinServiceError && error.status === 409,
  );
  const failed = projectTerminalRun({
    id: 'tf-1', status: 'completed', integrationMetadata: { candidateCommit: request.candidateCommit },
    execution_result: { total: 1, passed: 1, failed: 0, tests: [{ title: 'Checkout', status: 'passed' }] },
    evidence_screenshots: [],
  }, request);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error || '', /evidence-backed pass/);
});

test('unknown and ambiguous targets are rejected before credentials or execution', async () => {
  const baseDeps = {
    project: () => ({ id: 'project-1', name: 'Project', slug: 'project', repoKind: 'remote', syncStatus: 'ready', ownerId: 'owner-1', createdAt: '', updatedAt: '' }),
    credentials: () => { throw new Error('must not resolve'); },
  } as any;
  await assert.rejects(runGylinRequest(request, { ...baseDeps, apps: () => [] }), (error: any) => error instanceof GylinServiceError && error.status === 422);
  const app = { id: 'app-1', projectId: 'project-1', name: 'App', slug: 'app', baseUrl: request.applicationUrl, createdAt: '', updatedAt: '' };
  await assert.rejects(runGylinRequest(request, { ...baseDeps, apps: () => [app, { ...app, id: 'app-2' }] }), (error: any) => error instanceof GylinServiceError && error.status === 409);
});

test('product failures are non-retryable and classified infrastructure failures are retryable', () => {
  const base = { id: 'tf-1', integrationMetadata: { candidateCommit: request.candidateCommit }, evidence_screenshots: [{ screenshotUrl: '/evidence/final.png' }] };
  const product = projectTerminalRun({ ...base, status: 'completed', execution_result: { total: 1, passed: 0, failed: 1, tests: [{ title: 'Checkout', status: 'failed' }] } }, request);
  assert.equal(product.status, 'failed');
  assert.equal(product.retryable, false);
  const infrastructure = projectTerminalRun({ ...base, status: 'failed', workflow_error_classes: [{ errorClass: 'EXECUTION_INFRA_FAILURE', retryable: true }] }, request);
  assert.equal(infrastructure.retryable, true);
});

test('terminal evidence and report references use TESTFLOW_PUBLIC_URL', () => {
  const previous = process.env.TESTFLOW_PUBLIC_URL;
  process.env.TESTFLOW_PUBLIC_URL = 'https://testflow.example.test';
  try {
    const passed = projectTerminalRun({
      id: 'tf-1', status: 'completed', integrationMetadata: { candidateCommit: request.candidateCommit },
      execution_result: { total: 1, passed: 1, failed: 0, tests: [{ title: 'Checkout', status: 'passed' }] },
      evidence_screenshots: [{ title: 'Checkout', screenshotUrl: '/evidence/final.png' }],
    }, request);
    assert.equal(passed.url, 'https://testflow.example.test/reports?runId=tf-1');
    assert.equal(passed.evidence?.[0]?.url, 'https://testflow.example.test/evidence/final.png');
  } finally {
    if (previous === undefined) delete process.env.TESTFLOW_PUBLIC_URL; else process.env.TESTFLOW_PUBLIC_URL = previous;
  }
});

test('production startup rejects a missing public URL', () => {
  const previous = { enabled: process.env.GYLIN_INTEGRATION_ENABLED, token: process.env.GYLIN_INTEGRATION_TOKEN, mode: process.env.DEPLOYMENT_MODE, publicUrl: process.env.TESTFLOW_PUBLIC_URL };
  process.env.GYLIN_INTEGRATION_ENABLED = 'true';
  process.env.GYLIN_INTEGRATION_TOKEN = token;
  process.env.DEPLOYMENT_MODE = 'production';
  delete process.env.TESTFLOW_PUBLIC_URL;
  try { assert.throws(() => assertGylinConfiguration(), /TESTFLOW_PUBLIC_URL/); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = key === 'publicUrl' ? 'TESTFLOW_PUBLIC_URL' : key === 'enabled' ? 'GYLIN_INTEGRATION_ENABLED' : key === 'token' ? 'GYLIN_INTEGRATION_TOKEN' : 'DEPLOYMENT_MODE';
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
  }
});

test('production startup rejects a short service token', () => {
  const previous = { enabled: process.env.GYLIN_INTEGRATION_ENABLED, token: process.env.GYLIN_INTEGRATION_TOKEN, mode: process.env.DEPLOYMENT_MODE, publicUrl: process.env.TESTFLOW_PUBLIC_URL };
  process.env.GYLIN_INTEGRATION_ENABLED = 'true';
  process.env.GYLIN_INTEGRATION_TOKEN = 'short';
  process.env.DEPLOYMENT_MODE = 'production';
  process.env.TESTFLOW_PUBLIC_URL = 'https://testflow.example.test';
  try { assert.throws(() => assertGylinConfiguration(), /32 bytes/); }
  finally {
    const env = { GYLIN_INTEGRATION_ENABLED: previous.enabled, GYLIN_INTEGRATION_TOKEN: previous.token, DEPLOYMENT_MODE: previous.mode, TESTFLOW_PUBLIC_URL: previous.publicUrl };
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('active runs time out without starting a duplicate', async () => {
  let now = 0;
  let starts = 0;
  const receipt = { idempotencyKey: 'key', status: 'running' as const, operation: 'gylin.run', requestHash: 'hash', resourceId: 'tf-existing', createdAt: '', expiresAt: '' };
  await assert.rejects(runGylinRequest(request, {
    apps: () => [{ id: 'app-1', projectId: 'project-1', name: 'App', slug: 'app', baseUrl: request.applicationUrl, createdAt: '', updatedAt: '' }],
    project: () => ({ id: 'project-1', name: 'Project', slug: 'project', repoKind: 'remote', syncStatus: 'ready', ownerId: 'owner-1', createdAt: '', updatedAt: '' }),
    credentials: () => ({ source: 'website-default', websiteId: 'site-1', userId: 'user-1', websiteName: 'App', role: 'tester', username: 'user', password: 'secret' }),
    beginReceipt: async () => ({ acquired: false, receipt, requestHash: 'hash' }),
    startRun: async () => { starts += 1; return 'unexpected'; },
    getRun: async () => ({ id: 'tf-existing', status: 'running' }),
    now: () => now,
    sleep: async (ms) => { now += ms; },
  } as any), (error: any) => error instanceof GylinServiceError && error.status === 503);
  assert.equal(starts, 0);
});
