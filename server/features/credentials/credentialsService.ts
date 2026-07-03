/**
 * Multi-website, multi-user credential model.
 *
 * The old model (a flat list of {site, username, password, environment}) made
 * it impossible to model real apps that have multiple user roles per site
 * or to scope credentials to environments. The agent had to guess which row to use.
 *
 * The new model:
 *
 *   Website (parent)
 *     id, name, baseUrl, environment, description, tags
 *     ↓
 *   User (child of Website)
 *     id, websiteId, label, username, password, role, notes
 *
 * Agents pick the right credential by either:
 *   - Explicit selection (request body `credentialUserId`)
 *   - Role match (request body `credentialRole` matches a stored role)
 *   - First user on the matching website (fallback)
 *
 * Passwords are stored encrypted at rest using AES-256-GCM with a key derived
 * from `process.env.CRED_ENC_KEY` (32 bytes). If the env var is missing the
 * service falls back to a deterministic dev key and logs a warning at startup.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'crypto';
import { db } from '../../shared/storage';
import type { AgentRunCredentials } from './types';

// Derive the key LAZILY (on first encrypt/decrypt), NOT at module load. server.ts runs
// dotenv.config() AFTER its imports evaluate, so reading CRED_ENC_KEY at module-load time misses
// .env.local and silently falls back to the empty dev key — which then FAILS to decrypt passwords
// that were encrypted with the real key ("No credentials resolved"). First use happens at request
// time, after env is loaded, so the real key is picked up.
let cachedEncKey: Buffer | null = null;
function encKey(): Buffer {
  if (cachedEncKey) return cachedEncKey;
  const raw = process.env.CRED_ENC_KEY;
  if (raw) {
    cachedEncKey = scryptSync(raw, process.env.CRED_ENC_SALT || '', 32);
    return cachedEncKey;
  }
  if (!process.env.CRED_DEV_KEY_WARNING_SHOWN) {
    console.warn('[credentials] CRED_ENC_KEY is not set — encryption is unavailable until configured.');
    process.env.CRED_DEV_KEY_WARNING_SHOWN = '1';
  }
  cachedEncKey = scryptSync(process.env.CRED_ENC_FALLBACK_KEY || '', process.env.CRED_ENC_SALT || '', 32);
  return cachedEncKey;
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${enc.toString('base64')}.${tag.toString('base64')}`;
}

function decrypt(payload: string): string {
  const [ivB64, encB64, tagB64] = payload.split('.');
  if (!ivB64 || !encB64 || !tagB64) throw new Error('Invalid encrypted payload');
  const iv = Buffer.from(ivB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export interface Website {
  id: string;
  name: string;
  baseUrl: string;
  environment: 'dev' | 'staging' | 'prod' | 'local' | 'preview';
  description: string;
  tags: string[];
  /** App user who owns this website + its logins (per-user isolation). '' = legacy/admin. */
  ownerId?: string;
  createdAt: string;
}

export interface WebsiteUser {
  id: string;
  websiteId: string;
  label: string;
  username: string;
  passwordEnc: string;
  role: string;
  customRole?: string;
  notes: string;
  /** Optional child-page name this login is for (e.g. "Admin portal"). */
  pageName?: string;
  /** Optional child-page URL/path; defaults to the website base URL when empty. */
  pageUrl?: string;
  createdAt: string;
}

export interface ResolvedCredential extends AgentRunCredentials {
  source: 'user' | 'website-default' | 'env' | 'request-body';
  websiteId: string;
  userId: string;
  websiteName: string;
  role: string;
}

function ensureTables() {
  if (!db.websites) (db as any).websites = [];
  if (!db.websiteUsers) (db as any).websiteUsers = [];
}

function persistWebsiteAsync(w: Website) {
  import('../../db/repository').then(({ Websites: WebsitesRepo, isPgEnabled }) => {
    if (!isPgEnabled()) return;
    WebsitesRepo.upsert(w).catch((err) => console.error('[pg] website persist failed:', err?.message || err));
  });
}

function persistUserAsync(u: WebsiteUser) {
  import('../../db/repository').then(({ WebsiteUsers: UsersRepo, isPgEnabled }) => {
    if (!isPgEnabled()) return;
    UsersRepo.upsert(u).catch((err) => console.error('[pg] user persist failed:', err?.message || err));
  });
}

function removeWebsiteAsync(id: string) {
  import('../../db/repository').then(({ Websites: WebsitesRepo, isPgEnabled }) => {
    if (!isPgEnabled()) return;
    WebsitesRepo.remove(id).catch((err) => console.error('[pg] website delete failed:', err?.message || err));
  });
}

function removeUserAsync(id: string) {
  import('../../db/repository').then(({ WebsiteUsers: UsersRepo, isPgEnabled }) => {
    if (!isPgEnabled()) return;
    UsersRepo.remove(id).catch((err) => console.error('[pg] user delete failed:', err?.message || err));
  });
}

