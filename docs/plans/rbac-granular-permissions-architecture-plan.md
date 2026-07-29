# Granular RBAC & Permission Profiles — Architecture Plan (Phase 0)

**Status:** Analysis only. No code changed. Awaiting explicit approval on a later turn before any implementation.
**Author role:** Principal Architect (per `CLAUDE.md` architecture-change process).
**Scope of request:** Turn the existing page-level "Access Groups" into a bank-grade, server-enforced, granular RBAC system supporting: read-only vs partial vs full access; per-**user** and per-**group** grants; action/button-level permissions (e.g. "only one person gets Record & Play"); and admin-configurable capabilities ("may this person create new projects / new URLs").

---

## 1. Executive Summary

The application already ships two-thirds of the requested feature and doesn't know it. `server/features/auth/groupStore.ts` defines an **Access-Group grant model** (`features / projects / websites / providers`, each `'*'` or an id list, deny-by-default, union-of-groups), an admin UI (`src/pages/Settings.tsx` → Profiles tab), and delivery to the client via `/api/auth/login` + `/api/auth/me`. What is missing is exactly the three things you asked for, and one of them is a genuine security hole:

1. **Enforcement is client-side only for pages/features.** `FeatureGuard` (`src/App.tsx`) and the sidebar hide pages, but **no server route consults the `features` grant.** A user denied "Test Cases" in the UI can still `POST /api/cases`. Grants are, today, cosmetic for everything except `projects` / `websites` / `providers` (which *are* checked inside a few handlers).
2. **No action/verb granularity.** Grants are all-or-nothing per resource id. There is no read-vs-write, no create/update/delete/execute distinction, and no way to grant a single button such as Record & Play.
3. **No "can create" capability.** `POST /api/projects` and `POST /api/projects/:id/apps` require only a login; any user creates projects/URLs. There is no admin switch to govern this.

The plan closes all three with a **single centralized server-side authorization gate** (mirroring the existing `apiAuthGate`), an **extended grant model** carrying `actions` + `capabilities` + **per-user overrides**, **role presets** (Read-only / Editor / Full / custom), matching **Settings UI + button gating**, and — as the bank-grade durable layer — a **normalized SQL RBAC store with an audit trail**. Enforcement ships behind a feature flag (`RBAC_ENFORCEMENT_V1`) so it can be validated before it can ever lock a real user out.

**Recommendation:** implement in the phase order in §20. Phases 1–2 deliver the working, enforced feature on the existing JSON grant store (fast, low risk, reversible). Phase 3 migrates the grant store to normalized SQL with auditing (the "for banks / DB architecture" durability). Phase 4 (optional) adds project/app-scoped roles and delegated admin.

---

## 2. Existing Architecture

**Runtime shape (verified):**
- **Backend:** Express, single flat root app. Entry `server.ts` → `apps/api/src/server.ts` (`createExpressApp` `:61-169`, `startExpressServer` `:171-189`, port `3001`). No `express.Router()` sub-mounts; every feature calls `register<Feature>Routes(app)` and attaches absolute `/api/...` paths (`apps/api/src/server.ts:141-160`). **No hot reload** — backend must be restarted after any `server/**` change.
- **Frontend:** Vite + React + React Router in `src/`. Routes at `src/App.tsx:378-420`; sidebar nav at `:57-104`.
- **DB:** PostgreSQL via `pg` Pool (`server/db/pool.ts`). `server/db/schema.sql` is the single, idempotent source re-run on every startup (`pool.ts:62-75`); no migrations directory. `DISABLE_POSTGRES=true` falls back to an in-memory JSON store (`server/shared/storage.ts`).

