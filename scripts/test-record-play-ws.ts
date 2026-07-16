/**
 * Record & Play — WebSocket gateway integration test (real http.Server + ws client). Offline.
 *   npx tsx scripts/test-record-play-ws.ts   (npm run test:record-play-ws)
 *
 * Proves the outbound-agent contract: authenticated upgrade, connection registry, cloud→agent frame
 * dispatch, and rejection of bad/absent tokens. Uses an ephemeral port; no real browser/Playwright.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import express from 'express';

for (const k of ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGPORT']) delete process.env[k];
process.env.DISABLE_POSTGRES = '1';
process.env.REMOTE_AGENT_V1 = '1';
const scratch = path.resolve(process.cwd(), '.testflow-pw', 'scratch', 'record-play-ws-test');
fs.mkdirSync(scratch, { recursive: true });
process.chdir(scratch);

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { WebSocket } = await import('ws');
  const svc = await import('../server/features/automation/agentService');
  const gateway = await import('../server/features/automation/agentGateway');
  const { db } = await import('../server/shared/storage');
  db.agents = [];

  const { pairingToken } = svc.createPairingToken({ userId: 'u1', projectId: 'p1', appId: 'a1' });
  const reg = await svc.registerAgent({ pairingToken, fingerprint: 'fp-1', telemetry: { machineName: 'DEV' } });
  if ('error' in reg) { console.error('registration failed'); process.exit(1); }

  const app = express();
  const server = http.createServer(app);
  gateway.attachAutomationGateway(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const url = `ws://127.0.0.1:${port}/api/automation/agent-ws`;

  console.log('rejects connection without a token');
  const noAuth = new WebSocket(url);
  const noAuthErr = await new Promise<boolean>((resolve) => {
    noAuth.on('open', () => resolve(false));
    noAuth.on('error', () => resolve(true));
    noAuth.on('unexpected-response', () => resolve(true));
  });
  ok(noAuthErr, 'unauthenticated upgrade rejected');

  console.log('accepts a valid agent token');
  const client = new WebSocket(url, { headers: { Authorization: `Bearer ${reg.agentToken}` } });
  const opened = await new Promise<boolean>((resolve) => {
    client.on('open', () => resolve(true));
    client.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  ok(opened, 'authenticated upgrade accepted');
  await wait(100);
  ok(gateway.isAgentConnected(reg.agentId), 'gateway registered the live connection');

  console.log('cloud → agent frame dispatch');
  const received = new Promise<any>((resolve) => client.on('message', (m) => resolve(JSON.parse(String(m)))));
  const sent = gateway.dispatchToAgent(reg.agentId, { type: 'job.dispatch', payload: { jobId: 'J-1', script: 'noop' } });
  ok(sent, 'dispatchToAgent reported delivery');
  const frame = await Promise.race([received, wait(2000).then(() => null)]);
  ok(!!frame && frame.type === 'job.dispatch' && frame.payload.jobId === 'J-1', 'agent received the dispatched frame');

  console.log('dispatch to an unknown agent fails gracefully');
  ok(gateway.dispatchToAgent('nope', { type: 'cancel', payload: {} }) === false, 'dispatch to offline agent returns false');

  console.log('disconnect clears the registry');
  client.close();
  await wait(200);
  ok(!gateway.isAgentConnected(reg.agentId), 'connection removed after close');

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
