/**
 * Blackboard — the typed, append-only, per-run shared reasoning surface (A2A Contract §4.2).
 *
 * Replaces the mutable `run: any` object + `resolveUnderstanding` reconciliation shim: two agents that
 * need the same fact read ONE key instead of re-deriving it and diverging. Every fact is stamped with
 * provenance (who wrote it, when, which message caused it) and an append-only per-run sequence, so the
 * board is an auditable history, never an overwrite.
 *
 * Persistence-agnostic by design: DB-backed (`agent_blackboard`) when Postgres is configured — which is
 * what lets a second worker resume a run in Phase 4 — and an in-memory store otherwise, so dev and unit
 * tests run with no database. Additive + inert: nothing on the live path reads this until an agent is
 * migrated onto it (gated by AGENT_NATIVE_V1), so it cannot change current behavior.
 */
import { isPostgresEnabled, query, uid, withTransaction } from '../../db/pool';

/** Who/when/why a fact was written — carried on every entry so the board stays auditable. */
export interface BlackboardProvenance {
  by: string;
  at: string;
  causationId?: string | null;
}

/** One append-only fact on the board. `kind` is the primary channel (e.g. 'evidence.selectors',
 * 'metadata.objects', 'api.endpoints'); `key` optionally sub-scopes a kind. `seq` is per-run append order. */
export interface BlackboardFact<T = unknown> {
  id: string;
  runId: string;
  seq: number;
  kind: string;
  key: string | null;
  value: T;
  provenance: BlackboardProvenance;
}

export interface PutOptions {
  key?: string | null;
  causationId?: string | null;
  /** ISO timestamp override (tests/determinism); defaults to now. */
  at?: string;
}