**Auth / identity (verified):**
- Users, sessions, and groups live in the **JSON collection store** (`db.users`, `db.sessions`, `db.groups`), persisted to Postgres `json_store` when the DB is on. The `users` / `sessions` **tables in `schema.sql:407,417` are vestigial** — the running code does not use them.
- Middleware order (`apps/api/src/server.ts:115-122`): `express.json` → `authContextMiddleware` (sets `req.authUser = {userId, username, role}`, resolved **live** from the user store per request) → `apiAuthGate` (global 401 for `/api/*` minus a public allowlist) → `scopeMiddleware` (sets `req.scope`) → `runWithActor` → routes.
- Role helpers: `requireAuth` (401) and `requireAdmin` (403 unless `role === 'admin'`), the latter applied **only** to `/api/users*` and `/api/groups*`.

**Grant model (verified, `groupStore.ts`):**
- `Grants { features, projects, websites, providers, extra? }`; `GrantList = string[] | '*'`.
- `effectiveGrantsForUser(user)`: admin ⇒ `UNRESTRICTED`; non-admin in **no** group ⇒ empty grants (deny-all); else per-category **union** of the user's groups. Note: the union loop **drops `extra`** today (`:151-159`).
- `isAllowed(grants, category, id)`; `reqGrants(req)` / `reqScope(req)` in `server/shared/scope.ts`.
- Client mirror: `src/lib/features.ts` (`FEATURES` catalog of 15 pages, `grantAllows` fail-closed), `src/components/AuthGate.tsx` (`getGrants`/`isAdmin`), `src/App.tsx` (`FeatureGuard`, sidebar filter).

---

## 3. Dependency Graph

```
                    apps/api/src/server.ts  (middleware chain + register*Routes)
                              │
        ┌─────────────────────┼───────────────────────────────┐
        ▼                     ▼                                ▼
 auth/routes.ts        shared/scope.ts                  feature route files (19)
 (authContext,        (reqScope, reqGrants,             projects, credentials, resources,
  apiAuthGate,         scopeFilter, scopeStamp)          agent, automation, playwright, ...)
  requireAdmin)             │                                  │
        │                   │                                  │ call isAllowed() today ONLY in:
        ▼                   ▼                                  ▼ projects/routes.ts, credentials/routes.ts,
   userStore.ts        groupStore.ts  ◄──────────────────────── ai/orchestrator.ts
   (AppUser, roles)    (Grants, effectiveGrantsForUser, isAllowed)
        │                   │
        └──────► db.users / db.groups (JSON collection → json_store / storage.ts)

Client:  AuthGate.tsx ──► lib/features.ts (grantAllows) ──► App.tsx (FeatureGuard, Sidebar)
         Settings.tsx (Profiles: People + Access Groups editor) ──► /api/users, /api/groups
```

The RBAC subsystem's blast radius is narrow: `groupStore.ts` + `scope.ts` are the only server modules the whole app already routes authorization through, and the new gate mounts at one line in `server.ts`. That is why this is a low-risk, additive change rather than a rewrite.

---

## 4. Runtime Flow (current)

1. Request → `authContextMiddleware` resolves session token → `req.authUser`.
2. `apiAuthGate` → 401 unless authed or path is on `PUBLIC_API_PREFIXES` / agent-token allowlist.
3. `scopeMiddleware` → `req.scope` from `X-Project-Id` / `X-App-Id` + `req.authUser`.
4. Route handler runs. For most resources, authorization = **owner isolation only** (`scopeFilter` by `ownerId`). For `projects` / `websites` / `providers`, the handler *also* calls `isAllowed(reqGrants(req), category, id)`.
5. Client independently hides nav / redirects routes via `grantAllows`.

**The authorization gap** is the whole space between steps 3 and 4: there is no general permission decision — only owner isolation and three hand-placed grant checks.

## 5. Evidence / Data Flow (grants)

`db.groups` (JSON) → `effectiveGrantsForUser` → `reqGrants(req)` (server) **and** `/api/auth/me` → `AuthGate` cache → `grantAllows` (client). New grant categories flow through the exact same two channels — no new transport.

## 6. Context Flow

`req.authUser` + `req.scope` already carry everything the gate needs (userId, role, projectId, appId). The new gate reads them plus `reqGrants(req)`; it introduces no new request context.

## 7. Prompt Flow

Not applicable — RBAC does not touch LLM prompt assembly. (Noted to satisfy the standard template; no prompt files change.)

