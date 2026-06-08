import type { Express } from 'express';

/**
 * Inbox functionality has been removed.
 *
 * These no-ops keep existing imports/call sites compiling while nothing is
 * registered, persisted, or surfaced. Re-introduce a real implementation here
 * if the AI Inbox is ever brought back.
 */

export function registerInboxRoutes(_app: Express): void {
  /* inbox removed — no routes registered */
}

export async function pushInboxItem(_item: unknown): Promise<{ id: string }> {
  return { id: '' };
}
