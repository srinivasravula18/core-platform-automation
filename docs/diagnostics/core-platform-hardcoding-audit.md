# Core-Platform Hardcoding Audit

| | |
|---|---|
| **Purpose** | Find everywhere the automation tool bakes in Core-Platform's own names/concepts (Admin, Keystone/Shockwave, list view, apps, objects, roles, …) into GENERIC, reusable logic or prompts — which breaks the "test any app" (app-agnostic) principle. |
| **Method** | Three parallel code audits over the whole repo, each finding classified BAD / BY-DESIGN / ACCEPTABLE. |
| **Scope** | `src/**`, `server/**`, `services/runtime/**`, `scripts/**`, `server/db/**`. `mcp-servers/**` flagged for a follow-up. |

**Legend** — **BAD**: app-specific name embedded in generic logic, a heuristic/gate, a prompt, a hardcoded list, or a Core-Platform-assuming default. **BY-DESIGN**: knowledge base / seed / test fixtures (allowed to hold app facts). **ACCEPTABLE**: read dynamically from the repo/live catalog at runtime, or comment/example only.

---

## BAD — leaked hardcoding (fix candidates)

### A. Routing / mission / heuristic gates keyed on app-specific names (highest impact — silently mis-routes or mis-grounds any non-Core-Platform app)

| # | Location | Hardcoded token | Used for |
|---|---|---|---|
| A1 | `server/ai/supervisor.ts:185` | `/\b(admin\|keystone)\b/` | `isBroadCoverageQuestion()` multi-surface gate |
| A2 | `server/features/agent/mission/missionContext.ts:181` | `keystone\|shockwave\|runtime` → RUNTIME else **ADMIN** | `platformTypeFromSurface()` — the single authority for platform type |
| A3 | `mission/missionContext.ts:186-190` | `keystone` / `shockwave` | `runtimeSurfaceFromSurface()` |
| A4 | `mission/missionContext.ts:17` (+ `workflow/state.ts:62,385`) | `type RuntimeSurface = 'shockwave' \| 'keystone'` | mission model enumerates only Core-Platform runtimes |
| A5 | `mission/missionContext.ts:199-212` | `/\blist views?\b/`, stop-set incl. `admin`,`platform` | `needsExplicitListViewModule()` — the "which module?" ask gate |
| A6 | `server/features/agent/inspectionService.ts:46-52` | `list view`, `"Loading records"` | `isGroundedListViewInspection()` short-circuits the LLM loop |
| A7 | `server/agent-runtime/goals/router.ts:62-63` | `admin` / `keystone` | `targetAliases()` synthetic aliases |
| A8 | `goals/router.ts:78-79` (+ `router.ts:131`, `routes.ts:145`) | carve-out for `list view` | list/coverage command classifier |
| A9 | `server/ai/supervisor.ts:167-172` + `server/ai/research/deepResearch.ts:59-64` | `list_view`,`list_views` | keyword-expansion for code search |
| A10 | `server/features/agent/appTargeting.ts:112-114` | `return 'admin'` (ignores inputs) | `detectSurfaceKind()` default surface |
| A11 | `src/pages/AgentConsole.tsx:165-166` | `admin` / `keystone` | `appMentionAliases()` alias branches (frontend) |
| A12 | `src/pages/AgentConsole.tsx:671-672, 1673-1674, 1680-1709, 1539, 2528` | `platform === 'ADMIN'`, injects "list view" / "admin navigation" | run-start + label logic |

### B. Defaults that assume the target app IS Core-Platform

| # | Location | Hardcoded default |
|---|---|---|
| B1 | `server/features/agent/routes.ts:5408` | module defaults to `{ id: 'objects', name: 'Objects' }` |
| B2 | `server/ai/tools/corePlatformMeta.ts:352` | repo path defaults to `'D:/core-platform'` |
| B3 | `server/features/agent/domExplorer.ts:185-189` | token injection writes `shockwave.*` / `core_platform.*` sessionStorage keys |
| B4 | `src/components/ProjectWizard.tsx:251` | repo-path input placeholder `D:\core-platform` |
| B5 | `mcp-servers/core-platform-db/index.ts:10,13,20` *(out of primary scope)* | defaults `http://localhost:5001`, `D:/core-platform`, db `core-platform` |