---

## 8. Current Problems

| # | Problem | Evidence | Severity |
|---|---|---|---|
| P1 | Page/feature grants **not enforced server-side** — direct API calls bypass them | no `features` check in any route; `apiAuthGate` only checks *authenticated* | **Critical (security)** |
| P2 | No action/verb granularity (read/create/update/delete/execute) | `Grants` categories are per-id only | High |
| P3 | No button-level grant (e.g. Record & Play to one person) | `/api/playwright/codegen/*` has no grant check | High |
| P4 | No "can create project / URL" capability; creation open to all | `POST /api/projects` requires only auth | High |
| P5 | Only `admin` vs non-admin; no roles / presets | `role` is a free string, only `'admin'` checked | Medium |
| P6 | No per-**user** grants; only per-group | `AccessGroup.memberUserIds` only | Medium |
| P7 | No authorization audit trail | no rbac audit table/log | Medium (bank req.) |
| P8 | `effectiveGrantsForUser` silently drops the `extra` slot | `groupStore.ts:151-159` | Low (latent bug) |
| P9 | Enabling enforcement could 403 existing grouped testers who relied on client-only gating | deny-by-default union | Migration risk |

## 9. Root Cause Analysis

The grant system was designed as a **navigation-shaping** feature, not an **authorization** feature: it was only ever consulted where a handler already had to load a resource to check ownership (projects/websites/providers). Nobody added a general gate because owner-isolation was "good enough" to keep users out of each other's data. The request now demands *intra-user* and *intra-group* differentiation (who may push which button), which owner-isolation cannot express. The fix is therefore not to patch handlers but to add the missing **authorization layer** the architecture never had, and to give the grant vocabulary the **verbs** it never had.

---

## 10. Proposed Architecture

### 10.1 Permission taxonomy (single source of truth)

A permission is `resource:action`. Resources map 1:1 onto the existing REST families (already clean); actions onto HTTP verbs plus a few named operations.

- **Verbs:** `read`, `create`, `update`, `delete`, `execute`.
- **Named operations** (where a button ≠ CRUD): `record-play:start`, `record-play:stop`, `runs:execute`, `runs:export`, `agent:start`, `git-agent:apply`, `automation:pair`, `cases:rollback`, etc.
- **Capabilities** (governance switches, not resources): `project:create`, `app:create`, `website:create`.
- **Feature/page** (coarse "can open this page"): the existing 15 `FEATURES` keys, now enforced server-side too.

**Access tiers = named roles (presets) over this taxonomy:**
- **Read-only** = every `*:read` for the granted pages; no create/update/delete/execute; no capabilities.
- **Partial** = an explicit hand-picked set (this is where "only this person gets `record-play:start`" lives).
- **Full** = `*:read/create/update/delete/execute` for the granted pages; capabilities per admin choice.
- **Custom** = any set an admin composes.

### 10.2 Subjects & resolution (deny-by-default, deny-wins)

Effective permissions for a user =
`union( role-preset permissions of each group the user is in )  ∪  union( group direct grants )  ∪  user direct grants/overrides`
then **explicit denies subtract**, then **admin ⇒ all**. Non-admin with nothing granted ⇒ deny-all (unchanged semantics).

This adds the two missing subjects — **per-user overrides** (P6) and **role presets** (P5) — without changing the union/deny-by-default philosophy already in `groupStore.ts`.

### 10.3 Enforcement: one centralized gate (the core fix)

A new `rbacGate` middleware mounts **immediately after `scopeMiddleware`** (`apps/api/src/server.ts:118`), modeled directly on `apiAuthGate`:

```
rbacGate(req,res,next):
  if not /api/* -> next()
  if path in PUBLIC_API_PREFIXES or matches agent-token allowlist -> next()
  grants = reqGrants(req)
  if grants == UNRESTRICTED -> next()               # admin / internal
  required = ROUTE_PERMISSION_TABLE.lookup(method, path)   # e.g. POST /api/cases -> 'cases:create'
  if required == null -> next()                     # unmapped = allow (fail-open only for unlisted, logged)
  if permits(grants, required) -> next()
  else -> 403 + rbac audit(deny)
```

