/**
 * Request scope — the selected Project (+ optional App) a request operates within.
 *
 * The frontend attaches `X-Project-Id` / `X-App-Id` headers on every /api call (see
 * src/lib/base-path.ts). A middleware resolves them into `req.scope`; handlers then
 * filter reads and stamp writes so each project/app sees and grows its own data.
 *
 * Fail-safe by design: when no project is selected, nothing is filtered (full
 * back-compat). Legacy/untagged rows stay visible in every project, so adopting
 * scoping never hides existing data — it only organizes new work.
 */

import type { Request } from 'express';

export interface Scope {
  /** Selected project id, or '' when none is selected. */
  projectId: string;
  /** Selected app id, or null for project-level (cross-app). */
  appId: string | null;
  /** Logged-in app user id, or '' when unauthenticated. Drives per-user isolation. */
  userId?: string;
  /** Logged-in username, or '' when unauthenticated. Used to attribute activity/history. */
  username?: string;
  /** Logged-in user's role ('admin' sees all data; 'tester' sees only their own). */
  role?: string;
}

function headerOrBody(req: Request, header: string, bodyKey: string): string {
  const h = req.header(header);
  if (h) return String(h).trim();
  const b = (req as any).body?.[bodyKey];
  return b ? String(b).trim() : '';
}

/** Resolve the scope of a request from headers (preferred) or body fallback. */
export function getScope(req: Request): Scope {
  const projectId = headerOrBody(req, 'x-project-id', 'projectId');
  const appId = headerOrBody(req, 'x-app-id', 'appId');
  // authContextMiddleware (registered before scopeMiddleware) resolves the token
  // into the logged-in user; read it here without importing the auth module.
  const authUser = (req as any).authUser as { userId?: string; username?: string; role?: string } | null | undefined;
  return { projectId, appId: appId || null, userId: authUser?.userId || '', username: authUser?.username || '', role: authUser?.role || '' };
}

/** Express middleware: attach `req.scope` for every request. */
export function scopeMiddleware(req: Request, _res: any, next: any) {
  (req as any).scope = getScope(req);
  next();
}

/** Read the scope a middleware attached (or resolve it on demand). */
export function reqScope(req: Request): Scope {
  return (req as any).scope || getScope(req);
}

/**
 * Filter a list to the request's scope.
 * - No project selected → everything (back-compat).
 * - Untagged rows (no projectId) → visible in every project (non-breaking).
 * - App selected → that app's rows + project-level (untagged-app) rows.
 */
export function scopeFilter<T extends { projectId?: string; appId?: string; ownerId?: string }>(items: T[], scope: Scope): T[] {
  let out = items;
  // STRICT per-user isolation, independent of project selection and role: EVERY logged-in
  // user — admin included — sees ONLY rows they own. No user's data is ever visible to
  // another user anywhere in the app. Admin's elevated rights are for user/settings
  // MANAGEMENT (see requireAdmin), NOT for seeing other users' data. Legacy/unowned rows
  // are reassigned to admin at startup (claimLegacyDataForAdmin). Unauthenticated/internal
  // callers (no userId) bypass this.
  if (scope.userId) {
    out = out.filter((it) => (it.ownerId || '') === scope.userId);
  }
  if (!scope.projectId) return out;
  return out.filter((it) => {
    if (!it.projectId) return true;
    if (it.projectId !== scope.projectId) return false;
    if (scope.appId && it.appId && it.appId !== scope.appId) return false;
    return true;
  });
}

/**
 * True when a row belongs to ANOTHER user (Phase 7 tenant isolation). Legacy unowned
 * rows and unauthenticated/internal callers pass — enforcement never hides old data.
 */
export function ownerMismatch(row: { ownerId?: string } | null | undefined, scope: Scope): boolean {
  return !!(scope.userId && row?.ownerId && row.ownerId !== scope.userId);
}

/** Fields to stamp onto a new record so it belongs to the current scope + owner. */
export function scopeStamp(scope: Scope): { projectId?: string; appId?: string; ownerId?: string } {
  const stamp: { projectId?: string; appId?: string; ownerId?: string } = {};
  if (scope.projectId) {
    stamp.projectId = scope.projectId;
    stamp.appId = scope.appId || '';
  }
  // Stamp the owner even when no project is selected, so a tester's data is always
  // attributable to them (and therefore visible to them, hidden from others).
  if (scope.userId) stamp.ownerId = scope.userId;
  return stamp;
}
