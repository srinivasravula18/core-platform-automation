/**
 * Centralized authorization gate. Mounts once, right after scopeMiddleware, so identity + grants are
 * resolved. It decides COARSE permission (may this subject invoke this route at all); row-level
 * ownership stays in the handlers (scopeFilter). Unauthenticated/admin/ungrouped callers resolve to
 * UNRESTRICTED and pass — enforcement only ever narrows a grouped non-admin user.
 *
 * Flag RBAC_ENFORCEMENT_V1 (default OFF) runs it in SHADOW mode: would-be denials are logged +
 * audited but allowed through, so a deployment can observe impact before flipping enforcement on.
 */

import type { Request, Response, NextFunction } from 'express';
import { reqGrants, reqScope } from '../../shared/scope';
import { requiredPermissionFor, toPermSet, permits } from './permissions';
import { writeAudit } from './authRepo';

export function isRbacEnforced(): boolean {
  return String(process.env.RBAC_ENFORCEMENT_V1 || '').toLowerCase() === 'true';
}

export function rbacGate(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api/')) return next();

  const required = requiredPermissionFor(req.method, req.path);
  if (!required) return next(); // route not gated (auth/settings/etc.) — handled by requireAdmin or apiAuthGate

  const ps = toPermSet(reqGrants(req));
  if (permits(ps, required)) return next();

  const scope = reqScope(req);
  const enforced = isRbacEnforced();
  writeAudit({
    actorId: scope.userId || undefined,
    event: 'decision.deny',
    principalType: 'user',
    principalId: scope.userId || undefined,
    permissionId: required,
    decision: 'deny',
    detail: { method: req.method, path: req.path, enforced },
  });

  if (!enforced) {
    console.warn(`[rbac] SHADOW deny → ${scope.username || 'anon'} ${req.method} ${req.path} needs ${required} (would 403 when RBAC_ENFORCEMENT_V1=true)`);
    return next();
  }
  return res.status(403).json({ error: 'You do not have permission to perform this action.', required });
}
