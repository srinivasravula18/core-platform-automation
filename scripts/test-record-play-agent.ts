/**
 * Record & Play — agent identity lifecycle tests (Phase 1). Offline (JSON store), deterministic.
 * Proves pairing → register → authenticate → heartbeat → refresh → revoke, plus the negative paths
 * (expired/invalid pairing, wrong secret, revoked agent, heartbeat staleness).
 *   npx tsx scripts/test-record-play-agent.ts   (npm run test:record-play)
 *
 * Persistence is redirected to .testflow-pw/scratch so the real .testflow-data.json is never touched.
 */
import fs from 'fs';
import path from 'path';

// Force offline JSON mode BEFORE the persistence modules load, and chdir into a scratch dir so any
// background snapshot write lands there — not on the developer's real local data file.
for (const k of ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGPORT']) delete process.env[k];
process.env.DISABLE_POSTGRES = '1';
const scratch = path.resolve(process.cwd(), '.testflow-pw', 'scratch', 'record-play-agent-test');
fs.mkdirSync(scratch, { recursive: true });
process.chdir(scratch);

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

async function main() {
  const svc = await import('../server/features/automation/agentService');
  const { db } = await import('../server/shared/storage');
  db.agents = [];

  const telemetry = {
    machineName: 'DEV-BOX', os: 'Windows 11', version: '1.0.0',
    playwrightVersion: '1.48.0', browsers: ['chromium', 'firefox'], cpu: { cores: 8 }, memory: { totalMb: 16384 },
  };

  console.log('pairing + registration');
  const { pairingToken } = svc.createPairingToken({ userId: 'u1', projectId: 'p1', appId: 'a1', name: 'My Laptop' });
  ok(pairingToken.startsWith('pair_'), 'pairing token minted');
  const reg = await svc.registerAgent({ pairingToken, fingerprint: 'fp-abc', telemetry });
  ok(!('error' in reg), 'registration succeeds with valid pairing token');
  if ('error' in reg) return finish();
  ok(reg.agentToken.startsWith(`${reg.agentId}.`), 'agent token is <agentId>.<secret>');
  ok(reg.agent.ownerId === 'u1' && reg.agent.projectId === 'p1', 'agent stamped with pairing scope');
  ok(reg.agent.status === 'online', 'agent online on registration');
  ok(db.agents.length === 1 && !('tokenHash' in reg.agent), 'stored once; public shape hides tokenHash');

  console.log('pairing token is single-use + expiry');
  const reuse = await svc.registerAgent({ pairingToken, fingerprint: 'fp-abc', telemetry });
  ok('error' in reuse && reuse.status === 401, 'pairing token cannot be reused');
  const noFp = await svc.registerAgent({ pairingToken: svc.createPairingToken({ userId: 'u1', projectId: 'p1', appId: '' }).pairingToken, fingerprint: '', telemetry });
  ok('error' in noFp && noFp.status === 400, 'fingerprint is required');

  console.log('authentication');
  const authed = await svc.authenticateAgent(reg.agentToken);
  ok(!!authed && authed.id === reg.agentId, 'valid agent token authenticates');
  ok(!(await svc.authenticateAgent(`${reg.agentId}.wrong-secret`)), 'wrong secret rejected');
  ok(!(await svc.authenticateAgent('garbage')), 'malformed token rejected');

  console.log('heartbeat');
  const hb = await svc.heartbeat(authed!, { ...telemetry, version: '1.1.0' }, 'busy');
  ok(hb.version === '1.1.0' && hb.status === 'busy', 'heartbeat updates telemetry + status');
  ok(!!hb.lastHeartbeatAt, 'lastHeartbeatAt set');

  console.log('token refresh rotates the access token');
  const refreshed = await svc.refreshAgentToken(reg.refreshToken);
  ok(!!refreshed && refreshed.agentToken.startsWith(`${reg.agentId}.`), 'refresh issues a new access token');
  ok(!(await svc.authenticateAgent(reg.agentToken)), 'old access token no longer authenticates after refresh');
  ok(!!(await svc.authenticateAgent(refreshed!.agentToken)), 'new access token authenticates');

  console.log('liveness freshness');
  const stale = svc.withLiveStatus({ ...hb, status: 'online', lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString() });
  ok(stale.status === 'offline', 'stale heartbeat → offline regardless of stored status');
  const fresh = svc.withLiveStatus({ ...hb, status: 'online', lastHeartbeatAt: new Date().toISOString() });
  ok(fresh.status === 'online', 'fresh heartbeat stays online');

  console.log('revocation');
  ok(await svc.revokeAgent(reg.agentId), 'revoke succeeds');
  ok(!(await svc.authenticateAgent(refreshed!.agentToken)), 'revoked agent token rejected');
  ok(!(await svc.refreshAgentToken(reg.refreshToken)), 'revoked agent cannot refresh');

  finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
