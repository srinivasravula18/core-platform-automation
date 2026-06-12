#!/usr/bin/env node
/**
 * Test Flow AI — destructive DATA RESET.
 *
 * Wipes all application data so the app starts fresh (it re-seeds the demo data
 * and recreates the admin/mark logins on the next boot):
 *   1. Deletes the JSON persistence files (.testflow-data.json, .testflow-settings.json)
 *      — projects, websites, app users, usage logs, knowledge packs, agent runs, settings.
 *   2. Truncates every table in the Postgres `public` schema (when a DB is configured).
 *
 * Guarded: refuses to run unless RESET_CONFIRM=1. Use scripts/reset-data.sh or
 * scripts/reset-data.bat, which prompt for an explicit "reset" confirmation first.
 */
import { config } from 'dotenv';
import { rm } from 'node:fs/promises';
import path from 'node:path';

config({ path: ['.env.local', '.env'] });

if (process.env.RESET_CONFIRM !== '1') {
  console.error('Refusing to run: set RESET_CONFIRM=1 (use scripts/reset-data.sh or scripts/reset-data.bat, which confirm first).');
  process.exit(1);
}

// Mirror server/db/pool.ts readEnv(): DATABASE_URL wins, else PG_* vars.
function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { PGHOST: host, PGPORT: port, PGUSER: user, PGPASSWORD: password, PGDATABASE: database } = process.env;
  if (host && user && database) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password || '')}@${host}:${port || '5432'}/${database}`;
  }
  return null;
}

const root = process.cwd();

// 1) Remove the JSON persistence files.
for (const f of ['.testflow-data.json', '.testflow-settings.json']) {
  try {
    await rm(path.join(root, f), { force: true });
    console.log(`removed ${f}`);
  } catch (e) {
    console.error(`could not remove ${f}:`, e?.message || e);
  }
}

// 2) Truncate all Postgres tables (when configured).
const conn = connectionString();
if (conn) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: conn });
  try {
    await client.connect();
    const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    if (rows.length) {
      const list = rows.map((r) => `public."${r.tablename}"`).join(', ');
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
      console.log(`truncated ${rows.length} Postgres table(s)`);
    } else {
      console.log('no Postgres tables found to truncate');
    }
  } catch (e) {
    console.error('Postgres reset failed:', e?.message || e);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
} else {
  console.log('DATABASE_URL/PG_* not set — skipped Postgres (JSON files cleared).');
}

console.log('\nData reset complete. Restart the app to re-seed demo data and the admin/mark logins.');