export async function hydrateFromPg(): Promise<{ websites: number; users: number }> {
  const { Websites: WebsitesRepo, WebsiteUsers: UsersRepo, isPgEnabled } = await import('../../db/repository');
  if (!isPgEnabled()) return { websites: 0, users: 0 };
  const [websites, users] = await Promise.all([WebsitesRepo.list(), UsersRepo.list()]);
  ensureTables();
  (db as any).websites = websites;
  (db as any).websiteUsers = users;
  return { websites: websites.length, users: users.length };
}

export function listWebsites(): Website[] {
  ensureTables();
  return (db.websites as any[]).slice();
}

export function getWebsite(id: string): Website | null {
  ensureTables();
  return (db.websites as any[]).find((w) => w.id === id) || null;
}

export function listUsersForWebsite(websiteId: string): WebsiteUser[] {
  ensureTables();
  return (db.websiteUsers as any[]).filter((u) => u.websiteId === websiteId);
}

export function getUser(id: string): WebsiteUser | null {
  ensureTables();
  return (db.websiteUsers as any[]).find((u) => u.id === id) || null;
}

export function createWebsite(opts: Omit<Website, 'id' | 'createdAt'> & { id?: string }): Website {
  ensureTables();
  const rec: Website = {
    id: opts.id || `WEB-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    name: opts.name,
    baseUrl: opts.baseUrl,
    environment: opts.environment || 'staging',
    description: opts.description || '',
    tags: opts.tags || [],
    ownerId: opts.ownerId || '',
    createdAt: new Date().toISOString(),
  };
  (db.websites as any[]).unshift(rec);
  persistWebsiteAsync(rec);
  return rec;
}

export function updateWebsite(id: string, patch: Partial<Website>): Website | null {
  ensureTables();
  const w = (db.websites as any[]).find((x) => x.id === id);
  if (!w) return null;
  Object.assign(w, patch);
  persistWebsiteAsync(w);
  return w;
}

export function deleteWebsite(id: string): boolean {
  ensureTables();
  const users = listUsersForWebsite(id);
  users.forEach((u) => deleteUser(u.id));
  const before = (db.websites as any[]).length;
  (db as any).websites = (db.websites as any[]).filter((w) => w.id !== id);
  removeWebsiteAsync(id);
  return (db.websites as any[]).length < before;
}

export function createUser(opts: {
  websiteId: string;
  label: string;
  username: string;
  password: string;
  role: WebsiteUser['role'];
  customRole?: string;
  notes?: string;
  pageName?: string;
  pageUrl?: string;
}): WebsiteUser {
  ensureTables();
  const website = getWebsite(opts.websiteId);
  if (!website) throw new Error(`Website ${opts.websiteId} not found`);
  const rec: WebsiteUser = {
    id: `USR-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    websiteId: opts.websiteId,
    label: opts.label,
    username: opts.username,
    passwordEnc: encrypt(opts.password),
    role: opts.role,
    customRole: opts.customRole,
    notes: opts.notes || '',
    pageName: opts.pageName || '',
    pageUrl: opts.pageUrl || '',
    createdAt: new Date().toISOString(),
  };
  (db.websiteUsers as any[]).unshift(rec);
  persistUserAsync(rec);
  return rec;
}

export function updateUser(id: string, patch: Partial<{ label: string; username: string; password: string; role: WebsiteUser['role']; customRole: string; notes: string; pageName: string; pageUrl: string }>): WebsiteUser | null {
  ensureTables();
  const u = (db.websiteUsers as any[]).find((x) => x.id === id);
  if (!u) return null;
  if (patch.label !== undefined) u.label = patch.label;
  if (patch.username !== undefined) u.username = patch.username;
  if (patch.password !== undefined && patch.password.length > 0) u.passwordEnc = encrypt(patch.password);
  if (patch.role !== undefined) u.role = patch.role;
  if (patch.customRole !== undefined) u.customRole = patch.customRole;
  if (patch.notes !== undefined) u.notes = patch.notes;
  if (patch.pageName !== undefined) u.pageName = patch.pageName;
  if (patch.pageUrl !== undefined) u.pageUrl = patch.pageUrl;
  persistUserAsync(u);
  return u;
}

export function deleteUser(id: string): boolean {
  ensureTables();
  const u = (db.websiteUsers as any[]).find((x) => x.id === id);
  if (u) removeUserAsync(u.id);
  const before = (db.websiteUsers as any[]).length;
  (db as any).websiteUsers = (db.websiteUsers as any[]).filter((u) => u.id !== id);
  return (db.websiteUsers as any[]).length < before;
}

export function revealPassword(userId: string): string {
  const u = getUser(userId);
  if (!u) throw new Error(`User ${userId} not found`);
  return decrypt(u.passwordEnc);
}

