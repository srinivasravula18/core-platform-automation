/**
 * Relational persistence for identity + RBAC. Postgres is the source of truth; the in-memory
 * db.users/db.sessions/db.groups arrays (and the rbac caches below) are a write-through cache so
 * the synchronous auth path stays synchronous. Writes are fire-and-forget but serialized per a
 * single chain so rapid mutations can't interleave. When Postgres is off (DISABLE_POSTGRES
 * sandbox) every function no-ops and the callers fall back to the JSON file via storage.ts.
 *
 * Group grants are stored NORMALIZED as rbac_grants rows (never a JSON blob) — one row per granted
 * token, encoded `<category>:<value>` (e.g. feature:cases, action:cases:create, capability:project:create,
 * project:*, website:<id>). Hydration rebuilds the Grants object from those rows.
 */

import { db } from '../../shared/storage';
import { isPostgresEnabled, query, uid } from '../../db/pool';
import { PERMISSION_CATALOG, presetPermissions } from './permissions';
import type { GrantList, Grants, AccessGroup } from './groupStore';

let writeChain: Promise<void> = Promise.resolve();
/** Serialize async writes so fire-and-forget calls never interleave a partial group rewrite. */
function enqueue(reason: string, fn: () => Promise<void>): void {
  if (!isPostgresEnabled()) return;
  writeChain = writeChain.catch(() => {}).then(fn).catch((e) => console.error(`[rbac] persist ${reason} failed:`, e?.message || e));
}

/* ---------- grant token <-> Grants object ---------- */

const CATEGORY_FIELD: Record<string, keyof Grants> = {
  feature: 'features', project: 'projects', website: 'websites', provider: 'providers',
  action: 'actions', capability: 'capabilities', deny: 'denies',
};
const FIELD_CATEGORY: Partial<Record<keyof Grants, string>> = {
  features: 'feature', projects: 'project', websites: 'website', providers: 'provider',
  actions: 'action', capabilities: 'capability', denies: 'deny',
};

/** Flatten a Grants object into `<category>:<value>` tokens (a lone '*' becomes `<category>:*`). */
function grantsToTokens(grants: Grants): string[] {
  const out: string[] = [];
  for (const [field, cat] of Object.entries(FIELD_CATEGORY)) {
    const list = (grants as any)[field] as GrantList | undefined;
    if (list === undefined) continue;
    if (list === '*') { out.push(`${cat}:*`); continue; }
    for (const v of list) out.push(`${cat}:${v}`);
  }
  return out;
}

/** Rebuild a Grants object from `<category>:<value>` tokens. */
function tokensToGrants(tokens: string[]): Grants {
  const g: Grants = { features: [], projects: [], websites: [], providers: [] };
  for (const tok of tokens) {
    const i = tok.indexOf(':');
    if (i < 0) continue;
    const field = CATEGORY_FIELD[tok.slice(0, i)];
    if (!field) continue;
    const value = tok.slice(i + 1);
    const cur = (g as any)[field] as GrantList | undefined;
    if (value === '*') { (g as any)[field] = '*'; continue; }
    if (cur === '*') continue;
    ((g as any)[field] ||= []).push(value);
  }
  return g;
}

/* ---------- users ---------- */

export function persistUser(u: any): void {
  enqueue('user', async () => {
    await query(
      `INSERT INTO users (id, username, email, name, password_hash, role, created_at)
       VALUES ($1,$2,NULL,$3,$4,$5, COALESCE($6, now()))
       ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, name=EXCLUDED.name,
         password_hash=EXCLUDED.password_hash, role=EXCLUDED.role`,
      [u.id, u.username, u.name || u.username, u.passwordHash, u.role ?? null, u.createdAt || null],
    );
  });
}

export function deleteUser(id: string): void {
  enqueue('delete user', async () => { await query('DELETE FROM users WHERE id = $1', [id]); });
}

/* ---------- sessions ---------- */

export function persistSession(s: { token: string; userId: string; createdAt: string }): void {
  enqueue('session', async () => {
    // FK-safe: skip a session whose user no longer exists rather than aborting the write chain.
    await query(
      `INSERT INTO sessions (id, user_id, token, expires_at, created_at)
       SELECT $1,$2,$3, COALESCE($4::timestamptz, now()) + interval '30 days', COALESCE($4::timestamptz, now())
       WHERE EXISTS (SELECT 1 FROM users WHERE id = $2)
       ON CONFLICT (token) DO NOTHING`,
      [uid('SES'), s.userId, s.token, s.createdAt || null],
    );
  });
}

