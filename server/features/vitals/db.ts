/**
 * Connection to the observability store.
 *
 * Vitals reads the `obs` schema of the monitored product's database directly — the same thing that
 * product's own console does — so there is no endpoint to reach and no operator session to hold.
 * Its own pool, never the app's: a heavy dashboard query must not starve Test Flow AI's requests.
 *
 * Where that database lives is resolved by ./connection: a record saved from the Connect page, or
 * VITALS_* environment variables when an install prefers config-as-deployment. Nothing is defaulted
 * to a particular product — an install that cannot find an obs schema says so rather than guessing.
 */

import { Pool, type QueryResultRow } from 'pg';
import { readConnection } from './connection';

let pool: Pool | null = null;
/** The URL the live pool was opened with, so a saved change swaps the pool instead of being ignored. */
let poolUrl: string | null = null;

export class VitalsNotConfiguredError extends Error {
  constructor(
    message = 'Vitals is not connected yet. Open Vitals → Connect and point it at the database that holds the observability (obs) schema.',
  ) {
    super(message);
  }
}

export async function isConfigured(): Promise<boolean> {
  return Boolean((await readConnection()).databaseUrl);
}

async function getPool(): Promise<Pool> {
  const { databaseUrl } = await readConnection();
  if (!databaseUrl) throw new VitalsNotConfiguredError();
  if (pool && poolUrl === databaseUrl) return pool;
  if (pool) await closeVitalsPool();
  pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.VITALS_DB_POOL_MAX ?? 6),
    idleTimeoutMillis: 30_000,
  });
  poolUrl = databaseUrl;
  pool.on('error', (error) => console.error('[vitals] idle client error:', error.message));
  return pool;
}

export async function vitalsQuery<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await (await getPool()).query<T>(text, params as never[]);
  return result.rows;
}

/** First column of the first row as a number — the shape most overview tiles need. */
export async function vitalsScalar(text: string, params: unknown[] = []): Promise<number | null> {
  const rows = await vitalsQuery<{ value: string | null }>(text, params);
  const raw = rows[0]?.value;
  return raw === null || raw === undefined ? null : Number(raw);
}

export type VitalsStatus = {
  configured: boolean;
  reachable: boolean;
  message: string;
  database: string | null;
  schemaPresent: boolean;
  oldestSampleAt: string | null;
  newestSampleAt: string | null;
};

/**
 * The tables every page needs. A database can carry an empty `obs` schema — a half-run migration, or
 * the wrong database entirely — and checking only for the schema reported "Connected." while every
 * query failed with a raw "relation does not exist". Count the tables instead.
 */
const EXPECTED_OBS_TABLES = 8;

const describeMissingStore = (database: string | null, found: number) =>
  found === 0
    ? `Connected to "${database}", but it holds no observability tables. Point Vitals at the database the monitored product writes telemetry to — the one its App Service migrates.`
    : `Connected to "${database}", but its obs schema is incomplete (${found} of ${EXPECTED_OBS_TABLES} expected tables). Run the monitored product's migrations against it, or point Vitals at the database that has them.`;

/** What the console shows instead of nine empty pages when the store cannot be read. */
export async function status(): Promise<VitalsStatus> {
  if (!(await isConfigured())) {
    return {
      configured: false,
      reachable: false,
      message: new VitalsNotConfiguredError().message,
      database: null,
      schemaPresent: false,
      oldestSampleAt: null,
      newestSampleAt: null,
    };
  }
  try {
    const [info] = await vitalsQuery<{ database: string; tables_present: number }>(
      `select current_database() as database,
              (select count(*) from information_schema.tables
                where table_schema = 'obs'
                  and table_name in ('metric_sample_10s','metric_sample_1m','metric_sample_1h','issue','trace','dashboard','annotation','alert_rule'))::int as tables_present`,
    );
    if (!info || info.tables_present < EXPECTED_OBS_TABLES) {
      return {
        configured: true,
        reachable: true,
        message: describeMissingStore(info?.database ?? null, info?.tables_present ?? 0),
        database: info?.database ?? null,
        schemaPresent: false,
        oldestSampleAt: null,
        newestSampleAt: null,
      };
    }
    const [span] = await vitalsQuery<{ oldest: Date | null; newest: Date | null }>(
      `select min(bucket_at) as oldest, max(bucket_at) as newest from obs.metric_sample_1h`,
    );
    return {
      configured: true,
      reachable: true,
      message: 'Connected.',
      database: info.database,
      schemaPresent: true,
      oldestSampleAt: span?.oldest?.toISOString() ?? null,
      newestSampleAt: span?.newest?.toISOString() ?? null,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      message: `Cannot reach the observability database: ${(error as Error).message}`,
      database: null,
      schemaPresent: false,
      oldestSampleAt: null,
      newestSampleAt: null,
    };
  }
}

/**
 * Probe a candidate connection string without disturbing the live pool — what the Connect page's
 * "Test connection" button calls before the operator commits to saving it.
 */
export async function probeDatabase(databaseUrl: string): Promise<VitalsStatus> {
  const probe = new Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 8_000 });
  try {
    const { rows } = await probe.query<{ database: string; tables_present: number }>(
      `select current_database() as database,
              (select count(*) from information_schema.tables
                where table_schema = 'obs'
                  and table_name in ('metric_sample_10s','metric_sample_1m','metric_sample_1h','issue','trace','dashboard','annotation','alert_rule'))::int as tables_present`,
    );
    const info = rows[0];
    if (!info || info.tables_present < EXPECTED_OBS_TABLES) {
      return {
        configured: true,
        reachable: true,
        message: describeMissingStore(info?.database ?? null, info?.tables_present ?? 0),
        database: info?.database ?? null,
        schemaPresent: false,
        oldestSampleAt: null,
        newestSampleAt: null,
      };
    }
    const span = await probe.query<{ oldest: Date | null; newest: Date | null }>(
      `select min(bucket_at) as oldest, max(bucket_at) as newest from obs.metric_sample_1h`,
    );
    return {
      configured: true,
      reachable: true,
      message: 'Connected.',
      database: info.database,
      schemaPresent: true,
      oldestSampleAt: span.rows[0]?.oldest?.toISOString() ?? null,
      newestSampleAt: span.rows[0]?.newest?.toISOString() ?? null,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      message: (error as Error).message,
      database: null,
      schemaPresent: false,
      oldestSampleAt: null,
      newestSampleAt: null,
    };
  } finally {
    await probe.end().catch(() => {});
  }
}

/**
 * A dedicated connection outside the pool, for a session-scoped advisory lock that must outlive any
 * single query. The caller owns it and must call `end()`; a pooled client would hand the lock to
 * whoever checked the connection out next.
 */
export async function openVitalsSession(): Promise<import('pg').Client> {
  const { databaseUrl } = await readConnection();
  if (!databaseUrl) throw new VitalsNotConfiguredError();
  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 8_000 });
  await client.connect();
  return client;
}

export async function closeVitalsPool(): Promise<void> {
  const current = pool;
  pool = null;
  poolUrl = null;
  await current?.end().catch(() => {});
}
