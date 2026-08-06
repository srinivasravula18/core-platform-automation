/**
 * One-click download tickets.
 *
 * The agent bundle is ~300 MB, so the browser must fetch it natively — a top-level navigation that
 * streams to disk with Chrome's own progress UI. A navigation cannot carry an Authorization header,
 * so clicking Download first mints a ticket that authorizes exactly one bundle URL.
 *
 * A ticket also pins the pairing token it was minted with, so re-requesting the same URL yields
 * byte-identical bytes. That is what makes an interrupted download resumable instead of splicing two
 * differently-personalized archives together. Tickets expire with the pairing token they carry —
 * they add no lifetime of their own.
 */

import { randomUUID } from 'crypto';

type Ticket = { pairingToken: string; name: string; userId: string; expiresAt: number };

const tickets = new Map<string, Ticket>();

function prune(now: number): void {
  for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
}

export function createDownloadTicket(input: { pairingToken: string; name: string; userId: string; expiresInMs: number }): string {
  const now = Date.now();
  prune(now);
  const id = randomUUID();
  tickets.set(id, {
    pairingToken: input.pairingToken,
    name: input.name,
    userId: input.userId,
    expiresAt: now + input.expiresInMs,
  });
  return id;
}

/** Read without consuming: a resumed download re-requests the same URL and must get the same bundle. */
export function readDownloadTicket(id: string): Ticket | null {
  const now = Date.now();
  prune(now);
  const ticket = tickets.get(String(id || ''));
  return ticket && ticket.expiresAt > now ? ticket : null;
}

/** Test seam. */
export function clearDownloadTickets(): void {
  tickets.clear();
}
