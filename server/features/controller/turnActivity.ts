import { randomUUID } from 'crypto';
import { ConversationSessions } from '../../db/repository';
import { redactSecrets } from '../../ai/memory/artifactMemory';

export type TurnActivityKind =
  | 'queued'
  | 'routing'
  | 'agent_started'
  | 'progress'
  | 'tool_started'
  | 'tool_completed'
  | 'responding'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type TurnActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface TurnActivityEvent {
  requestId: string;
  kind: TurnActivityKind;
  status: TurnActivityStatus;
  at: string;
  label?: string;
  tool?: { name: string; arguments?: unknown; resultSummary?: string; error?: string; ms?: number };
}

interface ActiveTurn {
  conversationId: string;
  controller: AbortController;
  ordinal: number;
  writes: Promise<unknown>;
}

const activeTurns = new Map<string, ActiveTurn>();
const terminalKinds = new Set<TurnActivityKind>(['completed', 'failed', 'cancelled', 'interrupted']);

function statusFor(kind: TurnActivityKind): TurnActivityStatus {
  return terminalKinds.has(kind) ? kind as TurnActivityStatus : 'running';
}

function safeText(value: unknown, limit = 1_200): string {
  const redacted = redactSecrets(value);
  let text: string;
  try { text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted); }
  catch { text = String(redacted); }
  return text
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|secret|token|cookie|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, limit);
}

function enqueue(entry: ActiveTurn, requestId: string, kind: TurnActivityKind, detail: Record<string, unknown> = {}) {
  const ordinal = ++entry.ordinal;
  const payload: TurnActivityEvent = {
    requestId,
    kind,
    status: statusFor(kind),
    at: new Date().toISOString(),
    ...redactSecrets(detail) as Record<string, unknown>,
  } as TurnActivityEvent;
  entry.writes = entry.writes.then(() => ConversationSessions.commit({
    conversationId: entry.conversationId,
    events: [{
      eventType: 'TurnActivity',
      payload,
      sourceKey: `turn:${requestId}:${ordinal}:${kind}`,
      correlationId: requestId,
    }],
  }));
  return entry.writes;
}

export async function beginTurnActivity(input: {
  conversationId: string;
  requestId?: string;
  ownerId?: string;
  workspaceId?: string;
  projectId?: string | null;
}) {
  const requestId = String(input.requestId || randomUUID()).trim();
  if (!requestId || requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) throw new Error('requestId is invalid');
  if (activeTurns.has(requestId)) throw new Error('requestId is already active');
  const entry: ActiveTurn = {
    conversationId: input.conversationId,
    controller: new AbortController(),
    ordinal: 0,
    writes: Promise.resolve(),
  };
  activeTurns.set(requestId, entry);
  try {
    await ConversationSessions.commit({
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    });
    await enqueue(entry, requestId, 'queued', { label: 'Starting request' });
    return { requestId, signal: entry.controller.signal };
  } catch (error) {
    activeTurns.delete(requestId);
    throw error;
  }
}

export function recordTurnActivity(requestId: string, kind: TurnActivityKind, detail: Record<string, unknown> = {}) {
  const entry = activeTurns.get(requestId);
  return entry ? enqueue(entry, requestId, kind, detail) : Promise.resolve();
}

async function finish(requestId: string, kind: Extract<TurnActivityKind, 'completed' | 'failed'>, detail: Record<string, unknown>) {
  const entry = activeTurns.get(requestId);
  if (!entry) return;
  await enqueue(entry, requestId, kind, detail);
  activeTurns.delete(requestId);
}

export function completeTurnActivity(requestId: string, detail: Record<string, unknown> = {}) {
  return finish(requestId, 'completed', detail);
}

export function failTurnActivity(requestId: string, error: unknown) {
  return finish(requestId, 'failed', { label: 'Request failed', error: safeText(error instanceof Error ? error.message : error, 500) });
}

export async function cancelTurnActivity(conversationId: string, requestId: string) {
  const entry = activeTurns.get(requestId);
  if (!entry || entry.conversationId !== conversationId) return false;
  entry.controller.abort();
  await enqueue(entry, requestId, 'cancelled', { label: 'Request cancelled' });
  activeTurns.delete(requestId);
  return true;
}

export function summarizeActivityValue(value: unknown) {
  return safeText(value);
}

export async function listTurnActivity(conversationId: string, sinceSeq = 0) {
  let allEvents = (await ConversationSessions.listEvents(conversationId, 0))
    .filter((event) => event.eventType === 'TurnActivity');

  const latestByRequest = new Map<string, any>();
  for (const event of allEvents) latestByRequest.set(String(event.correlationId || event.payload?.requestId || ''), event);
  for (const [requestId, event] of latestByRequest) {
    if (!requestId || event.payload?.status !== 'running' || activeTurns.has(requestId)) continue;
    await ConversationSessions.commit({
      conversationId,
      events: [{
        eventType: 'TurnActivity',
        payload: {
          requestId,
          kind: 'interrupted',
          status: 'interrupted',
          at: new Date().toISOString(),
          label: 'Request was interrupted by a server restart',
        },
        sourceKey: `turn:${requestId}:interrupted`,
        correlationId: requestId,
      }],
    });
    allEvents = (await ConversationSessions.listEvents(conversationId, 0))
      .filter((candidate) => candidate.eventType === 'TurnActivity');
  }

  const requests = new Map<string, { requestId: string; status: TurnActivityStatus; lastSeq: number; updatedAt: string }>();
  for (const event of allEvents) {
    const requestId = String(event.correlationId || event.payload?.requestId || '');
    if (!requestId) continue;
    requests.set(requestId, {
      requestId,
      status: event.payload?.status || 'running',
      lastSeq: event.seq,
      updatedAt: event.payload?.at || event.createdAt,
    });
  }
  const requestList = [...requests.values()].sort((a, b) => b.lastSeq - a.lastSeq);
  const events = allEvents.filter((event) => event.seq > Math.max(0, sinceSeq));
  return { events, requests: requestList, latest: requestList[0] || null };
}
