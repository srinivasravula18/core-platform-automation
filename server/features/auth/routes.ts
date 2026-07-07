import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import {
  findByUsername,
  verifyPassword,
  getUserById,
  listUsers,
  createAppUser,
  updateAppUser,
  deleteAppUser,
  publicUser,
  type Role,
} from './userStore';

// Multi-user app login with RBAC. Users live in the user store (server/features/
// auth/userStore.ts); tokens (sessions) are issued in-memory on login and validated
// per request. A backend restart simply forces a re-login. Roles are dynamic strings
// resolved at runtime via the user store (own data only).

export interface AuthUser {
  userId: string;
  username: string;
  role: Role;
}

const sessions = new Map<string, AuthUser>();

export function getTokenFromRequest(req: Request): string {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  // EventSource cannot set Authorization headers. Accept token query only for
  // same-origin SSE callers; normal fetches still use the Bearer header.
  if (String(req.headers.accept || '').includes('text/event-stream')) {
    return String(req.query.token || '').trim();
  }
  return '';
}

/** Resolve the logged-in user for a request, or null. */
export function getAuthUser(req: Request): AuthUser | null {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  return sessions.get(token) || null;
}

export function isAuthed(req: Request): boolean {
  return !!getAuthUser(req);
}

/**
 * Attach the resolved user to the request BEFORE scopeMiddleware runs, so the
 * scope layer can partition data per user without importing the auth module.
 */
export function authContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  (req as any).authUser = getAuthUser(req);
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (getAuthUser(req)) return next();
  return res.status(401).json({ error: 'Authentication required.' });
}

/**
 * Endpoints under /api that must work WITHOUT a logged-in user:
 *  - health / app-config: probed before login (app boot decides deployment mode).
 *  - auth/login: the login call itself.
 *  - screenshot: requested by <img> tags, which cannot send an Authorization header,
 *    so it stays unauthenticated as before (residual: it is also an SSRF surface —
 *    tracked separately; this gate does not make it worse).
 */
const PUBLIC_API_PREFIXES = [
  '/api/health',
  '/api/app-config',
  '/api/auth/login',
  '/api/screenshot',
];

/**
 * Global gate: every /api route requires an authenticated user except the small
 * public allowlist above. Non-/api paths (static UI, /evidence) pass through untouched.
 * Register this once, after authContextMiddleware, so per-route wiring isn't needed.
 */
export function apiAuthGate(req: Request, res: Response, next: NextFunction) {
  const p = req.path;
  if (!p.startsWith('/api/')) return next();
  if (PUBLIC_API_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) return next();
  if (getAuthUser(req)) return next();
  return res.status(401).json({ error: 'Authentication required.' });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const u = getAuthUser(req);
  if (u && u.role) return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

export function registerAuthRoutes(app: Express) {
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = findByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const token = randomUUID();
    sessions.set(token, { userId: user.id, username: user.username, role: user.role });
    res.json({ token, username: user.username, role: user.role, name: user.name });
  });

  app.get('/api/auth/me', (req: Request, res: Response) => {
    const u = getAuthUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated.' });
    res.json({ authenticated: true, username: u.username, role: u.role, userId: u.userId });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = getTokenFromRequest(req);
    if (token) sessions.delete(token);
    res.json({ success: true });
  });

  /* ---------- user management (admin only) ---------- */

  app.get('/api/users', requireAdmin, (_req: Request, res: Response) => {
    res.json({ users: listUsers().map(publicUser) });
  });

  app.post('/api/users', requireAdmin, (req: Request, res: Response) => {
    const { username, name, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password are required.' });
    try {
      const u = createAppUser({ username, name, password, role });
      res.status(201).json({ ok: true, user: publicUser(u) });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || 'Could not create user.' });
    }
  });

  app.put('/api/users/:id', requireAdmin, (req: Request, res: Response) => {
    const { name, password, role } = req.body || {};
    const u = updateAppUser(req.params.id, {
      name,
      password,
      role,
    });
    if (!u) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true, user: publicUser(u) });
  });

  app.delete('/api/users/:id', requireAdmin, (req: Request, res: Response) => {
    const me = getAuthUser(req);
    if (me && me.userId === req.params.id) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    const target = getUserById(req.params.id);
    if (target?.role && listUsers().filter((x) => x.role).length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin.' });
    }
    const ok = deleteAppUser(req.params.id);
    if (!ok) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true });
  });
}
