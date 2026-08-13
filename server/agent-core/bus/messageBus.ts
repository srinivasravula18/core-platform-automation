/** Message bus — typed inter-agent messages over a persisted per-run log, with causation chains and loop budgets. */
import { isPostgresEnabled, query, uid, withTransaction } from '../../db/pool';

/** Responses must answer something. An orphan RESULT/CRITIQUE/ANSWER is rejected, not silently logged. */
const REQUIRES_CAUSATION: readonly AgentMessageType[] = ['RESULT', 'CRITIQUE', 'ANSWER'];

export type AgentMessageType =
  | 'REQUEST'
  | 'RESULT'
  | 'HANDOFF'
  | 'DELEGATE'
  | 'CRITIQUE'
  | 'QUESTION'
  | 'ANSWER';

export const AGENT_MESSAGE_TYPES: readonly AgentMessageType[] = [
  'REQUEST', 'RESULT', 'HANDOFF', 'DELEGATE', 'CRITIQUE', 'QUESTION', 'ANSWER',
];

/** One typed message. `to === null` is a broadcast (any agent may read it). `seq` is per-run append order. */
export interface AgentMessage<T = unknown> {
  id: string;
  runId: string;
  seq: number;
  from: string;
  /** Target agent name, or null for broadcast. */
  to: string | null;
  type: AgentMessageType;
  payload: T;
  /** The message id this one was caused by (answer/continuation), for chain tracing + cycle detection. */
  causationId: string | null;
  at: string;
  /** Orchestration correlation — null on pre-Phase-1 rows, which stay readable. */
  taskId: string | null;
  agentInstanceId: string | null;
  traceId: string | null;
}

export interface PublishInput<T = unknown> {
  runId: string;
  from: string;
  to?: string | null;
  type: AgentMessageType;
  payload: T;
  causationId?: string | null;
  taskId?: string | null;
  agentInstanceId?: string | null;
  traceId?: string | null;
}

export interface HistoryOptions {
  /** Only messages of these types. */
  types?: AgentMessageType[];
  /** Cap the number returned (most-recent-first slicing is the caller's job — this returns append order). */
  limit?: number;
}

/** Thrown when a message breaks the protocol (e.g. a response answering nothing) — a contract error. */
export class ProtocolViolationError extends Error {
  constructor(message: string, readonly runId: string) {
    super(message);
    this.name = 'ProtocolViolationError';
  }
}

/** Rejects orphan responses. Task-bound only, so legacy stage projections keep working unchanged. */
function assertProtocol(input: PublishInput): void {
  if (!input.taskId) return;
  if (REQUIRES_CAUSATION.includes(input.type) && !input.causationId) {
    throw new ProtocolViolationError(`${input.type} for task ${input.taskId} must carry causationId — an orphan response is not traceable.`, input.runId);
  }
}

/** Thrown when a run exceeds its message budget or causation-chain depth — a loop guard, not a normal error. */
export class BusBudgetExceededError extends Error {
  constructor(message: string, readonly runId: string) {
    super(message);
    this.name = 'BusBudgetExceededError';
  }
}

/** Default per-run message budget; override with AGENT_BUS_MAX_MESSAGES. */
function maxMessagesPerRun(): number {
  const n = Number(process.env.AGENT_BUS_MAX_MESSAGES || '');
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

/** Default max causation-chain depth (a REQUEST→…→REQUEST loop this long is treated as runaway). */
function maxCausationDepth(): number {
  const n = Number(process.env.AGENT_BUS_MAX_CAUSATION_DEPTH || '');
  return Number.isFinite(n) && n > 0 ? n : 100;
}

export interface MessageBus {
  /** Append a message after the budget + cycle guards pass. Returns the stored message. */
  publish<T>(input: PublishInput<T>): Promise<AgentMessage<T>>;
  /** All messages for a run in append order (optionally filtered/limited). */
  history(runId: string, opts?: HistoryOptions): Promise<AgentMessage[]>;
  /** Messages addressed to `agent` (its `to`) plus broadcasts (`to === null`), in append order. */
  inbox(runId: string, agent: string): Promise<AgentMessage[]>;
  /** Remove all messages for a run (cleanup / test isolation). */
  clear(runId: string): Promise<void>;
}

/** Shared guard logic: compute the causation-chain depth of a candidate message given prior history. */
function causationDepth(causationId: string | null | undefined, byId: Map<string, AgentMessage>): number {
  let depth = 0;
  let cur = causationId ?? null;
  const seen = new Set<string>();
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    depth += 1;
    cur = byId.get(cur)!.causationId;
    if (depth > 100000) break; // absolute backstop against a corrupt chain
  }
  return depth;
}

