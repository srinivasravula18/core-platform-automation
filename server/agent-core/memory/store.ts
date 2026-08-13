/** Semantic memory store: episodic, semantic, and procedural records keyed by (scope, kind, subject). */
import { isPostgresEnabled, query, uid } from '../../db/pool';

export type MemoryKind = 'episodic' | 'semantic' | 'procedural';
export type MemoryOutcome = 'pass' | 'fail' | 'flaky' | 'note';

/** The namespace a memory belongs to — project/app/owner (feature is part of the subject, not the scope). */
export interface MemoryScope {
  projectId?: string | null;
  appId?: string | null;
  ownerId?: string | null;
}

export interface MemoryRecord<T = unknown> {
  id: string;
  scopeKey: string;
  kind: MemoryKind;
  subject: string;
  outcome: MemoryOutcome | null;
  weight: number;
  value: T;
  runId: string | null;
  at: string;
}

export interface WriteMemoryInput<T = unknown> {
  scope: MemoryScope;
  kind: MemoryKind;
  subject: string;
  outcome?: MemoryOutcome;
  weight?: number;
  value?: T;
  runId?: string | null;
}

export interface RecallQuery {
  scope: MemoryScope;
  kind?: MemoryKind;
  /** Exact subject to match (e.g. a specific selector). */
  subject?: string;
  /** Free-text relevance query matched against subject + serialized value. */
  text?: string;
  limit?: number;
}

/** Deterministic scope key — the SAME derivation on write and read, so recall can never miss the write. */
export function scopeKeyOf(scope: MemoryScope): string {
  return [scope.projectId || '*', scope.appId || '*', scope.ownerId || '*'].join('::');
}

export interface MemoryStore {
  write<T>(input: WriteMemoryInput<T>): Promise<MemoryRecord<T>>;
  recall(q: RecallQuery): Promise<MemoryRecord[]>;
  clearScope(scope: MemoryScope): Promise<void>;
}

/** Relevance score: recency (log-decayed) + weight + lexical overlap with the text query. Higher = better. */
function score(rec: MemoryRecord, text: string | undefined, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - new Date(rec.at).getTime()) / 86_400_000);
  const recency = 1 / (1 + Math.log1p(ageDays));
  let lexical = 0;
  if (text) {
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${rec.subject} ${JSON.stringify(rec.value ?? '')}`.toLowerCase();
    lexical = terms.filter((t) => hay.includes(t)).length;
  }
  return rec.weight * 1 + recency + lexical * 2;
}

// ---------------------------------------------------------------------------------------------
// In-memory store — default when Postgres is not configured.
// ---------------------------------------------------------------------------------------------

export class InMemoryMemoryStore implements MemoryStore {
  private records: MemoryRecord[] = [];

  async write<T>(input: WriteMemoryInput<T>): Promise<MemoryRecord<T>> {
    const rec: MemoryRecord<T> = {
      id: uid('mem'),
      scopeKey: scopeKeyOf(input.scope),
      kind: input.kind,
      subject: input.subject,
      outcome: input.outcome ?? null,
      weight: input.weight ?? 1,
      value: (input.value ?? null) as T,
      runId: input.runId ?? null,
      at: new Date().toISOString(),
    };
    this.records.push(rec);
    return rec;
  }

  async recall(q: RecallQuery): Promise<MemoryRecord[]> {
    const key = scopeKeyOf(q.scope);
    const nowMs = Date.now();
    const matched = this.records.filter((r) =>
      r.scopeKey === key
      && (!q.kind || r.kind === q.kind)
      && (q.subject === undefined || r.subject === q.subject));
    return matched
      .sort((a, b) => score(b, q.text, nowMs) - score(a, q.text, nowMs))
      .slice(0, q.limit ?? 10);
  }

  async clearScope(scope: MemoryScope): Promise<void> {
    const key = scopeKeyOf(scope);
    this.records = this.records.filter((r) => r.scopeKey !== key);
  }
}

// ---------------------------------------------------------------------------------------------
// Postgres store — durable, shared across processes.
// ---------------------------------------------------------------------------------------------

interface MemoryRow {
  id: string; scope_key: string; kind: string; subject: string;
  outcome: string | null; weight: number; value: unknown; run_id: string | null; created_at: string;
}

function rowToRecord(r: MemoryRow): MemoryRecord {
  return {
    id: r.id, scopeKey: r.scope_key, kind: r.kind as MemoryKind, subject: r.subject,
    outcome: (r.outcome as MemoryOutcome | null) ?? null, weight: Number(r.weight),
    value: r.value, runId: r.run_id, at: new Date(r.created_at).toISOString(),
  };
}

export class PostgresMemoryStore implements MemoryStore {
  async write<T>(input: WriteMemoryInput<T>): Promise<MemoryRecord<T>> {
    const id = uid('mem');
    const rows = await query<MemoryRow>(
      `INSERT INTO agent_memory (id, scope_key, kind, subject, outcome, weight, value, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [id, scopeKeyOf(input.scope), input.kind, input.subject, input.outcome ?? null, input.weight ?? 1, JSON.stringify(input.value ?? null), input.runId ?? null],
    );
    return rowToRecord(rows[0]) as MemoryRecord<T>;
  }

  async recall(q: RecallQuery): Promise<MemoryRecord[]> {
    // Pull the candidate set by the SAME key, then rank in-process (portable across PG without pgvector).
    const conds = ['scope_key = $1'];
    const params: any[] = [scopeKeyOf(q.scope)];
    if (q.kind) { params.push(q.kind); conds.push(`kind = $${params.length}`); }
    if (q.subject !== undefined) { params.push(q.subject); conds.push(`subject = $${params.length}`); }
    const rows = await query<MemoryRow>(
      `SELECT * FROM agent_memory WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params,
    );
    const nowMs = Date.now();
    return rows.map(rowToRecord)
      .sort((a, b) => score(b, q.text, nowMs) - score(a, q.text, nowMs))
      .slice(0, q.limit ?? 10);
  }

  async clearScope(scope: MemoryScope): Promise<void> {
    await query('DELETE FROM agent_memory WHERE scope_key = $1', [scopeKeyOf(scope)]);
  }
}

let singleton: MemoryStore | null = null;

/** The process memory store: Postgres-backed when configured, in-memory otherwise. Injectable (tests). */
export function getMemoryStore(): MemoryStore {
  if (!singleton) singleton = isPostgresEnabled() ? new PostgresMemoryStore() : new InMemoryMemoryStore();
  return singleton;
}

export function setMemoryStore(store: MemoryStore | null): void {
  singleton = store;
}