- The **route→permission table** is a small, central, declarative map keyed on `method + path-pattern`, reusing the fact that every route is a flat `/api/...` family. It is the *only* place the mapping lives.
- **Coarse vs instance-level split:** the gate decides "may this subject do `cases:create` at all." **Row-level ownership stays in handlers** (existing `scopeFilter` / `ownerMismatch`), because deciding "is case #123 theirs" requires loading the row. This hybrid is deliberate and documented — the gate is the coarse authorization layer; owner-isolation remains the instance layer.
- **SSE/streaming + agent-token endpoints** get the same allowlist treatment `apiAuthGate` already applies.
- **Feature-flagged:** `RBAC_ENFORCEMENT_V1` (default OFF). OFF = log-only "would-deny" (shadow mode) so we can see who *would* be blocked before enforcing; ON = actually 403. This is the bank-grade safe rollout for P9.

### 10.4 Data model — two tracks

**Track A (Phases 1–2, JSON store, ships the feature):** extend `Grants` additively:

```ts
interface Grants {
  features: GrantList; projects: GrantList; websites: GrantList; providers: GrantList;
  actions?: GrantList;        // 'cases:create', 'record-play:start', ...   (NEW)
  capabilities?: GrantList;   // 'project:create', 'website:create', ...    (NEW)
  denies?: GrantList;         // explicit deny (deny wins)                   (NEW)
  extra?: Record<string, GrantList>;
}
```
Plus a per-user override map and role presets stored alongside groups. All optional ⇒ existing group JSON stays valid. (Also fixes P8: the union must include the new fields.)

**Track B (Phase 3, normalized SQL, the "for banks / DB architecture" layer):** promote grants to first-class, auditable, referentially-intact tables appended idempotently to `schema.sql` (full DDL in §11.3). `groupStore` swaps its read/write to these tables behind the same function signatures, so nothing upstream changes. Includes an **authorization audit trail** (P7).

### 10.5 Client

- `src/lib/features.ts`: add `actionAllowed(grants, 'cases:update')` and `capabilityAllowed(grants, 'project:create')`, mirroring `grantAllows` (fail-closed).
- Gate buttons at their components (Record & Play, TestCases create/edit/delete, Runs execute, ProjectSwitcher new-project/new-app, etc.) — **UI reflects; server enforces.**
- Settings → Access Groups editor: add an **actions matrix** (resource × verb checkboxes), **capability toggles**, **role-preset picker**, and a **per-user override** panel.

---

## 11. Complete Refactoring Strategy

### 11.1 Server enforcement (Phase 1)
- New `server/features/auth/permissions.ts`: the permission catalog (`resource:action` constants), the `ROUTE_PERMISSION_TABLE` (method+path→permission), `permits(grants, permission)`, `actionAllowed`, `capabilityAllowed`, role-preset expansion.
- New `server/features/auth/rbacGate.ts`: the middleware in §10.3.
- Extend `groupStore.ts`: `normGrants` handles `actions`/`capabilities`/`denies`; union includes them + `extra` (fixes P8); add per-user override read/merge in `effectiveGrantsForUser`.
- Wire `app.use(rbacGate)` at `apps/api/src/server.ts:118`, flag-gated.
- Add capability checks on `POST /api/projects`, `POST /api/projects/:id/apps`, `POST /api/credentials/websites` (P4).

### 11.2 Client (Phase 2)
- `src/lib/features.ts`: new helpers + the action/capability catalog (kept in sync with server via `/api/auth/me` payload, learned not hardcoded per the no-hardcoding rule — the catalog is served from the backend permission module, the client renders whatever it receives).
- Button gating in the components enumerated in §12.
- `src/pages/Settings.tsx`: actions matrix + capabilities + role presets + per-user overrides UI.

### 11.3 Normalized SQL (Phase 3) — appended to `server/db/schema.sql`, idempotent

