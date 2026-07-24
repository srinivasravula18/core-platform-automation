import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { db, persistDataInBackground } from '../../shared/storage';
import { recordAudit } from '../../shared/recordAudit';
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
// auth/userStore.ts). Sessions are DURABLE: stored in db.sessions (persisted to the
// JSON store / Postgres json_store like every other collection) so a backend restart
// — which happens on every code change since there is no hot-reload — does NOT silently
// log everyone out. A stored session holds only { token, userId, createdAt }; the
// username/role are resolved live from the user store on each request, so a role change
// or a deleted profile takes effect immediately without a re-login.

export interface AuthUser {
  userId: string;
  username: string;
  role: Role;
}

interface StoredSession {
  token: string;
  userId: string;
  createdAt: string;
}

// Sessions expire after 30 days so durable tokens don't live forever.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sessionStore(): StoredSession[] {
  if (!Array.isArray(db.sessions)) db.sessions = [];
  return db.sessions as StoredSession[];
}

function isExpired(s: StoredSession): boolean {
  const t = Date.parse(s.createdAt || '');
  return Number.isFinite(t) && Date.now() - t > SESSION_TTL_MS;
}

function findSession(token: string): StoredSession | null {
  if (!token) return null;
  return sessionStore().find((s) => s.token === token) || null;
}

function addSession(token: string, userId: string) {
  sessionStore().unshift({ token, userId, createdAt: new Date().toISOString() });
  persistDataInBackground('create session');
}

function removeSession(token: string) {
  if (!token) return;
  db.sessions = sessionStore().filter((s) => s.token !== token);
  persistDataInBackground('delete session');
}

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
  const session = findSession(token);
  if (!session) return null;
  if (isExpired(session)) { removeSession(token); return null; }
  // Resolve identity + role LIVE from the user store so role changes / deletions apply
  // immediately. A session whose user no longer exists is treated as logged out.
  const user = getUserById(session.userId);
  if (!user) return null;
  return { userId: user.id, username: user.username, role: user.role };
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
  // Record & Play desktop agent: no human session — these authenticate via pairing/refresh
  // tokens inside the handler (see server/features/automation). Exact paths only, so the
  // rest of /api/automation/** still requires a logged-in user.
  '/api/automation/agents/register',
  '/api/automation/agents/token/refresh',
  '/api/automation/agents/heartbeat',
  // Webhook trigger authenticates by a hashed per-schedule token inside the handler.
  '/api/automation/hooks',
  // Agent version check — non-sensitive; polled by the desktop agent's updater (agent token, not human).
  '/api/automation/agent/latest',
];

/**
 * Global gate: every /api route requires an authenticated user except the small
 * public allowlist above. Non-/api paths (static UI, /evidence) pass through untouched.
 * Register this once, after authContextMiddleware, so per-route wiring isn't needed.
 */
// Agent artifact ingest (PUT /api/automation/jobs/:id/artifacts/:kind/:file) authenticates with an
// AGENT token inside the handler (requireAgent); the human-session gate would always 401 it.
const AGENT_ARTIFACT_INGEST_RE = /^\/api\/automation\/jobs\/[^/]+\/artifacts\//;

export function apiAuthGate(req: Request, res: Response, next: NextFunction) {
  const p = req.path;
  if (!p.startsWith('/api/')) return next();
  if (PUBLIC_API_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) return next();
  if (req.method === 'PUT' && AGENT_ARTIFACT_INGEST_RE.test(p)) return next();
  if (getAuthUser(req)) return next();
  return res.status(401).json({ error: 'Authentication required.' });
}

/** Admin gate: ONLY users whose role is exactly 'admin'. A 'tester' (or any other
 *  non-empty role string) must NOT pass — the previous truthy check let testers reach
 *  every admin-only route (user CRUD, etc.). */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const u = getAuthUser(req);
  if (u && u.role === 'admin') return next();
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
    addSession(token, user.id);
    res.json({ token, username: user.username, role: user.role, name: user.name });
  });

  app.get('/api/auth/me', (req: Request, res: Response) => {
    const u = getAuthUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated.' });
    res.json({ authenticated: true, username: u.username, role: u.role, userId: u.userId });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = getTokenFromRequest(req);
    removeSession(token);
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
      recordAudit('create', 'user', u.id, `Created profile "${u.username}"`);
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
    recordAudit('update', 'user', u.id, `Updated profile "${u.username}"`);
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
    recordAudit('delete', 'user', req.params.id, `Deleted profile "${target?.username || req.params.id}"`);
    res.json({ ok: true });
  });
}
