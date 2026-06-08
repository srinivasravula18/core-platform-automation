import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID, timingSafeEqual } from 'crypto';

// App-level login gate. Credentials are configurable via env, defaulting to the
// demo account (admin / admin@2026). Tokens are issued in-memory on successful
// login and validated on /me; a backend restart simply forces a re-login.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@2026';

const activeTokens = new Set<string>();

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function getTokenFromRequest(req: Request): string {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function isAuthed(req: Request): boolean {
  const token = getTokenFromRequest(req);
  return !!token && activeTokens.has(token);
}

// Optional middleware to protect routes. Not applied globally by default so the
// demo data endpoints keep working, but available if you want to lock the API.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'Authentication required.' });
}

export function registerAuthRoutes(app: Express) {
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    if (!safeEqual(username, ADMIN_USERNAME) || !safeEqual(password, ADMIN_PASSWORD)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = randomUUID();
    activeTokens.add(token);
    res.json({ token, username });
  });

  app.get('/api/auth/me', (req: Request, res: Response) => {
    if (!isAuthed(req)) return res.status(401).json({ error: 'Not authenticated.' });
    res.json({ authenticated: true });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = getTokenFromRequest(req);
    if (token) activeTokens.delete(token);
    res.json({ success: true });
  });
}
