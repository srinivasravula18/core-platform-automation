# Projects → Apps Architecture

End-to-end design for a dedicated **Project** system where one git repo = one project, each
project holds N independently-testable **Apps**, and the full Agent Console works at either
app level or project level. Grounded in the current TestFlowAI codebase.

> Status: design / proposal. No code written yet.
> Decisions locked with the product owner (see §0).

---

## 0. Locked decisions

| Decision | Choice |
|---|---|
| **Project ↔ repo** | 1:1. Connecting a git repo *is* creating a project. |
| **App** | A testable surface *within* the project's one codebase — its own base URL, repo sub-path / search-roots, credentials, and knowledge pack. N apps per project. |
| **Repo source** | **Both** local filesystem paths *and* remote clone (GitHub/GitLab URL + token). One internal interface, two sources. |
| **Trust model** | Internal / trusted team. Scoping is primarily for **organization**, not defense against the user. Secrets stay simple (reuse existing encrypted-credential pattern). No hard sandbox between projects. Scope is still enforced at the repository chokepoint as cheap hygiene. |
| **Per-app Knowledge** | Lives in Settings as a **structured spec** — app structure, DB architecture, APIs, services, flows, gotchas, selectors. Auto-bootstrapped by scanning the connected repo, then human-refined. Bound to `app_id`. |

---

## 1. Domain model

```
Project  ═══════════  ONE git repo (one codebase)
  │                    local path  OR  remote URL+token
  │                    members, settings, default branch
  │
  ├── App 1  ──→  base_url + repo sub-path/search_roots + credentials + knowledge pack
  ├── App 2  ──→  (tested individually; agent targets THIS app)
  ├── ...
  └── App N
  │
  └── QA entities (plans / suites / cases / runs / requirements / defects / folders / scripts)
        scope = (project_id required, app_id nullable)
          app_id = X     → belongs to that app
          app_id = null  → project-level, cross-app (e.g. an E2E flow spanning App 1 + App 2)
```

The single nullable `app_id` column is what makes **"anyone can do app-level OR project-level
testing"** fall out for free — it's one column, not two parallel systems. An app view shows
`app_id = X OR app_id IS NULL` (app-specific + shared project items); a project view shows
everything under the project.

---

## 2. Data model changes

### New tables

```sql
projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  repo_kind     TEXT NOT NULL,          -- 'local' | 'remote'
  repo_path     TEXT,                   -- local: absolute folder; remote: cloned workdir
  repo_url      TEXT,                   -- remote only
  repo_auth_ref TEXT,                   -- pointer to secret store, NEVER the token itself
  default_branch TEXT DEFAULT 'main',
  last_synced_sha TEXT,
  sync_status   TEXT DEFAULT 'idle',    -- idle | connecting | syncing | ready | error
  last_error    TEXT,
  settings      JSONB DEFAULT '{}',
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

apps (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  base_url      TEXT,                   -- replaces per-run ad-hoc app_url
  environment   TEXT DEFAULT 'staging',
  repo_subpath  TEXT,                   -- where this app lives in the monorepo, '' = whole repo
  search_roots  JSONB DEFAULT '{}',     -- replaces hardcoded CORE_PLATFORM_SEARCH_ROOTS
  knowledge_pack_id TEXT,               -- FK to app knowledge (see §6)
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
```

`project_members` (project_id, user_id, role) activates the dormant `users` table when auth
lands (Phase 5). For a trusted single team it can default everyone to `editor`.

### Scope columns

Add `project_id TEXT` (required) and `app_id TEXT` (nullable) to:
`plans, suites, cases, runs, defects, reports, scripts, folders, requirements, agent_runs`.

Repurpose the already-stubbed `workspace_id DEFAULT 'default'` literal as `project_id`. Both
persistence backends must gain these: `server/db/schema.sql` **and** the in-memory arrays in
`server/shared/storage.ts`.

---

## 3. Backend: enforce scope at chokepoints, not call sites

The architectural principle for the whole feature: **enforce each invariant in exactly one
place** so the 890-line agent routes and 13 frontend fetch sites can't violate it.

### 3.1 The repository is the scoping chokepoint

`server/db/repository.ts` is the single data-access layer (both PG and in-memory branch
through it). Every `list/get/upsert` gains a mandatory scope, so an unscoped query becomes
impossible by construction:

```ts
Cases.list({ projectId, appId })   // WHERE project_id = $p AND (app_id = $a OR app_id IS NULL)
Cases.upsert(row, { projectId, appId })  // stamps scope on write
```

Add `Projects` and `Apps` repository modules mirroring the existing `Websites` module.

### 3.2 Scope-resolution middleware

New middleware in `server.ts`, before the feature routes (`server.ts:57-71`):

```
Request
  → requireAuth           (activate the existing, currently-unapplied middleware)
  → resolveScope          reads X-Project-Id / X-App-Id headers → req.scope
  → assertMembership      (trusted mode: light check; SaaS mode: hard)
  → feature route         uses req.scope for every repository call
```

