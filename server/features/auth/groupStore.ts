/**
 * Access Groups — admin-managed permission profiles for the tool's own users.
 *
 * An admin puts non-admin app users into a named group and toggles what that group may access:
 * FEATURES (pages), PROJECTS, deployment WEBSITES, and AI PROVIDERS. A user may belong to several
 * groups; their effective access is the UNION of their groups' grants. Admins are unrestricted;
 * non-admin users in no group are denied by default until an admin assigns a group. Enforcement
 * lives at the existing resource choke points (projects/websites/providers) and
 * the nav; this module only owns the group data + the grant-resolution helpers every gate calls.
 *
 * Stored in the in-memory `db.groups` array (persisted to the JSON store / Postgres json_store like
 * every other JSON collection — see server/shared/storage.ts). Mirrors userStore.ts.
 */

import { randomUUID } from 'crypto';
import { db, persistDataInBackground } from '../../shared/storage';
import { persistGroup as persistGroupRow, deleteGroup as deleteGroupRow, persistUserGrants as persistUserGrantsRow } from './authRepo';
import type { AppUser } from './userStore';

/** Sentinel: this category grants every resource in it. `[]` = none; `[ids]` = exactly those. */
export const ALL = '*' as const;
export type GrantList = string[] | typeof ALL;

export type GrantCategory = 'features' | 'projects' | 'websites' | 'providers' | 'actions' | 'capabilities';

export interface Grants {
  features: GrantList;
  projects: GrantList;
  websites: GrantList;
  providers: GrantList;
  /** Verb-level permissions: `<resource>:<verb>` (e.g. cases:create, record-play:start). */
  actions?: GrantList;
  /** Governance switches: project:create, app:create, website:create. */
  capabilities?: GrantList;
  /** Explicit denials (deny wins over any allow during resolution). */
  denies?: GrantList;
  /** Extensibility slot for future grant categories. */
  extra?: Record<string, GrantList>;
}

export interface AccessGroup {
  id: string;
  name: string;
  description?: string;
  /** App-user ids that belong to this group (non-admin users). */
  memberUserIds: string[];
  grants: Grants;
  createdAt: string;
}

/** Fully-open access. Admins and unauthenticated/internal callers get this. */
export const UNRESTRICTED = 'UNRESTRICTED' as const;
export type EffectiveGrants = Grants | typeof UNRESTRICTED;

function groups(): AccessGroup[] {
  if (!Array.isArray(db.groups)) db.groups = [];
  return db.groups as AccessGroup[];
}

function emptyGrants(): Grants {
  return { features: [], projects: [], websites: [], providers: [] };
}

/** Normalize a client-supplied grant category into a GrantList ('*' or a clean string[]). */
function normList(value: unknown): GrantList {
  if (value === ALL) return ALL;
  if (!Array.isArray(value)) return [];
  const out = Array.from(new Set(value.map((v) => String(v || '').trim()).filter(Boolean)));
  return out;
}

function normGrants(input: any): Grants {
  const g: Grants = {
    features: normList(input?.features),
    projects: normList(input?.projects),
    websites: normList(input?.websites),
    providers: normList(input?.providers),
  };
  if (input?.actions !== undefined) g.actions = normList(input.actions);
  if (input?.capabilities !== undefined) g.capabilities = normList(input.capabilities);
  if (input?.denies !== undefined) g.denies = normList(input.denies);
  if (input?.extra && typeof input.extra === 'object') {
    g.extra = {};
    for (const [k, v] of Object.entries(input.extra)) g.extra[k] = normList(v);
  }
  return g;
}

export function listGroups(): AccessGroup[] {
  return groups().slice();
}

export function getGroup(id: string): AccessGroup | null {
  return groups().find((g) => g.id === id) || null;
}

export function createGroup(input: { name: string; description?: string; memberUserIds?: string[]; grants?: any }): AccessGroup {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('A group name is required.');
  const rec: AccessGroup = {
    id: `GRP-${randomUUID().slice(0, 8)}`,
    name,
    description: String(input.description || '').trim() || undefined,
    memberUserIds: Array.isArray(input.memberUserIds) ? Array.from(new Set(input.memberUserIds.map(String))) : [],
    grants: normGrants(input.grants),
    createdAt: new Date().toISOString(),
  };
  groups().unshift(rec);
  persistGroupRow(rec);
  persistDataInBackground('create access group');
  return rec;
}