// ---------------------------------------------------------------------------------------------
// In-memory bus — default when Postgres is not configured.
// ---------------------------------------------------------------------------------------------

export class InMemoryMessageBus implements MessageBus {
  private log = new Map<string, AgentMessage[]>();
  private seq = new Map<string, number>();

  async publish<T>(input: PublishInput<T>): Promise<AgentMessage<T>> {
    assertProtocol(input);
    const list = this.log.get(input.runId) ?? [];
    if (list.length >= maxMessagesPerRun()) {
      throw new BusBudgetExceededError(`Message budget exhausted for run ${input.runId} (${list.length} >= ${maxMessagesPerRun()}).`, input.runId);
    }
    const byId = new Map(list.map((m) => [m.id, m]));
    const depth = causationDepth(input.causationId ?? null, byId);
    if (depth >= maxCausationDepth()) {
      throw new BusBudgetExceededError(`Causation-chain depth ${depth} exceeds limit ${maxCausationDepth()} for run ${input.runId} (likely a message loop).`, input.runId);
    }
    const seq = (this.seq.get(input.runId) ?? 0) + 1;
    this.seq.set(input.runId, seq);
    const msg: AgentMessage<T> = {
      id: uid('msg'),
      runId: input.runId,
      seq,
      from: input.from,
      to: input.to ?? null,
      type: input.type,
      payload: input.payload,
      causationId: input.causationId ?? null,
      at: new Date().toISOString(),
      taskId: input.taskId ?? null,
      agentInstanceId: input.agentInstanceId ?? null,
      traceId: input.traceId ?? null,
    };
    list.push(msg);
    this.log.set(input.runId, list);
    return msg;
  }

  async history(runId: string, opts: HistoryOptions = {}): Promise<AgentMessage[]> {
    let list = (this.log.get(runId) ?? []).slice();
    if (opts.types?.length) {
      const set = new Set(opts.types);
      list = list.filter((m) => set.has(m.type));
    }
    if (opts.limit && opts.limit > 0) list = list.slice(0, opts.limit);
    return list;
  }

  async inbox(runId: string, agent: string): Promise<AgentMessage[]> {
    return (this.log.get(runId) ?? []).filter((m) => m.to === null || m.to === agent);
  }

  async clear(runId: string): Promise<void> {
    this.log.delete(runId);
    this.seq.delete(runId);
  }
}

// ---------------------------------------------------------------------------------------------
// Postgres bus — durable, shared across processes.
// ---------------------------------------------------------------------------------------------

interface MessageRow {
  id: string;
  run_id: string;
  seq: string | number;
  from_agent: string;
  to_agent: string | null;
  type: string;
  payload: unknown;
  causation_id: string | null;
  created_at: string;
  task_id: string | null;
  agent_instance_id: string | null;
  trace_id: string | null;
}

function rowToMessage(r: MessageRow): AgentMessage {
  return {
    id: r.id,
    runId: r.run_id,
    seq: Number(r.seq),
    from: r.from_agent,
    to: r.to_agent,
    type: r.type as AgentMessageType,
    payload: r.payload,
    causationId: r.causation_id,
    at: new Date(r.created_at).toISOString(),
    taskId: r.task_id ?? null,
    agentInstanceId: r.agent_instance_id ?? null,
    traceId: r.trace_id ?? null,
  };
}