`req.scope` also populates the AI controller's existing `pageContext` / `workspaceId` param
(`controller.ts:110`) — today hardcoded to `'default'`, tomorrow the real project/app.

### 3.3 New feature module

`server/features/projects/{routes.ts, projectService.ts}` following the established
`register<X>Routes(app)` convention, registered in `server.ts`. Owns project + app CRUD,
repo connect/sync, and knowledge bootstrap.

---

## 4. Git integration (one repo per project, two sources)

Today `gitAgentService.ts` is hardcoded to `D:\core-platform` and runs git in `cwd`.
Generalize it behind a **RepoProvider interface** with two implementations:

```
RepoProvider
  ├── LocalRepoProvider   path already on disk → record it, run read-only git there
  └── RemoteRepoProvider  clone URL+token → isolated per-project workdir, fetch/pull updates

both expose: status(), sync(), grep(pattern, roots), readFile(path), diff(range), listChanges()
```

Rules (lighter for trusted team, but still sane):

- **Per-project workdir**, namespaced and *outside the platform's own repo dir*:
  `.workdirs/<projectId>/`. `gitAgentService.ts` currently runs in `cwd` — that must change.
- **One locked working copy per repo** — no two `git pull`s racing the same dir (a simple
  per-project mutex/queue).
- **All remote ops read-only** — `clone --depth`, `fetch`, `pull --ff-only`, `diff`,
  `git grep`, `show HEAD:<file>`. The platform never commits or pushes.
- **Credentials behind indirection** — `projects.repo_auth_ref` points to the encrypted
  secret store (reuse the `website_users` encrypted-password pattern), never a plaintext
  token in a row or log, never baked into the remote URL.
- **Graceful degradation** — if the repo fails to clone/sync, the project still does
  black-box app testing via `base_url`. Git only *enriches* (source-grounded requirements,
  change-driven test generation). Status + `last_error` surface in the UI.
- **Per-app carve-out** — `apps.repo_subpath` + `apps.search_roots` replace the hardcoded
  `CORE_PLATFORM_SEARCH_ROOTS` map, scoping each app to its slice of the monorepo.

`requirementService.ts` (which calls `gitGrep`/`readRepoFile`) switches from the hardcoded
repo to the project's RepoProvider scoped by the app's search roots.

---

## 5. Agent Console: app-level and project-level

Today `agent/routes.ts` resolves target URL / credentials / knowledge ad-hoc by parsing the
prompt. With a selected app, resolution becomes **deterministic** — read from the `apps` row:

```
App selected      → base_url, credentials (website_users), knowledge pack, repo search_roots
                    all come from the app record. Agent targets exactly that app.
Project selected  → cross-app run: iterate the project's apps, or ask which app to target.
                    Repo-wide grounding (whole codebase, not one subpath).
```

This removes a class of "agent tested the wrong thing" bugs, because target resolution stops
guessing. The deep pipeline (ApplicationInspector → TestGenerationAgent → PlaywrightAgent →
EvidenceAgent) is unchanged — it just receives a resolved app context instead of parsing one.

### Execution isolation

Namespace the flat run/evidence dirs by scope so runs can't collide or leak across projects:

```
.testflow-pw/<projectId>/<appId>/<runId>/tests/
evidence/<projectId>/<appId>/<runId>/
```

Add a per-project concurrency semaphore so one project can't spawn unbounded
`npx playwright test` processes (you already spawn with a timeout — extend with a limit).

---

## 6. Per-app Knowledge as a structured spec (Settings)

The existing `AppKnowledgePack` is freeform markdown, injected as a relevance-ranked slice
(`splitSections` ranks by heading match — `knowledgeService.ts:227-287`). We keep that engine
verbatim and **standardize the section headings** so Settings captures a real per-app spec:

```markdown
# App: <name>
## App structure          — pages, routes, navigation, components, surfaces
## Data / DB architecture  — tables, key fields, relationships, invariants
## APIs                    — endpoints, contracts, auth, status codes
## Services                — backend services, responsibilities, boundaries
## Key flows               — the journeys worth testing, step by step
## Business rules          — expected behavior to assert
## Gotchas                 — edge cases, caches, negative-test fuel
## Selectors / labels      — stable hooks for automation
```

Changes to `knowledgeService.ts`:

- **Bind packs to `app_id`** (in addition to / instead of `websiteIds`+host+name matching).
  Resolution precedence becomes: `app_id` → website id → host → name. Deterministic when an
  app is selected.
- **Move packs into Postgres** (today they're a `storage.ts`-only array, absent from
  `schema.sql`) so they scope and persist like everything else.
- **Auto-bootstrap from the repo** — because the project *is* the repo, a "Generate knowledge
  from code" action scans the app's `search_roots` (reusing `git-agent/analysisService.ts` +
  `gitGrep`/`readFile`) to draft the structure/DB/API/services sections. Human refines in
  Settings. `recordObservation()` keeps growing it from live runs (already built).