export function deleteSession(token: string): void {
  enqueue('delete session', async () => { await query('DELETE FROM sessions WHERE token = $1', [token]); });
}

/* ---------- groups (+ members + normalized grants) ---------- */

export function persistGroup(g: AccessGroup): void {
  enqueue('group', async () => {
    await query(
      `INSERT INTO rbac_groups (id, name, description, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, updated_at=now()`,
      [g.id, g.name, g.description || ''],
    );
    await query('DELETE FROM rbac_group_members WHERE group_id = $1', [g.id]);
    for (const userId of g.memberUserIds || []) {
      await query('INSERT INTO rbac_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.id, userId]);
    }
    await query(`DELETE FROM rbac_grants WHERE principal_type='group' AND principal_id=$1`, [g.id]);
    for (const token of grantsToTokens(g.grants)) {
      await query(
        `INSERT INTO rbac_grants (id, principal_type, principal_id, permission_id, effect)
         VALUES ($1,'group',$2,$3,'allow') ON CONFLICT DO NOTHING`,
        [uid('GRT'), g.id, token],
      );
    }
  });
}

export function deleteGroup(id: string): void {
  enqueue('delete group', async () => { await query('DELETE FROM rbac_groups WHERE id = $1', [id]); });
}

/* ---------- per-user direct grants (overrides) ---------- */

export function persistUserGrants(userId: string, grants: Grants): void {
  enqueue('user grants', async () => {
    await query(`DELETE FROM rbac_grants WHERE principal_type='user' AND principal_id=$1`, [userId]);
    for (const token of grantsToTokens(grants)) {
      await query(
        `INSERT INTO rbac_grants (id, principal_type, principal_id, permission_id, effect)
         VALUES ($1,'user',$2,$3,'allow') ON CONFLICT DO NOTHING`,
        [uid('GRT'), userId, token],
      );
    }
  });
}

/* ---------- audit ---------- */

export function writeAudit(entry: {
  actorId?: string; event: string; principalType?: string; principalId?: string;
  permissionId?: string; decision?: string; detail?: any;
}): void {
  enqueue('audit', async () => {
    await query(
      `INSERT INTO rbac_audit (id, actor_id, event, principal_type, principal_id, permission_id, decision, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [uid('RAU'), entry.actorId || null, entry.event, entry.principalType || null, entry.principalId || null,
       entry.permissionId || null, entry.decision || null, JSON.stringify(entry.detail || {})],
    );
  });
}

/* ---------- catalog + preset roles (seeded from code, idempotent) ---------- */

const SYSTEM_ROLES: Array<{ id: string; name: string; tier: 'read-only' | 'editor' | 'full' }> = [
  { id: 'role-readonly', name: 'Read-only', tier: 'read-only' },
  { id: 'role-editor', name: 'Editor', tier: 'editor' },
  { id: 'role-full', name: 'Full access', tier: 'full' },
];

/** Upsert the permission catalog + system role presets into SQL. Runs each startup. */
export async function seedRbacCatalog(): Promise<void> {
  if (!isPostgresEnabled()) return;
  for (const p of PERMISSION_CATALOG) {
    await query(
      `INSERT INTO rbac_permissions (id, resource, action, category, label) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET resource=EXCLUDED.resource, action=EXCLUDED.action, category=EXCLUDED.category, label=EXCLUDED.label`,
      [p.id, p.resource, p.action, p.category, p.label],
    );
  }
  for (const r of SYSTEM_ROLES) {
    await query(
      `INSERT INTO rbac_roles (id, name, description, is_system, updated_at) VALUES ($1,$2,$3,true, now())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, is_system=true, updated_at=now()`,
      [r.id, r.name, `${r.name} preset`],
    );
    await query('DELETE FROM rbac_role_permissions WHERE role_id=$1', [r.id]);
    for (const pid of presetPermissions(r.tier)) {
      await query(`INSERT INTO rbac_role_permissions (role_id, permission_id, effect) VALUES ($1,$2,'allow') ON CONFLICT DO NOTHING`, [r.id, pid]);
    }
  }
}

/* ---------- hydration + one-time backfill ---------- */

/**
 * Load users/sessions/groups from relational tables into the in-memory cache. On first boot after
 * this migration the tables are empty, so we backfill them from whatever the JSON store already
 * hydrated into db.* (json_store blob or legacy file) — no account, session, or group is lost.
 */
export async function hydrateAuthFromPg(): Promise<void> {
  if (!isPostgresEnabled()) return;

  // One-time backfill from the prior JSON store, PER ENTITY. In PG mode users/sessions/groups lived
  // as json_store blobs (loadPersistedData() no-ops under PG), so read those directly; fall back to the
  // in-memory cache. Each table is gated on ITS OWN emptiness — never on the users count — so a
  // pre-seeded admin can't block the group/session migration (which would silently orphan real data).
  const blobs = await query<{ key: string; value: any }>(
    `SELECT key, value FROM json_store WHERE key IN ('users','sessions','groups')`,
  );
  const byKey = new Map(blobs.map((r) => [r.key, r.value]));
  const priorUsers = (byKey.get('users') as any[]) || (Array.isArray(db.users) ? db.users : []);
  const priorSessions = (byKey.get('sessions') as any[]) || (Array.isArray(db.sessions) ? db.sessions : []);
  const priorGroups = (byKey.get('groups') as any[]) || (Array.isArray(db.groups) ? db.groups : []);
  const count = async (sql: string) => Number((await query<{ n: string }>(sql))[0]?.n || 0);

  let migrated = false;
  if (await count('SELECT count(*)::int AS n FROM users WHERE username IS NOT NULL') === 0 && priorUsers.length) {
    for (const u of priorUsers) persistUser(u); migrated = true;
    await writeChain; // users must land before sessions/members reference them
  }
  if (await count('SELECT count(*)::int AS n FROM rbac_groups') === 0 && priorGroups.length) {
    for (const g of priorGroups) persistGroup(g); migrated = true;
  }
  if (await count('SELECT count(*)::int AS n FROM sessions') === 0 && priorSessions.length) {
    for (const s of priorSessions) persistSession(s); migrated = true;
  }
  if (migrated) {
    await writeChain;
    console.log(`[rbac] backfilled ${priorUsers.length} user(s), ${priorGroups.length} group(s), ${priorSessions.length} session(s) into relational tables`);
  }

  // Users
  const users = await query<any>('SELECT id, username, name, password_hash, role, created_at FROM users WHERE username IS NOT NULL');
  db.users = users.map((r) => ({
    id: r.id, username: r.username, name: r.name || r.username,
    passwordHash: r.password_hash, role: r.role ?? undefined,
    createdAt: (r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)),
  }));

  // Sessions (drop expired on load)
  const sessions = await query<any>(`SELECT token, user_id, created_at FROM sessions WHERE expires_at > now()`);
  db.sessions = sessions.map((r) => ({
    token: r.token, userId: r.user_id,
    createdAt: (r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)),
  }));

  // Groups (+ members + grants)
  const groups = await query<any>('SELECT id, name, description, created_at FROM rbac_groups');
  const members = await query<any>('SELECT group_id, user_id FROM rbac_group_members');
  const grantRows = await query<any>(`SELECT principal_id, permission_id FROM rbac_grants WHERE principal_type='group'`);
  const membersByGroup = new Map<string, string[]>();
  for (const m of members) (membersByGroup.get(m.group_id) || membersByGroup.set(m.group_id, []).get(m.group_id)!).push(m.user_id);
  const tokensByGroup = new Map<string, string[]>();
  for (const r of grantRows) (tokensByGroup.get(r.principal_id) || tokensByGroup.set(r.principal_id, []).get(r.principal_id)!).push(r.permission_id);
  db.groups = groups.map((r) => ({
    id: r.id, name: r.name, description: r.description || undefined,
    memberUserIds: membersByGroup.get(r.id) || [],
    grants: tokensToGrants(tokensByGroup.get(r.id) || []),
    createdAt: (r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)),
  }));

  // Per-user direct grants (overrides), keyed by user id.
  const userGrantRows = await query<any>(`SELECT principal_id, permission_id FROM rbac_grants WHERE principal_type='user'`);
  const tokensByUser = new Map<string, string[]>();
  for (const r of userGrantRows) (tokensByUser.get(r.principal_id) || tokensByUser.set(r.principal_id, []).get(r.principal_id)!).push(r.permission_id);
  const userGrants: Record<string, Grants> = {};
  for (const [userId, toks] of tokensByUser) userGrants[userId] = tokensToGrants(toks);
  db.userGrants = userGrants;

  console.log(`[rbac] hydrated ${db.users.length} user(s), ${db.sessions.length} session(s), ${db.groups.length} group(s), ${Object.keys(userGrants).length} user-override(s) from relational tables`);
}
