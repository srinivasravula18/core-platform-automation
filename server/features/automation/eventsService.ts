/**
 * Record & Play — event backbone.
 *
 * Every state change (agent online/offline, recording progress, job lifecycle) is emitted here.
 * Two sinks:
 *   1. Durable append to `automation_events` (audit + post-refresh reconstruction).
 *   2. Live fan-out to SSE subscribers, filtered by owner so a user only sees their own events.
 *
 * SSE (not WebSocket) is used browser-side on purpose: it matches the app's existing live-log
 * pattern (server/features/controller/routes.ts, lib/useAgentRun.ts) and needs no new client lib.
 */

import type { Response } from 'express';
import { AutomationEvents } from '../../db/repository';

export type EventScopeType = 'agent' | 'job' | 'recording';

export interface AutomationEvent {
  scopeType: EventScopeType;
  scopeId: string;
  type: string;
  ownerId: string;
  data: Record<string, any>;
  seq?: number;
  createdAt?: string;
}

interface Subscriber {
  ownerId: string;
  send: (evt: AutomationEvent) => void;
}

const subscribers = new Set<Subscriber>();

// 4KB SSE comment line to defeat proxy buffering — same technique as the controller stream.
const STREAM_PAD = `:${' '.repeat(4096)}\n\n`;

/** Persist an event and fan it out live to the owner's subscribers. */
export async function emitEvent(evt: AutomationEvent): Promise<void> {
  try {
    const row = await AutomationEvents.append({
      scopeType: evt.scopeType,
      scopeId: evt.scopeId,
      type: evt.type,
      payload: { ownerId: evt.ownerId, ...evt.data },
    });
    const enriched: AutomationEvent = { ...evt, seq: row?.seq, createdAt: row?.createdAt };
    for (const sub of subscribers) {
      if (sub.ownerId === evt.ownerId) {
        try { sub.send(enriched); } catch { /* drop broken subscriber; close handler cleans up */ }
      }
    }
  } catch (err: any) {
    console.error('[automation] emitEvent failed:', err?.message || err);
  }
}

/** Attach an Express response as an SSE stream scoped to one owner. Returns an unsubscribe fn. */
export function subscribe(res: Response, ownerId: string): () => void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  (res as any).socket?.setNoDelay?.(true);
  res.flushHeaders?.();
  res.write(`retry: 3000\n\n`);
  res.write(STREAM_PAD);

  const sub: Subscriber = {
    ownerId,
    send: (evt) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
      (res as any).flush?.();
    },
  };
  subscribers.add(sub);

  // Keep-alive comment every 25s so idle proxies don't drop the connection.
  const ka = setInterval(() => {
    try { res.write(`: keep-alive\n\n`); (res as any).flush?.(); } catch { /* closed */ }
  }, 25_000);

  const cleanup = () => {
    clearInterval(ka);
    subscribers.delete(sub);
  };
  return cleanup;
}
