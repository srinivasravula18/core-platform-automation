// Smoke test: the vitals routes mount and report a clear, typed state when nothing is connected —
// no store, no control plane — rather than failing opaquely. Also covers the pure logic that decides
// what a connected install would do: notification routing, dashboard fitting, and secret redaction.
import express from 'express';
import { registerVitalsRoutes } from '../server/features/vitals/routes';
import { invalidateConnection, redactConnection, resolveControlRef, VitalsCredentialMissingError, type VitalsConnection } from '../server/features/vitals/connection';
import { selectContactPoint } from '../server/features/vitals/notifier';
import { BUILTIN_DASHBOARDS, fitToStore } from '../server/features/vitals/builtinDashboards';

// Nothing configured.
delete process.env.VITALS_DATABASE_URL;
delete process.env.VITALS_DB_HOST;
delete process.env.VITALS_DB_NAME;
delete process.env.VITALS_CONTROL_URL;
delete process.env.VITALS_CONTROL_USERNAME;
delete process.env.VITALS_CONTROL_PASSWORD;
invalidateConnection();

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// ---- pure logic, no server needed ----

const connection: VitalsConnection = {
  databaseUrl: 'postgres://someone:hunter2@db.internal:5432/telemetry',
  control: { kind: 'inline', baseUrl: 'https://console.example.com', username: 'operator', password: 'hunter2' },
  alerting: { enabled: true, intervalSeconds: 60, notify: true },
  sloTargetPct: 99.9,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'admin',
  source: { database: 'stored', control: 'stored' },
};
const redacted = JSON.stringify(redactConnection(connection));
check('the connection view never leaks a secret', !redacted.includes('hunter2'), redacted);
check('the connection view still identifies the database', redacted.includes('db.internal') && redacted.includes('/telemetry'), redacted);

// A credential reference must carry no secret of its own, and must say where it points.
const byReference: VitalsConnection = {
  ...connection,
  control: { kind: 'credential', websiteId: 'W-nonexistent', loginId: 'U-1' },
};
const redactedRef = JSON.stringify(redactConnection(byReference));
check('a credential reference stores no password', !redactedRef.includes('hunter2') && !redactedRef.includes('password'), redactedRef);
check('a credential reference reports its mode and target', redactedRef.includes('"mode":"credential"') && redactedRef.includes('W-nonexistent'), redactedRef);
check('a deleted credential is named as such rather than silently empty', redactedRef.includes('(deleted credential)'), redactedRef);

try {
  resolveControlRef({ kind: 'credential', websiteId: 'W-nonexistent' });
  check('resolving a deleted credential fails loudly', false, 'no error thrown');
} catch (error) {
  check('resolving a deleted credential fails loudly', error instanceof VitalsCredentialMissingError, (error as Error).message);
}
check(
  'resolving an inline reference returns it unchanged',
  resolveControlRef({ kind: 'inline', baseUrl: 'https://c.example.com', username: 'u', password: 'p' }).username === 'u',
);

const policies = [
  { id: 'root', parent_id: null, matchers: [], contact_point_id: 'cp-default', sort_order: 0 },
  { id: 'crit', parent_id: 'root', matchers: [{ label: 'severity', value: 'critical' }], contact_point_id: 'cp-pager', sort_order: 0 },
];
check('the deepest matching policy wins', selectContactPoint(policies, { severity: 'critical' }) === 'cp-pager');
check('an unmatched label set falls back to the root', selectContactPoint(policies, { severity: 'info' }) === 'cp-default');
check('an empty tree routes nowhere', selectContactPoint([], { severity: 'critical' }) === null);

const overview = BUILTIN_DASHBOARDS[0];
const fittedNone = fitToStore(overview, new Set<string>());
check('a dashboard whose metrics are absent is not seeded', fittedNone === null);
const fittedSome = fitToStore(overview, new Set(['http.request.duration']));
check('fitting keeps only panels the store can fill', (fittedSome?.model.panels.length ?? 0) > 0 && (fittedSome?.model.panels.length ?? 0) < overview.model.panels.length, {
  kept: fittedSome?.model.panels.length,
  total: overview.model.panels.length,
});
check(
  'fitting never leaves a panel with no targets',
  (fittedSome?.model.panels ?? []).every((panel) => panel.targets.length > 0),
);

// ---- routes ----

const app = express();
app.use(express.json());
registerVitalsRoutes(app);

const server = app.listen(0, async () => {
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/vitals`;

  const status = await fetch(`${base}/status`).then((r) => r.json());
  check('status reports unconfigured', status.configured === false && !!status.message, status);

  const overviewResponse = await fetch(`${base}/overview`);
  const overviewBody = await overviewResponse.json();
  check('reads refuse without a store', overviewResponse.status === 503 && overviewBody.error === 'vitals_not_configured', {
    status: overviewResponse.status,
    body: overviewBody,
  });

  const badQuery = await fetch(`${base}/metrics/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets: [] }),
  });
  check('an invalid metric query is rejected', badQuery.status === 400, { status: badQuery.status });

  // Starting a run without a control plane is a setup state, not a crash.
  const start = await fetch(`${base}/tests/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: 'anything', params: {} }),
  });
  const startBody = await start.json();
  check('starting a run without a control plane is refused with a reason', start.status === 503 && startBody.error === 'vitals_control_not_configured', {
    status: start.status,
    body: startBody,
  });

  const profiles = await fetch(`${base}/tests/profiles`);
  check('the profile catalogue needs a store too', profiles.status === 503, { status: profiles.status });

  const control = await fetch(`${base}/tests/control`).then((r) => r.json());
  check('control status reports unconfigured rather than failing', control.configured === false && !!control.message, control);

  const agent = await fetch(`${base}/agent/capabilities`).then((r) => r.json());
  check('the agent reports it has no store to read', agent.storeConnected === false && !!agent.message, agent);

  const agentAsk = await fetch(`${base}/agent/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'how is the platform doing?' }),
  });
  check('the agent refuses to answer without a store', agentAsk.status === 503, { status: agentAsk.status });

  process.exitCode = failures ? 1 : 0;
  server.close();
});