### C. Agent / system PROMPTS with baked-in Core-Platform names (apply to every app)

| # | Location | Hardcoded content |
|---|---|---|
| C1 | `server/ai/systemPrompts.ts:212` | caseWriter: negative example `"keystone - List view - verify…"` |
| C2 | `server/features/agent/routes.ts:3002` | coder: `Loading records`, `Refresh list view`, `Unpin list view`, `Accounts`, `Created At` |
| C3 | `routes.ts:3004` | coder: navKeys `objects, tabs, users, permissions, access_controls, sharing_settings, flows`; ids `#create-object-label`,`#field-type`; `nav=apps` |
| C4 | `routes.ts:3005-3006, 3067` | coder: `"List view actions"`, `"Fit columns"` |
| C5 | `routes.ts:2457` | caseWriter: columns `Label, API Name, Version, App Prefix, Parent App`; app name `"Revenue Hub"` |
| C6 | `routes.ts:2192` | authoring contract: `Never use "Automations" in a case title` |
| C7 | `routes.ts:2191` | authoring contract: `CRM Accounts`, `keystone_local` |
| C8 | `routes.ts:2437` (+ `2453`, `3069`) | caseWriter: `admin adapter`, `specialized-list-view`, "admin pages", "Admin section" |
| C9 | `routes.ts:5251` | user-facing clarify: `"…for example Apps, Objects, Roles, or Users."` |

### D. DB schema — Core-Platform-surface-named columns on a generic table

| # | Location | Detail |
|---|---|---|
| D1 | `server/db/schema.sql:565-566` | `admin_behavior`, `keystone_behavior` columns on the generic `requirements` table |
| D2 | `server/db/repository.ts:1887, 1892, 1901` | `Requirements.upsert()` plumbs both columns; **dead** — always written as `''` |

### E. Hardcoded Core-Platform REST/metadata API contract in the generic requirements analyst

| # | Location | Detail |
|---|---|---|
| E1 | `server/features/requirements/apiAnalystService.ts:195, 200` | `POST /api/auth/login`; error string `"core-platform login failed"` |
| E2 | `apiAnalystService.ts:206, 227, 237` | routes `/api/apps/__all_apps__/objects`, `/objects/{api_name}/describe`, `/records?page_size=2` + `__all_apps__` sentinel |
| E3 | `apiAnalystService.ts:213-215, 245-246` | assumes record fields `api_name`, `table_name`, `app_prefix`, `app_id`, `label` |

### F. Keyword-expansion (`SYNONYMS`) table with Core-Platform nav/object labels

| # | Location | Detail |
|---|---|---|
| F1 | `server/features/requirements/requirementService.ts:347-348` | `list: ['list-view']`, `listview: ['list-view']` |
| F2 | `requirementService.ts:365-366` | `audit: ['audit-log']`, `recycle: ['recycle-bin']` (borderline: `:354` layout→form, `:356` trigger) |

---

## Borderline / structural (root causes, not single strings)

- **`server/ai/supervisor.ts:599`, `server/ai/tools/registry.ts:612-615`** — `corePlatformDataTools()` / `corePlatformMetaTools` wired unconditionally into the generic agent tool roster. They no-op when unconfigured, but the generic agent still assumes the named Core-Platform connector is *the* data/metadata backend. This coupling is the structural root the A-heuristics grow from.
- **`mission/missionContext.ts` overall** — the `ADMIN` vs `RUNTIME` taxonomy and the `?nav=` / `appId` / `object` URL contract (`:85-101`, `appTargeting.ts:189-191`) are Core-Platform's URL conventions treated as universal.
- **Function-name leaks** (behavior is param-driven/dynamic, but the names hard-code the app): `fetchCorePlatformObjectCatalog` (`server/ai/tools/corePlatformData`), `buildCorePlatformApplicationContext` (`server/features/agent/applicationContext`).