export interface ResolveOptions {
  /** Explicit user id (highest priority) */
  userId?: string;
  /** Match by role on the resolved website */
  role?: string;
  /** Match by websiteId */
  websiteId?: string;
  /** Match by website name (case-insensitive) */
  websiteName?: string;
  /** Match by base URL hostname */
  baseUrl?: string;
  /** Plain credentials supplied in the request body (e.g. from chat) */
  inline?: { username?: string; password?: string; siteName?: string };
  /** Target URL to extract hostname from for website auto-match */
  targetUrl?: string;
  /** Restrict resolution to a single app user's own websites (per-user isolation). */
  ownerId?: string;
}

/** host:port key for a URL, defaulting the port so http/https compare sensibly. */
function hostPortKey(url: string): string {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname.toLowerCase()}:${port}`;
  } catch {
    return '';
  }
}

function hostKey(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * Match a website by URL. Prefer an EXACT host:port match so different ports on the
 * same host never collide — e.g. two different apps on localhost with different ports
 * used to both resolve to host "localhost" and pick whichever website was first,
 * handing a run the WRONG credentials. Fall back to hostname-only for setups that
 * registered a base URL without a port.
 */
function matchWebsiteByUrl(sites: Website[], url: string): Website | null {
  const hp = hostPortKey(url);
  if (hp) {
    const exact = sites.find((w) => hostPortKey(w.baseUrl) === hp);
    if (exact) return exact;
  }
  const h = hostKey(url);
  if (h) {
    const byHost = sites.find((w) => hostKey(w.baseUrl) === h);
    if (byHost) return byHost;
  }
  return null;
}

export function resolveCredentials(opts: ResolveOptions): ResolvedCredential | null {
  ensureTables();
  const inline = opts.inline || {};
  // Per-user isolation: when an owner is given, a run may only resolve against that
  // user's own websites/logins (never another user's credentials).
  const ownerOk = (w: any) => !opts.ownerId || (w?.ownerId || '') === opts.ownerId;
  const sites = (db.websites as any[]).filter(ownerOk);

  if (opts.userId) {
    const u = getUser(opts.userId);
    if (u) {
      const w = getWebsite(u.websiteId);
      if (w && ownerOk(w)) return toResolved(u, w, 'user');
    }
  }

  let website: Website | null = null;
  if (opts.websiteId) {
    const w = getWebsite(opts.websiteId);
    website = w && ownerOk(w) ? w : null;
  }
  if (!website && opts.websiteName) {
    const name = opts.websiteName.toLowerCase();
    website = sites.find((w) => w.name.toLowerCase().includes(name)) || null;
  }
  if (!website && opts.baseUrl) website = matchWebsiteByUrl(sites, opts.baseUrl);
  if (!website && opts.targetUrl) website = matchWebsiteByUrl(sites, opts.targetUrl);
  if (!website && inline.siteName) {
    const name = inline.siteName.toLowerCase();
    website = sites.find((w) => w.name.toLowerCase().includes(name)) || null;
  }
  if (!website && inline.username) {
    const users = (db.websiteUsers as any[]).filter((u) => u.username === inline.username);
    for (const u of users) {
      const w = getWebsite(u.websiteId);
      if (w && ownerOk(w)) return toResolved(u, w, 'website-default');
    }
  }
  if (!website) return null;

  const users = listUsersForWebsite(website.id);
  if (users.length === 0) return null;

  if (opts.role) {
    const wanted = opts.role.toLowerCase();
    const match = users.find((u) => u.role.toLowerCase() === wanted || (u.customRole || '').toLowerCase() === wanted);
    if (match) return toResolved(match, website, 'website-default');
  }
  const first = users[0];
  return toResolved(first, website, 'website-default');
}

function toResolved(u: WebsiteUser, w: Website, source: ResolvedCredential['source']): ResolvedCredential {
  let password = '';
  try {
    password = decrypt(u.passwordEnc);
  } catch {
    // The stored ciphertext can't be decrypted with the current CRED_ENC_KEY — the key changed or
    // the data was copied from another environment. Surface it loudly and name the site/user: a
    // silent empty password otherwise masquerades downstream as the confusing "No credentials
    // resolved for this context." The fix is to RE-SAVE the password (which re-encrypts with the
    // current key) — a blank field on edit keeps the old broken ciphertext.
    console.warn(`[credentials] Password for "${w.name}" (user ${u.username}) could not be decrypted — re-save it in Settings → Credentials (the encryption key changed).`);
    password = '';
  }
  return {
    source,
    websiteId: w.id,
    userId: u.id,
    websiteName: w.name,
    role: u.customRole || u.role,
    username: u.username,
    password,
    siteName: w.name,
    baseUrl: w.baseUrl,
    environment: w.environment,
  };
}

export function maskPassword(password: string): string {
  if (!password) return '';
  if (password.length <= 4) return '****';
  return password.slice(0, 2) + '****' + password.slice(-2);
}
