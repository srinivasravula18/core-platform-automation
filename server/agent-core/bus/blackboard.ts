/** Blackboard — the typed, append-only per-run fact surface with an acceptance lifecycle. Postgres-backed when configured, in-memory otherwise. */
import { isPostgresEnabled, query, uid, withTransaction } from '../../db/pool';
import { canTransitionFact, digestOf, type FactStatus } from '../orchestration/contracts';

/** Thrown on an illegal lifecycle move (re-accepting a rejected fact, promoting a legacy row). */
export class FactLifecycleError extends Error {
  constructor(message: string) { super(message); this.name = 'FactLifecycleError'; }
}

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
  /** Lifecycle. Agents write `proposed`; only the coordinator promotes. Pre-Phase-1 rows read as `legacy`. */
  status: FactStatus;
  /** Content digest — how a downstream task detects it is reading a different version of the same fact. */
  digest: string;
  schemaVersion: number;
  /** The accepted fact this one replaces, set when that fact transitions to `superseded`. */
  supersedesFactId: string | null;
  taskId: string | null;
  /** Historical/recalled memory: readable, but can never satisfy a live evidence gate. */
  historical: boolean;
}

export interface PutOptions {
  key?: string | null;
  causationId?: string | null;
  /** ISO timestamp override (tests/determinism); defaults to now. */
  at?: string;
  /** Defaults to `proposed` — nothing becomes authoritative without an explicit coordinator promotion. */
  status?: FactStatus;
  schemaVersion?: number;
  supersedesFactId?: string | null;
  taskId?: string | null;
  historical?: boolean;
}

/** The blackboard contract — same surface whether backed by Postgres or the in-memory store. */
export interface Blackboard {
  /** Append a typed fact; never overwrites. Returns the stored fact (with its assigned seq/id). */
  put<T>(runId: string, kind: string, value: T, by: string, opts?: PutOptions): Promise<BlackboardFact<T>>;
  /** The most recent fact for a kind (+ optional key), or null if none. */
  latest<T>(runId: string, kind: string, key?: string | null): Promise<BlackboardFact<T> | null>;
  /** All facts for a run, optionally filtered to one kind, in append order. */
  all(runId: string, kind?: string): Promise<BlackboardFact[]>;
  /** The most recent ACCEPTED fact — the only read an authoritative gate may use. */
  latestAccepted<T>(runId: string, kind: string, key?: string | null): Promise<BlackboardFact<T> | null>;
  /** Move a fact along the one-way lifecycle. Rejects illegal transitions rather than coercing them. */
  setStatus(factId: string, status: FactStatus): Promise<BlackboardFact | null>;
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
      status: opts.status ?? 'proposed',
      digest: digestOf(value ?? null),
      schemaVersion: opts.schemaVersion ?? 1,
      supersedesFactId: opts.supersedesFactId ?? null,
      taskId: opts.taskId ?? null,
      historical: opts.historical ?? false,
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

  async latestAccepted<T>(runId: string, kind: string, key?: string | null): Promise<BlackboardFact<T> | null> {
    const list = this.facts.get(runId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i];
      if (f.status !== 'accepted') continue;
      if (f.kind === kind && (key === undefined || (f.key ?? null) === (key ?? null))) return f as BlackboardFact<T>;
    }
    return null;
  }

  async setStatus(factId: string, status: FactStatus): Promise<BlackboardFact | null> {
    for (const list of this.facts.values()) {
      const fact = list.find((f) => f.id === factId);
      if (!fact) continue;
      if (!canTransitionFact(fact.status, status)) {
        throw new FactLifecycleError(`Illegal fact transition ${fact.status} -> ${status} for ${factId}.`);
      }
      fact.status = status;
      return fact;
    }
    return null;
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
  status: string | null;
  digest: string | null;
  schema_version: number | null;
  supersedes_fact_id: string | null;
  task_id: string | null;
  historical: boolean | null;
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
    // A NULL status is a pre-Phase-1 row: visible for audit, never promotable to authoritative.
    status: (r.status as FactStatus | null) ?? 'legacy',
    digest: r.digest ?? digestOf(r.value ?? null),
    schemaVersion: Number(r.schema_version ?? 0),
    supersedesFactId: r.supersedes_fact_id ?? null,
    taskId: r.task_id ?? null,
    historical: r.historical ?? false,
  };
}

export class PostgresBlackboard implements Blackboard {
  async put<T>(runId: string, kind: string, value: T, by: string, opts: PutOptions = {}): Promise<BlackboardFact<T>> {
    const id = uid('bbf');
    const row = await withTransaction(async (client) => {
      // Serialize seq allocation per RUN. MAX(seq)+1 alone races: two concurrent writers read the same
      // max and collide on agent_blackboard_run_seq_idx. The advisory lock is transaction-scoped and
      // run-scoped, so unrelated runs never wait on each other.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent_blackboard:${runId}`]);
      const seqRes = await client.query(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_blackboard WHERE run_id = $1',
        [runId],
      );
      const seq = Number(seqRes.rows[0]?.next ?? 1);
      const at = opts.at ?? new Date().toISOString();
      const ins = await client.query(
        `INSERT INTO agent_blackboard (id, run_id, seq, kind, sub_key, value, by_agent, causation_id, created_at,
                                       status, digest, schema_version, supersedes_fact_id, task_id, historical)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [id, runId, seq, kind, opts.key ?? null, JSON.stringify(value ?? null), by, opts.causationId ?? null, at,
         opts.status ?? 'proposed', digestOf(value ?? null), opts.schemaVersion ?? 1,
         opts.supersedesFactId ?? null, opts.taskId ?? null, opts.historical ?? false],
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

  async latestAccepted<T>(runId: string, kind: string, key?: string | null): Promise<BlackboardFact<T> | null> {
    const rows = key === undefined
      ? await query<BlackboardRow>("SELECT * FROM agent_blackboard WHERE run_id=$1 AND kind=$2 AND status='accepted' ORDER BY seq DESC LIMIT 1", [runId, kind])
      : await query<BlackboardRow>("SELECT * FROM agent_blackboard WHERE run_id=$1 AND kind=$2 AND sub_key IS NOT DISTINCT FROM $3 AND status='accepted' ORDER BY seq DESC LIMIT 1", [runId, kind, key ?? null]);
    return rows[0] ? (rowToFact(rows[0]) as BlackboardFact<T>) : null;
  }

  async setStatus(factId: string, status: FactStatus): Promise<BlackboardFact | null> {
    // Read-check-write under one transaction so two coordinators cannot both promote the same fact.
    return withTransaction(async (client) => {
      const cur = await client.query<BlackboardRow>('SELECT * FROM agent_blackboard WHERE id=$1 FOR UPDATE', [factId]);
      if (!cur.rows[0]) return null;
      const from = rowToFact(cur.rows[0]).status;
      if (!canTransitionFact(from, status)) {
        throw new FactLifecycleError(`Illegal fact transition ${from} -> ${status} for ${factId}.`);
      }
      const upd = await client.query<BlackboardRow>('UPDATE agent_blackboard SET status=$2 WHERE id=$1 RETURNING *', [factId, status]);
      return rowToFact(upd.rows[0]);
    });
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
