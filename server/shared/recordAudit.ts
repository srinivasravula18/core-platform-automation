/**
 * recordAudit — the single call every CRUD write path uses to record "who did what, when".
 *
 * It writes to BOTH:
 *   1. the durable audit_log (Audit.push) — the historical source of truth, queryable per-record
 *      and per-user, ordered deterministically by (at, seq); and
 *   2. the dashboard "Recent Activity" feed (addActivity) — the live rolling view.
 *
 * The actor is taken from the per-request AsyncLocalStorage context (currentActor), so callers do
 * not thread the user through. Background/agent writes pass an explicit actor.
 */

import { addActivity } from './storage';
import { currentActor } from './requestContext';
import type { Actor } from './metadata';
import { Audit } from '../db/repository';

export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'approve' | 'run' | string;

export function recordAudit(
  action: AuditAction,
  entityType: string,
  entityId: string,
  summary: string,
  opts: { actor?: Actor; ownerId?: string; target?: string; meta?: Record<string, any>; workspaceId?: string } = {},
): void {
  const actor = opts.actor || currentActor();
  const ownerId = opts.ownerId || actor.id;
  // Durable (best-effort; never block the request on the audit write).
  void Audit.push({
    actor: actor.id,
    actorName: actor.name,
    action,
    entityType,
    entityId,
    ownerId,
    target: opts.target || entityId,
    detail: summary,
    workspaceId: opts.workspaceId,
  }).catch(() => { /* audit is best-effort */ });
  // Live dashboard feed (owner-scoped, per-user).
  addActivity(summary, { type: entityType, entityId, actor: actor.name, ownerId, meta: opts.meta });
}
