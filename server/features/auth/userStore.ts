/**
 * App user store — the people who log into Test Flow AI itself (distinct from the
 * `website_users` credential model, which is logins for the apps UNDER test).
 *
 * Two roles:
 *   - admin  : manages users + settings, and is a super-admin who sees ALL data.
 *   - tester : does QA work but sees ONLY their own data (per-user isolation).
 *
 * Backed by the in-memory `db.users` array (persisted to .testflow-data.json) so
 * it works without Postgres. Passwords are stored as scrypt `salt:hash` — never
 * plaintext. Seeded with an admin (from env or the demo default) and a `mark`
 * tester on first run.
 */

import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { db, persistDataInBackground } from '../../shared/storage';
import { isPostgresEnabled, query } from '../../db/pool';

export type Role = string;

export interface AppUser {
  id: string;
  username: string;
  name: string;
  passwordHash: string; // scrypt: "<saltHex>:<hashHex>"
  role: Role;
  createdAt: string;
}

function users(): AppUser[] {
  if (!Array.isArray(db.users)) db.users = [];
  return db.users as AppUser[];
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(String(plain), salt, 64);
  const known = Buffer.from(hash, 'hex');
  if (candidate.length !== known.length) return false;
  return timingSafeEqual(candidate, known);
}

export function listUsers(): AppUser[] {
  return users().slice();
}

export function findByUsername(username: string): AppUser | null {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  return users().find((x) => x.username.toLowerCase() === u) || null;
}

export function getUserById(id: string): AppUser | null {
  return users().find((x) => x.id === id) || null;
}

export function createAppUser(opts: { username: string; name?: string; password: string; role?: Role }): AppUser {
  const username = String(opts.username || '').trim();
  if (!username) throw new Error('A username is required.');
  if (!opts.password) throw new Error('A password is required.');
  if (findByUsername(username)) throw new Error(`A user named "${username}" already exists.`);
  const rec: AppUser = {
    id: `U-${randomUUID().slice(0, 8)}`,
    username,
    name: (opts.name || '').trim() || username,
    passwordHash: hashPassword(opts.password),
    role: opts.role,
    createdAt: new Date().toISOString(),
  };
  users().unshift(rec);
  persistDataInBackground('create app user');
  return rec;
}

export function updateAppUser(
  id: string,
  patch: Partial<{ name: string; password: string; role: Role }>,
): AppUser | null {
  const u = getUserById(id);
  if (!u) return null;
  if (patch.name !== undefined) u.name = patch.name;
  if (patch.role !== undefined) u.role = patch.role;
  if (patch.password) u.passwordHash = hashPassword(patch.password);
  persistDataInBackground('update app user');
  return u;
}

export function deleteAppUser(id: string): boolean {
  const before = users().length;
  db.users = users().filter((x) => x.id !== id);
  if (db.users.length < before) {
    persistDataInBackground('delete app user');
    return true;
  }
  return false;
}

/** Safe, password-free projection for API responses. */
export function publicUser(u: AppUser) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, createdAt: u.createdAt };
}

/**
 * Ensure the bootstrap accounts exist. Admin comes from env (ADMIN_USERNAME /
 * ADMIN_PASSWORD) or the demo default admin/admin@2026; `mark` is a starter tester
 * with its own (empty) data. Idempotent — only creates what's missing.
 */
export function seedAuthUsersIfEmpty(): void {
  const adminUsername = String(process.env.ADMIN_USERNAME || 'admin').trim();
  const adminPassword = String(process.env.ADMIN_PASSWORD || 'admin@2026').trim();
  if (!findByUsername(adminUsername)) {
    createAppUser({ username: adminUsername, name: 'Administrator', password: adminPassword, role: 'admin' });
  }
  // Tester seed accounts are configured per-deployment — no hardcoded defaults.
}

/**
 * Reassign ORPHANED data to the admin account so it stays visible under per-user
 * isolation. Orphaned = owner_id is NULL/'' (created before isolation) OR owner_id is
 * an id that no longer belongs to any current app user (e.g. the app-user JSON store
 * was reset and admin got a new id, leaving its websites/projects owned by the dead id).
 * Data owned by a CURRENT user (admin or a tester) is never touched, so testers keep
 * their own data. Idempotent and self-healing — runs on every startup. Covers the
 * in-memory store and Postgres.
 */
export async function claimLegacyDataForAdmin(): Promise<{ adminId: string; claimedInMemory: number } | null> {
  const admin = listUsers().find((u) => u.role);
  if (!admin) return null;
  const adminId = admin.id;
  // Ids that belong to a real current user — their data must be preserved.
  const validIds = new Set(listUsers().map((u) => u.id));
  const isOrphan = (owner: any) => !owner || !validIds.has(owner);

  // In-memory stores (projects + websites are always in-memory; QA arrays back the
  // no-Postgres mode).
  const memCollections = ['projects', 'websites', 'cases', 'runs', 'suites', 'plans', 'defects', 'scripts', 'reports', 'folders', 'requirements', 'agentRuns', 'appKnowledge'];
  let claimedInMemory = 0;
  for (const key of memCollections) {
    const arr = (db as any)[key];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      if (row && typeof row === 'object' && isOrphan(row.ownerId)) { row.ownerId = adminId; claimedInMemory += 1; }
    }
  }
  // Usage log is keyed by workspaceId (= the acting user's id). Orphaned/legacy usage
  // ('default' or a dead user id) is migrated to admin, so admin keeps the historical
  // Cost & Logs and every new profile starts at zero.
  if (Array.isArray((db as any).usageLog)) {
    for (const r of (db as any).usageLog) {
      if (r && typeof r === 'object' && (r.workspaceId === 'default' || isOrphan(r.workspaceId))) {
        r.workspaceId = adminId;
        claimedInMemory += 1;
      }
    }
  }
  if (claimedInMemory) persistDataInBackground('claim legacy data for admin');

  // Postgres scoped tables (source of truth for QA entities when DATABASE_URL is set).
  // Reassign rows that are unowned OR owned by an id that is not a current user.
  if (isPostgresEnabled()) {
    const ids = Array.from(validIds);
    const pgTables = ['plans', 'suites', 'cases', 'runs', 'defects', 'reports', 'scripts', 'folders', 'requirements', 'agent_runs', 'websites'];
    for (const t of pgTables) {
      try {
        await query(
          `UPDATE ${t} SET owner_id = $1 WHERE owner_id IS NULL OR owner_id = '' OR NOT (owner_id = ANY($2::text[]))`,
          [adminId, ids],
        );
      } catch (e: any) {
        console.error(`[claim] ${t}:`, e?.message || e);
      }
    }
  }
  return { adminId, claimedInMemory };
}
