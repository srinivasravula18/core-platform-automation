/**
 * Centralized authorization gate. Mounts once, right after scopeMiddleware, so identity + grants are
 * resolved. It decides COARSE permission (may this subject invoke this route at all); row-level
 * ownership stays in the handlers (scopeFilter). Unauthenticated/admin/ungrouped callers resolve to
 * UNRESTRICTED and pass — enforcement only ever narrows a grouped non-admin user.
 *
 * Enforcement is ALWAYS ON (no env flag): a denied request is audited and 403'd. This is a security
 * policy, not a learned app fact, so it is fixed in code by design.
 */

import type { Request, Response, NextFunction } from 'express';
import { reqGrants, reqScope } from '../../shared/scope';
import { requiredPermissionFor, toPermSet, permits } from './permissions';
import { writeAudit } from './authRepo';

export function rbacGate(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api/')) return next();

  const required = requiredPermissionFor(req.method, req.path);
  if (!required) return next(); // route not gated (auth/settings/etc.) — handled by requireAdmin or apiAuthGate

  const ps = toPermSet(reqGrants(req));
  if (permits(ps, required)) return next();

  const scope = reqScope(req);
  writeAudit({
    actorId: scope.userId || undefined,
    event: 'decision.deny',
    principalType: 'user',
    principalId: scope.userId || undefined,
    permissionId: required,
    decision: 'deny',
    detail: { method: req.method, path: req.path },
  });
  return res.status(403).json({ error: 'You do not have permission to perform this action.', required });
}
