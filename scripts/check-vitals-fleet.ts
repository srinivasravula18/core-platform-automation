// What the Fleet page can see through the configured connection: the meta.* registry lives beside
// the obs.* telemetry, so a URL that reaches one may or may not reach the other.
import 'dotenv/config';
import { config } from 'dotenv';
import { closeVitalsPool, vitalsQuery } from '../server/features/vitals/db';

config({ path: '.env.local', override: true });

const main = async () => {
  const schemas = await vitalsQuery<{ schema_name: string }>(
    `select schema_name from information_schema.schemata where schema_name in ('obs','meta') order by 1`,
  );
  console.log('schemas present:', schemas.map((r) => r.schema_name).join(', ') || '(none)');

  const tables = await vitalsQuery<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'meta' order by 1`,
  );
  console.log('meta tables:', tables.map((r) => r.table_name).join(', ') || '(none)');

  for (const t of ['sandbox_server', 'sandbox_environment', 'sandbox_cohort', 'sandbox_operation']) {
    try {
      const [row] = await vitalsQuery<{ c: number }>(`select count(*)::int as c from meta.${t}`);
      console.log(`  meta.${t}: ${row.c} rows`);
    } catch (e) {
      console.log(`  meta.${t}: ${(e as Error).message}`);
    }
  }

  try {
    const rows = await vitalsQuery<{ name: string; server: string | null; hostname: string | null; service_port: number | null; running: boolean; last_seen: string | null }>(
      `select name, server, hostname, service_port, running, last_seen::text from meta.sandbox_environment order by name limit 10`,
    );
    console.log('sandboxes:', rows.length ? '' : '(none)');
    for (const r of rows) {
      const age = r.last_seen ? Math.round((Date.now() - new Date(r.last_seen).getTime()) / 1000) : null;
      console.log(`  ${r.name} · server=${r.server ?? r.hostname ?? '?'} · port=${r.service_port ?? '-'} · running=${r.running} · heartbeat ${age === null ? 'never' : age + 's ago'}`);
    }
  } catch (e) {
    console.log('sandbox_environment unreadable:', (e as Error).message);
  }
};

main().catch((e) => { console.error('ERR', e.message); process.exitCode = 1; }).finally(() => closeVitalsPool());
