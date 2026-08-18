/**
 * Connection to the observability store.
 *
 * Vitals reads the `obs` schema of the monitored product's database directly — the same thing that
 * product's own console does — so there is no endpoint to reach and no operator session to hold.
 * Its own pool, never the app's: a heavy dashboard query must not starve Test Flow AI's requests.
 *
 * Configured with VITALS_DATABASE_URL (or VITALS_DB_HOST/PORT/USER/PASSWORD/NAME). Nothing is
 * defaulted to a particular product — an unconfigured install says so rather than guessing.
 */

import { Pool, type PoolConfig, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

export class VitalsNotConfiguredError extends Error {
  constructor(
    message = 'Vitals is not configured. Set VITALS_DATABASE_URL to the database holding the observability (obs) schema, then restart the backend.',
  ) {
    super(message);
  }
}

/** Read lazily: dotenv runs after module imports, so a load-time read would miss .env.local. */
function connectionConfig(): PoolConfig | null {
  const url = process.env.VITALS_DATABASE_URL?.trim();
  if (url) return { connectionString: url };
  const host = process.env.VITALS_DB_HOST?.trim();
  const database = process.env.VITALS_DB_NAME?.trim();
  const user = process.env.VITALS_DB_USER?.trim();
  if (!host || !database || !user) return null;
  return {
    host,
    database,
    user,
    port: Number(process.env.VITALS_DB_PORT ?? 5432),
    password: process.env.VITALS_DB_PASSWORD ?? '',
  };
}

export function isConfigured(): boolean {
  return connectionConfig() !== null;
}

function getPool(): Pool {
  if (pool) return pool;
  const config = connectionConfig();
  if (!config) throw new VitalsNotConfiguredError();
  pool = new Pool({ ...config, max: Number(process.env.VITALS_DB_POOL_MAX ?? 6), idleTimeoutMillis: 30_000 });
  pool.on('error', (error) => console.error('[vitals] idle client error:', error.message));
  return pool;
}

export async function vitalsQuery<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, params as never[]);
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

/** What the console shows instead of nine empty pages when the store cannot be read. */
export async function status(): Promise<VitalsStatus> {
  if (!isConfigured()) {
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
    const [info] = await vitalsQuery<{ database: string; schema_present: boolean }>(
      `select current_database() as database,
              exists (select 1 from information_schema.schemata where schema_name = 'obs') as schema_present`,
    );
    if (!info?.schema_present) {
      return {
        configured: true,
        reachable: true,
        message: `Connected to "${info?.database}", but it has no obs schema — point VITALS_DATABASE_URL at the database the monitored product writes telemetry to.`,
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

export async function closeVitalsPool(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.end();
}