/** The blackboard contract — same surface whether backed by Postgres or the in-memory store. */
export interface Blackboard {
  /** Append a typed fact; never overwrites. Returns the stored fact (with its assigned seq/id). */
  put<T>(runId: string, kind: string, value: T, by: string, opts?: PutOptions): Promise<BlackboardFact<T>>;
  /** The most recent fact for a kind (+ optional key), or null if none. */
  latest<T>(runId: string, kind: string, key?: string | null): Promise<BlackboardFact<T> | null>;
  /** All facts for a run, optionally filtered to one kind, in append order. */
  all(runId: string, kind?: string): Promise<BlackboardFact[]>;
  /** Remove all facts for a run (cleanup / test isolation). */
  clear(runId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// In-memory store — the default when Postgres is not configured (dev + unit tests).
// ---------------------------------------------------------------------------------------------

export class InMemoryBlackboard implements Blackboard {
  private facts = new Map<string, BlackboardFact[]>();
  private seq = new Map<string, number>();

  private nextSeq(runId: string): number {
    const n = (this.seq.get(runId) ?? 0) + 1;
    this.seq.set(runId, n);
    return n;
  }

  async put<T>(runId: string, kind: string, value: T, by: string, opts: PutOptions = {}): Promise<BlackboardFact<T>> {
    const fact: BlackboardFact<T> = {
      id: uid('bbf'),
      runId,
      seq: this.nextSeq(runId),
      kind,
      key: opts.key ?? null,
      value,
      provenance: { by, at: opts.at ?? new Date().toISOString(), causationId: opts.causationId ?? null },
    };
    const list = this.facts.get(runId) ?? [];
    list.push(fact);
    this.facts.set(runId, list);
    return fact;
  }

  async latest<T>(runId: string, kind: string, key?: string | null): Promise<BlackboardFact<T> | null> {
    const list = this.facts.get(runId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i];
      if (f.kind === kind && (key === undefined || (f.key ?? null) === (key ?? null))) return f as BlackboardFact<T>;
    }
    return null;
  }

  async all(runId: string, kind?: string): Promise<BlackboardFact[]> {
    const list = this.facts.get(runId) ?? [];
    return (kind ? list.filter((f) => f.kind === kind) : list).slice();
  }

  async clear(runId: string): Promise<void> {
    this.facts.delete(runId);
    this.seq.delete(runId);
  }
}

// ---------------------------------------------------------------------------------------------
// Postgres store — durable, shared across processes (enables Phase 4 horizontal resume).
// ---------------------------------------------------------------------------------------------

interface BlackboardRow {
  id: string;
  run_id: string;
  seq: string | number;
  kind: string;
  sub_key: string | null;
  value: unknown;
  by_agent: string;
  causation_id: string | null;
  created_at: string;
}

function rowToFact(r: BlackboardRow): BlackboardFact {
  return {
    id: r.id,
    runId: r.run_id,
    seq: Number(r.seq),
    kind: r.kind,
    key: r.sub_key,
    value: r.value,
    provenance: { by: r.by_agent, at: new Date(r.created_at).toISOString(), causationId: r.causation_id },
  };
}

export class PostgresBlackboard implements Blackboard {
  async put<T>(runId: string, kind: string, value: T, by: string, opts: PutOptions = {}): Promise<BlackboardFact<T>> {
    const id = uid('bbf');
    // Per-run monotonic seq computed under the row lock so concurrent writers never collide on order.
    const row = await withTransaction(async (client) => {
      const seqRes = await client.query(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_blackboard WHERE run_id = $1',
        [runId],
      );
      const seq = Number(seqRes.rows[0]?.next ?? 1);
      const at = opts.at ?? new Date().toISOString();
      const ins = await client.query(
        `INSERT INTO agent_blackboard (id, run_id, seq, kind, sub_key, value, by_agent, causation_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
        [id, runId, seq, kind, opts.key ?? null, JSON.stringify(value ?? null), by, opts.causationId ?? null, at],
      );
      return ins.rows[0] as BlackboardRow;
    });
    return rowToFact(row) as BlackboardFact<T>;
  }

  async latest<T>(runId: string, kind: string, key?: string | null): Promise<BlackboardFact<T> | null> {
    const rows = key === undefined
      ? await query<BlackboardRow>('SELECT * FROM agent_blackboard WHERE run_id=$1 AND kind=$2 ORDER BY seq DESC LIMIT 1', [runId, kind])
      : await query<BlackboardRow>('SELECT * FROM agent_blackboard WHERE run_id=$1 AND kind=$2 AND sub_key IS NOT DISTINCT FROM $3 ORDER BY seq DESC LIMIT 1', [runId, kind, key ?? null]);
    return rows[0] ? (rowToFact(rows[0]) as BlackboardFact<T>) : null;
  }

  async all(runId: string, kind?: string): Promise<BlackboardFact[]> {
    const rows = kind
      ? await query<BlackboardRow>('SELECT * FROM agent_blackboard WHERE run_id=$1 AND kind=$2 ORDER BY seq ASC', [runId, kind])
      : await query<BlackboardRow>('SELECT * FROM agent_blackboard WHERE run_id=$1 ORDER BY seq ASC', [runId]);
    return rows.map(rowToFact);
  }

  async clear(runId: string): Promise<void> {
    await query('DELETE FROM agent_blackboard WHERE run_id=$1', [runId]);
  }
}

// ---------------------------------------------------------------------------------------------
// Selection — one process-wide instance, chosen by whether Postgres is configured.
// ---------------------------------------------------------------------------------------------

let singleton: Blackboard | null = null;

/** The process blackboard: Postgres-backed when configured, in-memory otherwise. Injectable via setBlackboard (tests). */
export function getBlackboard(): Blackboard {
  if (!singleton) singleton = isPostgresEnabled() ? new PostgresBlackboard() : new InMemoryBlackboard();
  return singleton;
}

/** Test seam — override the process instance (e.g. force in-memory). */
export function setBlackboard(bb: Blackboard | null): void {
  singleton = bb;
}