---

## BY-DESIGN — app facts allowed here

- **`server/features/agent/knowledge/**`** — the per-feature knowledge base. **Already gutted**: `getFeatureGrounding`/`matchedFeatureIds` return `''`/`[]`; the 8 Core-Platform knowledge files were deleted (header `index.ts:4-7`). Effectively holds no live app data now.
- **`server/db/seed.ts:345-357, 373`** — demo requirement + git-repo seed rows (`apps/shockwave/...`, `D:\core-platform-automation`, `user`/auth). Fixtures.
- **`scripts/**`** — test/eval/benchmark fixtures (`benchmark-features.ts:22-23` ADMIN/KEYSTONE appIds + localhost:5002/5003; `test-mission-*`, `live-run-listview.ts`, etc.). Fixtures.
- **`server/db/schema.sql:602`** (comment) — "seeded 'Core Platform' project" — confirm `projectService` seed isn't hardcoding that as a non-test default.

## ACCEPTABLE — dynamic / grounded / generic

- **`server/features/requirements/surfaceScope.ts`** — fully dynamic (URL→repo fingerprinting); `GENERIC_URL_TOKENS` even ignores `apps`/`app`/`ui`.
- **`server/features/agent/appTargeting.ts:62-107`** — `loadAdminNavModules` / `resolveAdminModuleFromRefs` parse nav from the bound repo at runtime.
- **`appTargeting.ts:143-172`, `routes.ts:5141-5149, 5353-5401, 5690-5700`** — apps/tabs/objects from the live `fetchCorePlatformApps/AppTabs` catalog matched against the prompt.
- **`server/ai/tools/corePlatformData.ts` / `corePlatformMeta.ts`** — the explicit Core-Platform *connector* tools (like an MCP server); their routes/fields are the app-under-test's contract read at runtime, self-gated via `…Configured()`. Grounding, not leaked heuristic.
- **`services/runtime/**`** — clean; entity types (`app`,`module`,`page`,`object`,`record`,`flow`) and ID prefixes are the tool's OWN QA taxonomy.
- **`server/features/{controller,settings}/**`, `server/ai/memory/**`** — no leaks found.
- Assorted comments/illustrative examples across `routes.ts`, `missionContext.ts`, `domExplorer.ts`, `selectorMap.ts`, `goals/types.ts`.

---

## Prioritized fix plan (recommended order)

1. **Routing/mission heuristics (A1–A12)** — highest impact; these silently mis-route or mis-ground a non-Core-Platform app. Generalize: derive platform/surface/module vocabulary from the resolved surface + parsed repo nav (reuse `surfaceScope` + `loadAdminNavModules`) instead of literal `admin`/`keystone`/`list view` matches.
2. **Prompts (C1–C9)** — move the concrete Core-Platform labels/nav-keys/examples out of the reusable system/coder/caseWriter prompts and into per-app grounding (the knowledge-base slot, now empty) or derive them from the live catalog. Keep prompts about *patterns*, not *this app's names*.
3. **Defaults (B1–B5)** — remove Core-Platform defaults (repo path, `objects` module, `shockwave.*` storage keys); require config or derive.
4. **API contract (E1–E3)** — the requirements API-analyst should use the connector tool's dynamic catalog, not hardcoded `/api/apps/__all_apps__/...` routes.
5. **Dead schema (D1–D2)** — drop `admin_behavior`/`keystone_behavior` columns and their upsert plumbing.
6. **SYNONYMS (F1–F2)** — drop the Core-Platform-specific expansions (or make them repo-derived).
7. **Structural** — make the Core-Platform connector tools opt-in per app rather than wired into every generic agent roster; rename `*CorePlatform*` helpers to app-neutral names.
