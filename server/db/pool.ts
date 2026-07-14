/**
 * PostgreSQL connection pool.
 *
 * The app reads DATABASE_URL (or the PG_* env vars) and connects lazily. The
 * schema is applied on first connect via `migrate()`.
 *
 * If `DATABASE_URL` is not set, the app falls back to the in-memory JSON
 * store in `server/shared/storage.ts` so development still works without
 * PostgreSQL.
 */

import { Pool, type PoolClient } from 'pg';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

let pool: Pool | null = null;
let schemaApplied = false;

function readEnv(): { connectionString: string } | null {
  if (String(process.env.DISABLE_POSTGRES || '').toLowerCase() === 'true') return null;
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  const host = process.env.PGHOST;
  const port = process.env.PGPORT;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  const database = process.env.PGDATABASE;
  if (host && user && database) {
    return {
      connectionString: `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password || '')}@${host}:${port || '5432'}/${database}`,
    };
  }
  return null;
}

export function isPostgresEnabled(): boolean {
  return readEnv() !== null;
}

/** The resolved connection string (DATABASE_URL or PG_*-assembled), for callers that need the raw string rather than a Pool. */
export function getConnectionString(): string | null {
  return readEnv()?.connectionString ?? null;
}

export function getPool(): Pool {
  if (pool) return pool;
  const env = readEnv();
  if (!env) {
    throw new Error('PostgreSQL is not configured. Set DATABASE_URL or PGHOST/PGUSER/PGDATABASE.');
  }
  pool = new Pool({
    connectionString: env.connectionString,
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    console.error('[pg] pool error:', err);
  });
  return pool;
}

export async function migrate(): Promise<{ applied: boolean; reason?: string }> {
  if (schemaApplied) return { applied: false, reason: 'already applied' };
  const env = readEnv();
  if (!env) return { applied: false, reason: 'not configured' };
  const sql = await fs.readFile(path.resolve(process.cwd(), 'server/db/schema.sql'), 'utf-8');
  const client = await getPool().connect();
  try {
    await client.query(sql);
    schemaApplied = true;
    return { applied: true };
  } finally {
    client.release();
  }
}

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await getPool().query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export { randomUUID };