This closes the loop: **git scan → structured app knowledge → agent grounding → live-run
observations → back into knowledge.**

---

## 7. Frontend

No global domain store today; every page does bare `fetch` and hardcodes
`workspaceId:'default'` (13 sites). Introduce two things:

1. **`ProjectContext` store** (Zustand, like `store/theme.ts`) holding `{projectId, appId,
   role}`, persisted to localStorage (same pattern as `AuthGate`'s `tfa_auth_token`). A
   **Project + App switcher in the Topbar** (`App.tsx`, by the user menu).
2. **A thin `apiFetch()` wrapper** — the clean refactor inline `fetch` has deferred. It
   injects `X-Project-Id` / `X-App-Id` from the store. Replace the 13 hardcoded
   `workspaceId:'default'` sites with it; every page becomes scoped without touching page
   logic.

The switcher gives the app-vs-project toggle for free:
- **App selected** → pages show app-scoped data, agent targets that app.
- **"All apps / project"** → pages show project + cross-app items, agent runs at project scope.

---

## 8. Fail-safe layers (cross-cutting)

| Layer | Failure prevented | Mechanism |
|---|---|---|
| Repository scoping | Cross-project data leak | Mandatory scope param; unscoped query impossible by construction |
| Scope middleware | Wrong-context writes | `resolveScope` + `assertMembership` before every route |
| Secret indirection | Token/credential leak | `repo_auth_ref` → encrypted store; never in rows or logs |
| Git isolation | Repo corruption / runaway clone | Per-project locked workdir outside app dir; read-only ops; depth/size/timeout caps |
| Execution isolation | Run collision / resource starvation | Per-scope dirs + per-project concurrency limit + existing timeouts |
| Graceful degradation | Git/AI outage kills testing | Black-box app testing never depends on git; AI failures pass through existing `guardrails.ts` |
| Soft delete + audit | Accidental data loss | Existing `deleted_at` + `audit_log`, now scoped by project |
| Dual-backend parity | PG vs in-memory drift | Scope implemented in **both** `repository.ts` and `storage.ts`; test both |
| Migration safety | Breaking existing data | Backfill all current rows into a seeded "Default Project" + "Core Platform" app |
| AI cost runaway | One project burns budget | `costTracker.ts` already logs per-workspace → enforce per-project quota in `orchestrator.ts` |

---

## 9. Phasing (each ships independently)

1. **Tenancy core** *(load-bearing, riskiest)* — `projects`/`apps` tables, scope columns,
   repository scoping in both backends, migrate existing data into a Default Project. No UI
   change; everything keeps working underneath.
2. **Frontend context** — `ProjectContext`, Topbar switcher, `apiFetch` wrapper. Users see &
   switch projects/apps.
3. **App-aware agent** — target/credentials/knowledge resolved from the selected app;
   app-level vs project-level runs; scoped execution dirs.
4. **Git integration** — RepoProvider (local + remote), isolated workers, per-app search
   roots; source-grounded requirements per project; knowledge auto-bootstrap.
5. **Auth & members** — activate `users`/`sessions`, membership roles, real session store
   (replace the in-memory token `Set`).

Phase 1 is the foundation everything else builds on; phases 2–5 are additive.

---

## 10. Key extension points (file map)

| Concern | File | Change |
|---|---|---|
| Schema | `server/db/schema.sql` | `projects`/`apps` tables; scope columns; move knowledge into PG |
| Data access | `server/db/repository.ts` | Scope param on every method; `Projects`/`Apps` modules |
| In-memory parity | `server/shared/storage.ts` | `projects`/`apps` arrays + persistence; scope on existing arrays |
| New module | `server/features/projects/` | `routes.ts` + `projectService.ts`, register in `server.ts` |
| Generic CRUD | `server/features/resources/routes.ts` | Filter every list by `req.scope` |
| Scope middleware | `server.ts`, `server/features/auth/routes.ts` | `resolveScope` + activate `requireAuth` |
| Agent resolution | `server/features/agent/routes.ts`, `server/shared/url.ts` | Resolve target/creds/knowledge from the app row |
| AI context | `server/ai/controller.ts`, `server/ai/orchestrator.ts` | Carry `projectId`/`appId`; per-project quota |
| Git | `server/features/git-agent/gitAgentService.ts` | RepoProvider interface; per-project workdir; drop hardcoded path |
| Requirements grounding | `server/features/requirements/requirementService.ts` | Use project RepoProvider + app search roots |
| Knowledge | `server/features/knowledge/knowledgeService.ts` | Bind to `app_id`; structured sections; PG-backed; repo bootstrap |
| Execution | `server/features/playwright/executionService.ts` | Per-scope run/evidence dirs; concurrency limit |
| Frontend context | `src/App.tsx`, new `src/store/project.ts`, new `src/lib/apiFetch.ts` | Switcher + store + scoped fetch wrapper |
