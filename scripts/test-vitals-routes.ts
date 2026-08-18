// Smoke test: the vitals routes mount and report a clear, typed state when the observability store
// is not configured (no VITALS_DATABASE_URL) rather than failing opaquely.
import express from 'express';
import { registerVitalsRoutes } from '../server/features/vitals/routes';

delete process.env.VITALS_DATABASE_URL;
delete process.env.VITALS_DB_HOST;

const app = express();
app.use(express.json());
registerVitalsRoutes(app);

const server = app.listen(0, async () => {
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}/api/vitals`;
  let failures = 0;
  const check = (name: string, ok: boolean, detail: unknown) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
    if (!ok) failures++;
  };

  const status = await fetch(`${base}/status`).then((r) => r.json());
  check('status reports unconfigured', status.configured === false && !!status.message, status);

  const overview = await fetch(`${base}/overview`);
  const overviewBody = await overview.json();
  check('reads refuse without a store', overview.status === 503 && overviewBody.error === 'vitals_not_configured', {
    status: overview.status,
    body: overviewBody,
  });

  const badQuery = await fetch(`${base}/metrics/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets: [] }),
  });
  check('an invalid metric query is rejected', badQuery.status === 400, { status: badQuery.status });

  process.exitCode = failures ? 1 : 0;
  server.close();
});
