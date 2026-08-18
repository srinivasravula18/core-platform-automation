// Reports whether VITALS_DATABASE_URL points at a reachable database that holds the obs schema.
import 'dotenv/config';
import { config } from 'dotenv';
import { Client } from 'pg';

config({ path: '.env.local', override: true });

const main = async () => {
  const url = process.env.VITALS_DATABASE_URL;
  console.log('VITALS_DATABASE_URL:', url ? url.replace(/:[^:@]*@/, ':***@') : '(unset)');
  if (!url) return;
  const client = new Client({ connectionString: url });
  await client.connect();
  const schema = await client.query("select 1 from information_schema.schemata where schema_name = 'obs'");
  console.log('obs schema present:', (schema.rowCount ?? 0) > 0);
  if (schema.rowCount) {
    const tables = await client.query("select table_name from information_schema.tables where table_schema='obs' order by 1");
    console.log('obs tables:', tables.rows.map((r) => r.table_name).join(', '));
    // Selftest rows must never survive a run of scripts/test-vitals-connected.ts.
    for (const t of ['alert_rule', 'contact_point', 'notification_policy', 'silence']) {
      const c = await client.query(`select count(*)::int as c from obs.${t} where id like 'test-%'`);
      console.log(`  ${t}: ${c.rows[0].c} leftover selftest rows`);
    }
    for (const t of ['metric_sample_1h', 'metric_sample_1m', 'issue', 'trace', 'test_run']) {
      try {
        const c = await client.query(`select count(*)::int as c from obs.${t}`);
        console.log(`  ${t}: ${c.rows[0].c} rows`);
      } catch (e) { console.log(`  ${t}: ${(e as Error).message}`); }
    }
  }
  await client.end();
};

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