```sql
-- ── RBAC (granular permissions) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rbac_permissions (
  id          TEXT PRIMARY KEY,              -- 'cases:create'
  resource    TEXT NOT NULL,                 -- 'cases'
  action      TEXT NOT NULL,                 -- 'create'|'read'|'update'|'delete'|'execute'|'start'|...
  category    TEXT NOT NULL DEFAULT 'resource', -- 'resource'|'action'|'capability'|'feature'
  label       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rbac_permissions_res_act ON rbac_permissions(resource, action);

CREATE TABLE IF NOT EXISTS rbac_roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system   BOOLEAN NOT NULL DEFAULT false,  -- seeded presets (read-only/editor/full)
  owner_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rbac_roles_name_uq ON rbac_roles(lower(name));

CREATE TABLE IF NOT EXISTS rbac_role_permissions (
  role_id       TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  effect        TEXT NOT NULL DEFAULT 'allow',  -- 'allow'|'deny' (deny wins)
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS rbac_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rbac_group_members (
  group_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS rbac_group_members_user ON rbac_group_members(user_id);

-- Assign a role to a principal (user OR group), optionally scoped to a project/app.
CREATE TABLE IF NOT EXISTS rbac_role_bindings (
  id             TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,             -- 'user'|'group'
  principal_id   TEXT NOT NULL,
  role_id        TEXT NOT NULL,
  scope_type     TEXT NOT NULL DEFAULT 'global',  -- 'global'|'project'|'app'
  scope_id       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rbac_bindings_principal ON rbac_role_bindings(principal_type, principal_id);

-- One-off direct grants/overrides ("give this one person Record & Play").
CREATE TABLE IF NOT EXISTS rbac_grants (
  id             TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,
  principal_id   TEXT NOT NULL,
  permission_id  TEXT NOT NULL,
  effect         TEXT NOT NULL DEFAULT 'allow',  -- 'allow'|'deny'
  scope_type     TEXT NOT NULL DEFAULT 'global',
  scope_id       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rbac_grants_uq
  ON rbac_grants(principal_type, principal_id, permission_id, scope_type, coalesce(scope_id,''));

-- Bank-grade authorization audit trail.
CREATE TABLE IF NOT EXISTS rbac_audit (
  id             TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  actor_id       TEXT,
  event          TEXT NOT NULL,             -- 'grant.add'|'role.assign'|'decision.deny'|...
  principal_type TEXT, principal_id TEXT,
  permission_id  TEXT,
  decision       TEXT,                      -- 'allow'|'deny'
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rbac_audit_principal ON rbac_audit(principal_type, principal_id);
```

FKs are intentionally omitted on `principal_id` (it may reference a user *or* a group) and modeled the same way existing join/ledger tables do; `role_id`/`permission_id` FKs can be added `ON DELETE CASCADE` following the `sessions`/`chat_messages` precedent if the team wants strict integrity. Seeds (`rbac_permissions`, the three system roles) use `INSERT ... ON CONFLICT DO NOTHING`. `scripts/setup-db.bat` needs no change (same file path). Migration of existing `db.groups` JSON → these tables is a guarded `DO $$ ... $$` backfill.

---

## 12. Every File That Must Change (and 13. Why / 14. Risk)

**Phase 1 — server enforcement (JSON store):**
| File | Why | Risk |
|---|---|---|
| `server/features/auth/permissions.ts` *(new)* | Permission catalog + route→permission table + `permits`/`actionAllowed`/`capabilityAllowed` + preset expansion | Low |
| `server/features/auth/rbacGate.ts` *(new)* | The centralized gate; shadow/enforce modes | **Med** (touches every request) |
| `server/features/auth/groupStore.ts` | Add `actions`/`capabilities`/`denies` to `normGrants`+union; per-user overrides; fix `extra` drop (P8) | Med |
| `apps/api/src/server.ts` | `app.use(rbacGate)` at `:118`, flag-gated | **Med** |
| `server/features/projects/routes.ts` | `project:create` / `app:create` capability check | Low |
| `server/features/credentials/routes.ts` | `website:create` capability check | Low |
| `server/shared/scope.ts` | Expose merged effective permissions to `reqGrants` if shape extended | Low |
| `server/features/auth/routes.ts` | `/api/auth/me` returns the new grant fields + permission catalog | Low |
| `server/db/schema.sql` | (Phase 1 no-op; JSON store) | None |
| tests (new) | Gate unit tests, preset expansion, shadow-mode | Low |

