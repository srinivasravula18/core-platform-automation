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
  return { projectId, appId: appId || null };
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
export function scopeFilter<T extends { projectId?: string; appId?: string }>(items: T[], scope: Scope): T[] {
  if (!scope.projectId) return items;
  return items.filter((it) => {
    if (!it.projectId) return true;
    if (it.projectId !== scope.projectId) return false;
    if (scope.appId && it.appId && it.appId !== scope.appId) return false;
    return true;
  });
}

/** Fields to stamp onto a new record so it belongs to the current scope. */
export function scopeStamp(scope: Scope): { projectId?: string; appId?: string } {
  if (!scope.projectId) return {};
  return { projectId: scope.projectId, appId: scope.appId || '' };
}
