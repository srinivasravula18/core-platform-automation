/**
 * Shared run store (Phase 5) — durable, process-independent run artifacts for horizontal resume.
 *
 * Today heavy artifacts (evidence graph, plans, compiled sources, metadata map) live only in one
 * process's in-memory `artifactStash` Map, so `reconcileOrphanedRunsOnStartup` can only FAIL an in-flight
 * run after a restart — the run is process-bound. This store keeps the same artifacts keyed by
 * (runId, artifactKey) in Postgres, so a SECOND worker can re-hydrate and resume. Values must be
 * JSON-serializable (the graph/plans/sources already are).
 *
 * Persistence-agnostic: Postgres `agent_run_artifacts` when configured, in-memory otherwise. Additive +
 * gated by AGENT_NATIVE_V1 — the in-process stash stays the default authority until the flag flips, so
 * this changes no current behavior. See runStoreMirror.ts for the opt-in write-through from artifactStash.
 */
import { isPostgresEnabled, query } from '../../db/pool';

export interface RunArtifactStore {
  /** Upsert one artifact for a run. Value must be JSON-serializable. */
  put(runId: string, key: string, value: unknown): Promise<void>;
  /** Read one artifact, or null if absent. */
  get<T = unknown>(runId: string, key: string): Promise<T | null>;
  /** All artifacts for a run, keyed by artifactKey. */
  getAll(runId: string): Promise<Record<string, unknown>>;
  /** True if the run has any stored artifacts (i.e. it is resumable from the shared store). */
  has(runId: string): Promise<boolean>;
  clear(runId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// In-memory store — default when Postgres is not configured (dev + tests; NOT cross-process).
// ---------------------------------------------------------------------------------------------

export class InMemoryRunArtifactStore implements RunArtifactStore {
  private byRun = new Map<string, Map<string, unknown>>();

  async put(runId: string, key: string, value: unknown): Promise<void> {
    // Round-trip through JSON so the in-memory store has the SAME serialization semantics as Postgres
    // (a caller relying on in-memory reference identity would silently break when moved to Postgres).
    const serialized = JSON.parse(JSON.stringify(value ?? null));
    const m = this.byRun.get(runId) ?? new Map<string, unknown>();
    m.set(key, serialized);
    this.byRun.set(runId, m);
  }

  async get<T = unknown>(runId: string, key: string): Promise<T | null> {
    const v = this.byRun.get(runId)?.get(key);
    return (v === undefined ? null : (v as T));
  }

  async getAll(runId: string): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.byRun.get(runId) ?? new Map());
  }

  async has(runId: string): Promise<boolean> {
    return (this.byRun.get(runId)?.size ?? 0) > 0;
  }

  async clear(runId: string): Promise<void> {
    this.byRun.delete(runId);
  }
}

// ---------------------------------------------------------------------------------------------
// Postgres store — durable, shared across processes (the point of Phase 5).
// ---------------------------------------------------------------------------------------------

export class PostgresRunArtifactStore implements RunArtifactStore {
  async put(runId: string, key: string, value: unknown): Promise<void> {
    await query(
      `INSERT INTO agent_run_artifacts (run_id, artifact_key, value, updated_at)
       VALUES ($1,$2,$3::jsonb, now())
       ON CONFLICT (run_id, artifact_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [runId, key, JSON.stringify(value ?? null)],
    );
  }

  async get<T = unknown>(runId: string, key: string): Promise<T | null> {
    const rows = await query<{ value: unknown }>('SELECT value FROM agent_run_artifacts WHERE run_id=$1 AND artifact_key=$2', [runId, key]);
    return rows[0] ? (rows[0].value as T) : null;
  }

  async getAll(runId: string): Promise<Record<string, unknown>> {
    const rows = await query<{ artifact_key: string; value: unknown }>('SELECT artifact_key, value FROM agent_run_artifacts WHERE run_id=$1', [runId]);
    return Object.fromEntries(rows.map((r) => [r.artifact_key, r.value]));
  }

  async has(runId: string): Promise<boolean> {
    const rows = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM agent_run_artifacts WHERE run_id=$1', [runId]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async clear(runId: string): Promise<void> {
    await query('DELETE FROM agent_run_artifacts WHERE run_id=$1', [runId]);
  }
}

let singleton: RunArtifactStore | null = null;

/** The process run-artifact store: Postgres-backed when configured, in-memory otherwise. Injectable (tests). */
export function getRunArtifactStore(): RunArtifactStore {
  if (!singleton) singleton = isPostgresEnabled() ? new PostgresRunArtifactStore() : new InMemoryRunArtifactStore();
  return singleton;
}

export function setRunArtifactStore(store: RunArtifactStore | null): void {
  singleton = store;
}