**Phase 2 — client:**
| File | Why | Risk |
|---|---|---|
| `src/lib/features.ts` | `actionAllowed`/`capabilityAllowed`; consume server catalog | Low |
| `src/components/AuthGate.tsx` | Store new grant fields | Low |
| `src/App.tsx` | (unchanged logic; `FeatureGuard` now backed by real enforcement) | Low |
| `src/pages/RecordPlay.tsx` | Gate Start/Stop/Load buttons on `record-play:*` | Low |
| `src/pages/TestCases.tsx`, `TestRuns.tsx`, `TestSuites.tsx`, `TestPlans.tsx`, `Requirements.tsx`, `Defects.tsx`, `TestRepository.tsx` | Gate create/edit/delete/execute buttons | Low (per-file) |
| `src/components/ProjectSwitcher.tsx`, `ProjectWizard.tsx` | Hide "New project"/"New app" unless capability | Low |
| `src/pages/Settings.tsx` | Actions matrix + capabilities + role presets + per-user overrides UI | **Med** |

**Phase 3 — normalized SQL:**
| File | Why | Risk |
|---|---|---|
| `server/db/schema.sql` | Append `rbac_*` tables + seeds + backfill (idempotent) | **Med** |
| `server/features/auth/rbacStore.ts` *(new)* | SQL-backed CRUD + effective-permission resolver + audit writes | **Med** |
| `server/features/auth/groupStore.ts` | Delegate to `rbacStore` behind unchanged signatures | Med |
| `server/features/dashboard/routes.ts` | Optional: expose `rbac_audit` in the audit view | Low |
| `scripts/setup-db.bat` | Verify only (no path change) | None |

*(Each phase stays within the 10–15 file / one-subsystem cap.)*

---

## 15. Backward Compatibility

- Every new `Grants` field is **optional** ⇒ existing `db.groups` JSON remains valid; `undefined` behaves as empty/deny for that category (deny-by-default preserved).
- `groupStore` public function signatures are **unchanged** across all phases (Phase 3 swaps only the storage backend).
- `admin ⇒ UNRESTRICTED` and `non-admin-in-no-group ⇒ deny-all` semantics are **preserved**.
- `apiAuthGate`, owner-isolation (`scopeFilter`), and the public allowlist are untouched.
- **The one real break risk (P9):** turning enforcement ON could 403 grouped testers who previously passed only client-side. Mitigated by (a) `RBAC_ENFORCEMENT_V1` default OFF, (b) **shadow mode** logging would-be denials first, (c) a migration that grants existing group members a `full`-equivalent action set by default so behavior is unchanged until an admin *tightens* it.

## 16. Migration Strategy

1. Ship Phases 1–2 with `RBAC_ENFORCEMENT_V1=OFF` (shadow mode). Collect "would-deny" logs from real usage.
2. Backfill: for each existing group, expand its current `features`/`projects`/`websites`/`providers` into an equivalent **Full** action set so no one loses access on flip.
3. Flip `RBAC_ENFORCEMENT_V1=ON` in staging, verify against shadow-log expectations, then production.
4. Phase 3: create `rbac_*` tables (idempotent, additive), backfill from `db.groups` inside a guarded `DO $$ ... $$` block, switch `groupStore` reads to SQL, keep JSON write mirroring for one release as a fallback, then retire the JSON path.

## 17. Testing Strategy