export class PostgresMessageBus implements MessageBus {
  async publish<T>(input: PublishInput<T>): Promise<AgentMessage<T>> {
    assertProtocol(input);
    const id = uid('msg');
    const row = await withTransaction(async (client) => {
      // Same race as the blackboard: seq derives from a count, so concurrent publishers must serialize
      // per run or two messages claim the same seq. Transaction-scoped and run-scoped.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent_messages:${input.runId}`]);
      const countRes = await client.query('SELECT COUNT(*)::int AS n FROM agent_messages WHERE run_id=$1', [input.runId]);
      const count = Number(countRes.rows[0]?.n ?? 0);
      if (count >= maxMessagesPerRun()) {
        throw new BusBudgetExceededError(`Message budget exhausted for run ${input.runId} (${count} >= ${maxMessagesPerRun()}).`, input.runId);
      }
      // Load just the (id, causation_id) chain columns to bound depth — cheap, per-run scoped.
      const chainRes = await client.query<{ id: string; causation_id: string | null }>(
        'SELECT id, causation_id FROM agent_messages WHERE run_id=$1', [input.runId],
      );
      const byId = new Map<string, AgentMessage>();
      for (const c of chainRes.rows) byId.set(c.id, { causationId: c.causation_id } as AgentMessage);
      const depth = causationDepth(input.causationId ?? null, byId);
      if (depth >= maxCausationDepth()) {
        throw new BusBudgetExceededError(`Causation-chain depth ${depth} exceeds limit ${maxCausationDepth()} for run ${input.runId} (likely a message loop).`, input.runId);
      }
      const seq = count + 1;
      const ins = await client.query(
        `INSERT INTO agent_messages (id, run_id, seq, from_agent, to_agent, type, payload, causation_id, task_id, agent_instance_id, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) RETURNING *`,
        [id, input.runId, seq, input.from, input.to ?? null, input.type, JSON.stringify(input.payload ?? null), input.causationId ?? null,
         input.taskId ?? null, input.agentInstanceId ?? null, input.traceId ?? null],
      );
      return ins.rows[0] as MessageRow;
    });
    return rowToMessage(row) as AgentMessage<T>;
  }

  async history(runId: string, opts: HistoryOptions = {}): Promise<AgentMessage[]> {
    const rows = opts.types?.length
      ? await query<MessageRow>('SELECT * FROM agent_messages WHERE run_id=$1 AND type = ANY($2) ORDER BY seq ASC', [runId, opts.types])
      : await query<MessageRow>('SELECT * FROM agent_messages WHERE run_id=$1 ORDER BY seq ASC', [runId]);
    const mapped = rows.map(rowToMessage);
    return opts.limit && opts.limit > 0 ? mapped.slice(0, opts.limit) : mapped;
  }

  async inbox(runId: string, agent: string): Promise<AgentMessage[]> {
    const rows = await query<MessageRow>(
      'SELECT * FROM agent_messages WHERE run_id=$1 AND (to_agent IS NULL OR to_agent=$2) ORDER BY seq ASC', [runId, agent],
    );
    return rows.map(rowToMessage);
  }

  async clear(runId: string): Promise<void> {
    await query('DELETE FROM agent_messages WHERE run_id=$1', [runId]);
  }
}

// ---------------------------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------------------------

let singleton: MessageBus | null = null;

/** The process message bus: Postgres-backed when configured, in-memory otherwise. Injectable via setMessageBus (tests). */
export function getMessageBus(): MessageBus {
  if (!singleton) singleton = isPostgresEnabled() ? new PostgresMessageBus() : new InMemoryMessageBus();
  return singleton;
}

/** Test seam — override the process instance (e.g. force in-memory). */
export function setMessageBus(bus: MessageBus | null): void {
  singleton = bus;
}