export function updateGroup(
  id: string,
  patch: Partial<{ name: string; description: string; memberUserIds: string[]; grants: any }>,
): AccessGroup | null {
  const g = getGroup(id);
  if (!g) return null;
  if (patch.name !== undefined) g.name = String(patch.name).trim() || g.name;
  if (patch.description !== undefined) g.description = String(patch.description).trim() || undefined;
  if (patch.memberUserIds !== undefined) g.memberUserIds = Array.from(new Set((patch.memberUserIds || []).map(String)));
  if (patch.grants !== undefined) g.grants = normGrants(patch.grants);
  persistGroupRow(g);
  persistDataInBackground('update access group');
  return g;
}

export function deleteGroup(id: string): boolean {
  const before = groups().length;
  db.groups = groups().filter((g) => g.id !== id);
  if ((db.groups as AccessGroup[]).length < before) {
    deleteGroupRow(id);
    persistDataInBackground('delete access group');
    return true;
  }
  return false;
}

/** Groups a given user belongs to. */
export function groupsForUser(userId: string): AccessGroup[] {
  if (!userId) return [];
  return groups().filter((g) => Array.isArray(g.memberUserIds) && g.memberUserIds.includes(userId));
}

/** Per-user direct grant overrides (in addition to any groups), keyed by user id. */
function userGrantsMap(): Record<string, Grants> {
  if (!db.userGrants || typeof db.userGrants !== 'object') db.userGrants = {};
  return db.userGrants as Record<string, Grants>;
}

export function getUserGrants(userId: string): Grants | null {
  return userGrantsMap()[userId] || null;
}

/** Set (or clear) an individual user's direct grants. Persisted relationally + merged in resolution. */
export function setUserGrants(userId: string, grants: any): Grants {
  const g = normGrants(grants);
  userGrantsMap()[userId] = g;
  persistUserGrantsRow(userId, g);
  persistDataInBackground('set user grants');
  return g;
}

/** Union two grant lists: '*' wins; otherwise concat + dedupe. */
function unionList(a: GrantList, b: GrantList): GrantList {
  if (a === ALL || b === ALL) return ALL;
  return Array.from(new Set([...a, ...b]));
}

/**
 * The effective grants for a user, resolved live. Returns UNRESTRICTED for admins, for a user in no
 * group, and for internal/unauthenticated callers (null) — so existing behavior is preserved until an
 * admin actively groups a non-admin user. Otherwise returns the per-category UNION of their groups.
 */
export function effectiveGrantsForUser(user: AppUser | null | undefined): EffectiveGrants {
  if (!user) return UNRESTRICTED;
  if (user.role === 'admin') return UNRESTRICTED;
  const mine = groupsForUser(user.id);
  const direct = getUserGrants(user.id);
  // Non-admin access is deny-by-default. Access comes from a group membership OR a direct per-user
  // grant; effective grants are the UNION of both.
  if (mine.length === 0 && !direct) return emptyGrants();
  let acc = emptyGrants();
  for (const g of mine) acc = mergeGrants(acc, g.grants);
  if (direct) acc = mergeGrants(acc, direct);
  return acc;
}

/** Per-category UNION of two grant sets, covering every optional category (actions/capabilities/denies/extra). */
export function mergeGrants(a: Grants, b: Grants): Grants {
  const out: Grants = {
    features: unionList(a.features, b.features),
    projects: unionList(a.projects, b.projects),
    websites: unionList(a.websites, b.websites),
    providers: unionList(a.providers, b.providers),
  };
  for (const cat of ['actions', 'capabilities', 'denies'] as const) {
    if (a[cat] !== undefined || b[cat] !== undefined) out[cat] = unionList(a[cat] || [], b[cat] || []);
  }
  if (a.extra || b.extra) {
    out.extra = {};
    for (const key of new Set([...Object.keys(a.extra || {}), ...Object.keys(b.extra || {})])) {
      out.extra[key] = unionList(a.extra?.[key] || [], b.extra?.[key] || []);
    }
  }
  return out;
}

/** True when the effective grants permit `id` in the given category. UNRESTRICTED / '*' always pass. */
export function isAllowed(g: EffectiveGrants, category: GrantCategory, id: string): boolean {
  if (g === UNRESTRICTED) return true;
  const list = g[category];
  if (list === ALL) return true;
  return Array.isArray(list) && list.includes(id);
}

/** Safe projection for API responses (identical today, kept for symmetry/future secrets). */
export function publicGroup(g: AccessGroup) {
  return { id: g.id, name: g.name, description: g.description || '', memberUserIds: g.memberUserIds, grants: g.grants, createdAt: g.createdAt };
}