- **Unit:** `permits()` truth table (read-only vs partial vs full); preset expansion; union + deny-wins; per-user override precedence; `extra`-drop regression (P8).
- **Route/gate:** table-driven — for each `(role/group, method, path)` assert 200/403; verify Record & Play grantable to exactly one user; verify `project:create` capability gating.
- **Shadow mode:** assert it logs but never blocks.
- **Regression:** existing suites (`npm run lint` = `tsc --noEmit`, plus repo tests) stay green; owner-isolation, DOM inspection, repo grounding, prompt/context assembly, validation gates, Playwright generation all unaffected.
- **Live:** per `CLAUDE.md`, after backend edits — lint ✓ → tests ✓ → **restart backend** → verify against the running app; never claim "works live" against a stale process.

## 18. Rollback Strategy

- Phases 1–2: set `RBAC_ENFORCEMENT_V1=OFF` → instantly reverts to today's behavior (client-only gating); new UI degrades to cosmetic. Full revert = drop the two new files + one `server.ts` line.
- Phase 3: tables are additive and idempotent; keep JSON mirror for one release so `groupStore` can fall back by config. `rbac_*` tables can be left in place (unused) with zero impact if rolled back.

## 19. Estimated Implementation Effort

| Phase | Scope | Est. |
|---|---|---|
| 1 — Server enforcement + capabilities (JSON) | ~8–10 files, gate + catalog + capability checks | 2–3 days |
| 2 — Client helpers + button gating + Settings UI | ~10–12 files | 2–3 days |
| 3 — Normalized SQL store + audit + migration | ~5 files + schema | 2–3 days |
| 4 — (optional) scoped roles + delegated admin | ~6–8 files | 2–3 days |

## 20. Recommended Implementation Order (phase checklist)

- [ ] **Phase 1 — Server-side enforcement (the security fix).** Files: `permissions.ts`(new), `rbacGate.ts`(new), `groupStore.ts`, `apps/api/src/server.ts`, `projects/routes.ts`, `credentials/routes.ts`, `auth/routes.ts`, tests. **Risk: Med.** Ships behind `RBAC_ENFORCEMENT_V1` in shadow mode. Deliverable: action + capability permissions defined and *observed* (not yet blocking).
- [ ] **Phase 2 — Client granularity + admin UI.** Files: `features.ts`, `AuthGate.tsx`, `RecordPlay.tsx`, the resource pages, `ProjectSwitcher.tsx`/`ProjectWizard.tsx`, `Settings.tsx`. **Risk: Low–Med.** Deliverable: read-only/partial/full presets, per-user overrides, per-button grants (incl. Record & Play), create-project/URL toggles — all editable and reflected in the UI; flip enforcement ON after shadow-log validation.
- [ ] **Phase 3 — Normalized SQL RBAC + audit trail.** Files: `schema.sql`, `rbacStore.ts`(new), `groupStore.ts`, `dashboard/routes.ts`. **Risk: Med.** Deliverable: bank-grade relational store, referential integrity, full authorization audit; JSON path retired after one mirrored release.
- [ ] **Phase 4 (optional) — Project/app-scoped roles + delegated admin.** Files: `rbac_role_bindings` consumers, scoped resolver, Settings scope pickers. **Risk: Med.** Deliverable: "admin of *this* project" delegation and per-project role assignment.

---

## Open decisions for approval (do not need answers to approve Phase 1; flag your preference when you approve)

1. **Store track:** go straight to normalized SQL (Track B) as the source of truth, or land Phases 1–2 on the JSON store first and migrate in Phase 3? *(Recommended: JSON first — ships the enforced feature fastest and lowest-risk, SQL follows.)*
2. **Scoped roles now or later:** do you need "admin of a specific project" / per-project role assignment in the first cut, or is global (per-user + per-group) sufficient initially? *(Recommended: global first, scoped in Phase 4.)*
3. **Default on migration:** when enforcement flips ON, should existing group members default to **Full** (no one loses access until you tighten) or **Read-only** (locked down until you loosen)? *(Recommended: Full, then tighten — least disruptive.)*

**No implementation will begin until you approve on a later turn.** On approval, confirm the three decisions above (or accept the recommendations) and I will execute Phase 1 only, then report before proceeding.
