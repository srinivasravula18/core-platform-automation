# Core Platform — Feature & Functional-Requirements Audit (for Manual + Automated Testing)

> **Source of truth:** the actual source code at `D:\core-platform` (read code only, docs ignored — docs are aspirational/stale).
> **Purpose:** give QA a complete, testable map of every feature, the business rules behind it, how the screens/sections connect, and — most importantly — how an action in **Admin** surfaces in **Keystone**.
> **Audience:** manual testers and automation engineers (Playwright selectors/labels captured inline).

---

## 1. What this system is

A **Salesforce-like, metadata-driven CRUD platform** with strict app-level siloing. Admins define *metadata* (apps, objects, fields, layouts, tabs, access, validations, triggers, flows); end users work with *business data* generated entirely from that metadata. **Nothing about the business objects is hardcoded.**

Three surfaces (monorepo `apps/`):

| App | Folder | Port | Role |
|---|---|---|---|
| **App Service** (Fastify backend) | `apps/service` | **5001** | Single enforcement point: auth, metadata, CRUD, access control, validations, triggers, audit |
| **Admin App** (React + Vite) | `apps/admin` | **5002** | Metadata management (apps/objects/fields/layouts/access/users/roles/flows/jobs) |
| **Keystone** (React + Vite) | `apps/shockwave`* | **5003** | End-user app: business data CRUD from metadata |

\* The folder is still named `shockwave` but the product was **renamed "Keystone"** (migration `0107_rename_end_user_app_to_keystone.ts`). The display name is overridable via the `APP_DISPLAY_NAME_KEY` system setting; UI falls back to "Keystone".

**Mental model for testing:** `Admin defines metadata → App Service stores + enforces → Keystone renders + obeys`. Almost every meaningful test is a chain: *do X in Admin → verify the effect (or correct denial) in Keystone.*

---

## 2. How to run & access

| Component | Port | Source |
|---|---|---|
| App Service | 5001 | `apps/service/src/index.ts` (`PORT ?? 5001`, host `0.0.0.0`) |
| Admin SPA | 5002 | `apps/admin/vite.config.ts` (`strictPort: true`) |
| Keystone SPA | 5003 | `apps/shockwave/vite.config.ts` (`strictPort: true`) |

- **Run everything:** `npm run start:all` (`scripts/start-all.ps1`) or PM2 (`ecosystem.config.cjs`). PM2 launches: service, **exports worker**, **scheduler worker** (5 s poll, 120 s lease), export-cleanup (cron 3am), auth-cleanup (cron 3:30am). SPAs run via each app's `"dev": "vite"`.
- **Backend URL for SPAs:** `VITE_API_BASE` (resolved by `resolveRuntimeApiBase`). Cross-app links resolve by port-swap 5002↔5003 or path-swap `/admin`↔`/shockwave`, overridable via `VITE_SHOCKWAVE_BASE_URL` / `VITE_ADMIN_BASE_URL`.
- **CORS:** allowlist defaults to `localhost:5002,5003` (+127.0.0.1). **`NODE_ENV=development` allows all origins** — don't rely on CORS behaviour matching prod locally.
- **Default admin login** (`.env` / `.env.example`): **username `admin` / password `admin`** (id `usradmin1`). Auto-created on boot (`ensureBootstrapAdminUser`) and granted the `system_admin` role.
- **Seeding:** `npm run seed:industry-suite` (migrate → seed admin → compose+load metadata → seed industry data → seed test users). Test users via `seed:test-users`. Load-test data via `seed:load-test-data`. Metadata loads from JSON files in `seeds/metadata/*`, `nodify-cdt/metadata`, `elims/metadata` via `apps/service/src/metadata/cli.ts`.

> **QA note:** Admin (5002) and Keystone (5003) store tokens under **different `sessionStorage` namespaces** (`core_platform.*` vs `shockwave.*`). There is **no SSO between them** — log into each separately. The only cross-app handoff is impersonation (§4).

---

## 3. Authentication & sessions

- **Login:** `POST /auth/login`. Accepts **username OR email** (`@` detection). Verifies password hash; requires `status='active'`. Returns `{access_token, refresh_token, refresh_family_id}` + sets HttpOnly cookies.
  - Wrong password / ambiguous match → `401 invalid_credentials`. Exactly-one inactive match, no active → `403 account_deactivated`.
- **Tokens:** JWT (`AUTH_JWT_SECRET`, TTL `AUTH_JWT_TTL` default **8h**). DB-backed refresh tokens with rotation + family revocation (TTL `AUTH_REFRESH_TTL_DAYS` default 30). Both SPAs auto-refresh once on 401 then retry; final 401 → `auth:expired` → back to login.
- **Authorization preHandler** (`auth/plugin.ts`): verifies JWT, requires user `active`, `session_version` matches token, impersonation actor valid, and `jti` not revoked. Any failure → `401`.
- **Logout:** `POST /auth/logout` revokes the access jti + refresh family, clears cookies.
- **Forgot/Reset:** `/auth/forgot` (no user enumeration; token returned in body only if `AUTH_RESET_RETURN_TOKEN=true`); `/auth/reset` sets password, **bumps `session_version`** (invalidates all existing sessions) and revokes refresh tokens.
  - ⚠️ **Asymmetry to test:** admin-driven `POST /admin/users/:id/password` does **not** bump session_version (old sessions survive), whereas self-service `/auth/reset` does.

**There is no separate "admin login".** The same credentials log into both apps; admin power comes only from the **`system_admin` role** (which bypasses access checks). `is_super_user` flag also bypasses everything.

### Login screens
- **Keystone** `ShockwaveAuthPanel.tsx`: `#username` ("Email or Username"), `#password`, submit "Sign in". Sends best-effort geolocation.
- Admin login analogous (same backend).

---

## 4. Impersonation & app scope

**Impersonation ("Login As"), Admin → Keystone:**
1. Admin user detail → **Login As** → `POST /admin/users/:id/login-as` → signs a short-lived single-use `impersonation_handoff` JWT (actor+target ids + session versions).
2. Admin opens Keystone with `?impersonation_handoff=<token>` (`buildShockwaveImpersonationUrl`).
3. Keystone calls `POST /auth/impersonation/exchange` → backend **one-time-uses** the token (reuse → `409`), revalidates actor+target sessions, issues access token with `is_impersonating:true` + actor identity.
4. Keystone shows a banner "Login As active — using Keystone as **{user}** from Admin as {actor}"; stop = logout (logs `auth.impersonation.stop`).
- Target user must be **active** (else `409`).

**App scope** (`appScope.ts`, identical in both SPAs): selected app **plus its parent-app ancestor chain** (walk `parent_app_id` ≤20 hops, cycle-guarded). Backend `resolveAppScopeIds` → a child app **sees objects of itself and all ancestors** (`o.app_id = any(scopeArray)`), deduped by api_name, nearest-scope first. `__all_apps__` = unscoped. Selection persists per user (`last_app_id`).

---

## 5. The access & permission model (read this before writing any access test)

Four layers, **all enforced in App Service, never UI-only**:

1. **`system_admin` role / `is_super_user`** → **bypass everything** (full CRUD, all fields, all features).
2. **`meta.access_record`** → object/record/field **CRUD** (`access/evaluator.ts`).
   - **Default DENY** — no access record = no access.
   - Merges all records for the user's **effective principals** = the user + roles + groups + **all subordinate users via the manager chain** — with **OR semantics** (any grant wins). There is **no deny** in access_record.
   - Object action map: read←read|view_all|modify_all; create←create; update←update|modify_all; delete←delete|modify_all.
   - **Record (row) scope:** without `view_all`/`modify_all`, a non-owner can only act on records they **own or whose owner is in their manager chain** (`isOwnerOrManagerChain`, ≤10 hops). `view_all`/`modify_all` bypass row scope.
   - **Field rules** (`toFieldRules`): `read:true,write:false` → read-only; `mask` → masked+read-only; neither present in any record → field hidden. (No rule = visible/editable subject to object perms.)
   - Optional **creator-only delete** mode.
   - **Cache:** merged set cached ~60s per `(userId,objectId)` (`ACCESS_CACHE_TTL_MS`).
3. **`meta.access_control`** → **app/tab visibility**, actions view/create/edit/delete, effect allow/deny (`access-control/evaluator.ts`).
   - **Explicit deny wins**; any allow → allow; no rows → `inherit`. Manager inheritance: a subordinate's allow can promote an inherited user to allow. `scope_json.app_id` limits a rule to one app.
4. **`meta.permission` + `permission_grant`** → **capability gating** (app/tab/button visibility, export, inline_edit, import, admin features) (`permissions/evaluator.ts`).
   - ⚠️ **Fails OPEN:** if **no** permission definition matches `(resource_type, action)`, `checkPermission` returns **allowed** (`no_permission_defined`). **Exception:** `canViewApp`/`canViewTab` treat `no_permission_defined` as **DENY** for non-admins.
   - With definitions present: deny grant wins, then allow, else denied. Manager inheritance applies.

> **Two "default" semantics to test deliberately:** generic capabilities are *open until defined*; **app/tab visibility is closed until both an `app:view` permission AND a non-deny access_control exist**. Test apps/tabs both with and without definitions.

---

## 6. Admin App — screens & functional requirements

Single-page React app, **no router** — navigation is state-driven (`main.tsx` `activeNav`). Sidebar (`AdminSidebar.tsx`) buttons (selector = button text):

- **Core:** Apps, App Hierarchy, Search Results, Agent
- **Metadata:** Objects, Tabs, Flows
- **Security:** Roles, Groups, Users, Permissions, Access Records
- **Other:** System Settings, Email Logs, Scheduled Jobs, Audit Logs, Recycle Bin

**Topbar** (`AdminTopbar.tsx`): Apps launcher (`.launcher-button`, search "Search apps", "All Apps" + per-app rows), selected-app pill, Global Search (`input.nav-search`, aria-label "Global Search", min 2 chars), user menu (Last login / Docs / Log out). **App scope persists across Admin + Keystone** and filters every metadata list.

**Shared list view (`ListViewObjectHome`)** appears on most panels — common controls: **New**, **Refresh**, **Export CSV**, **Export PDF**, **Summary** toggle, **Settings** (Columns / Filters / Sort / Sharing), search box, row checkboxes + **bulk delete**, list-view selector (pin/default), column resize/reorder/wrap. View mode is **table only** in Admin.

**Shared modal pattern:** `Modal` → `ModalHeader <h3>` title → `.modal-body` → `ModalFooter` (Cancel + Create/Save). Required fields `.required-asterisk "*"`. Per-field `<p class="error">` + `FormErrorSummary`. Form fields: `.form-field`, `<label htmlFor>` matches input `id`; **API Name auto-derives from Label** until edited.

### 6.1 Apps (`AdminAppsPanel.tsx`)
- **New App** modal ("New App"): `Label*` `#create-app-label`, `API Name*` `#create-app-api`, `Prefix*` `#create-app-prefix` (3 chars), `Parent App*` `#create-app-parent`, Icon, Help Text. → `POST /admin/apps`.
- Detail tabs: **Details** / **Audit Log**; **Edit**, **Delete**.
- **Rules:** `parent_app_id` **required** (root app cannot be created here — must be seeded); `api_name`, `app_prefix`, `label` all **globally unique (case-insensitive)** → 409; create auto-makes `app:view` + `app:import` permission defs; delete blocked if dependent objects exist (409) → goes to Recycle Bin.
- **Connections:** drives App Launcher (Admin+Keystone), business table names (`<prefix>__<object>`), the hierarchy tree.
- **AC:** create `Sales Cloud`/`sal` under existing parent → appears in list + launcher; duplicate prefix (any case) → 409; delete app with objects → 409.

### 6.2 App Hierarchy (`AdminAppHierarchyPanel.tsx`)
Read-only tree of parent/child apps; **Toggle** flips orientation. AC: child app nests under parent; toggle reverses.

### 6.3 Objects (`AdminObjectsPanel.tsx` + `AdminObjectHomePanel.tsx`)
- **New Object** modal (2 steps): Step 1 `App*` (in All-Apps), `Label*`, `API Name*`, `Plural Label`, `Prefix*`, `List View Relationship Depth` (0–10), checkboxes **Global search enabled / Inline edit enabled / Access log allows / Access log denies**, Icon, Help Text. Step 2 `ObjectNamePolicyEditor` (auto-naming: mode `manual|auto_if_blank|always_auto`, pattern prefix/date, separator, padding 1–12, start). → `POST /admin/apps/:appId/objects`.
- **Object Home sub-tabs:** Settings, Record Types (N), Fields (N), Buttons (N), Email Templates (N), Layout (N), Form (N), Assignments (N), Validation Rules (N), Trigger Rules (N), Audit Log (N).
- **Create-object side effects (one transaction):** insert `meta.object` + name counter + default **record type "master"** + **5 layouts** (record_layout, record_edit, record_creation, summary_dialog, search_page) + default form + layout/form **assignments** (`principal_type='default'`) + **7 system fields** (id, name, status, created_by/at, modified_by/at) + default **"All" list view** + **creates the physical `business.<prefix>__<api>` table** (with log table + indexes).
- **Rules:** `api_name` unique per app; `id_prefix` & `label` globally unique (case-insensitive). Delete blocked if object non-business, referenced by another object, or table has rows.
- **Connections:** object becomes usable in Keystone only once a **Tab** + **access record** exist.

#### Fields (`AdminFieldModal.tsx`)
- "New Field"/"Edit Field": `Label*` `#field-label`, `API Name*` `#field-api-name` (read-only on edit), `Type*` `#field-type`. **Types:** Boolean, Currency, Date, Date/Time, Email, File, Lookup, Master-Detail, Multi Picklist, Number, Percent, Phone, Picklist, Rich Text Area, Text, Text Area, Time, URL.
- Conditional controls: number → Allow decimals + Decimal places (0–12); relationship → `Relation Object*` + Relationship Label; file → Allowed file types* + Allowed upload categories*; picklist → Restrict-to-values toggle + values editor. Toggles: Required (forced on for master-detail, off for file), Searchable, Log field changes, Unique (not boolean), Default value, Help Text. Edit mode has a "Type Change Help" matrix.
- **Rules:** reserved names rejected (id/name/status/row_version/app_id/record_type_id/created*/modified*); api_name+label unique per object; relationship requires `reference_object_id`; picklist ≥1 value; `is_unique`+default rejected; master-detail forces required. → `applyBusinessSchemaForObject` **ALTER TABLE add column** (+ trigram/relationship/unique indexes).
- ⚠️ **Adding a field does NOT auto-add it to any layout** — it appears in the list-view column picker immediately, but on the **edit/create form only after you add it to the layout** (default record layout hydrates from fields when its stored definition is empty).

#### Record Types / Layouts / Forms / Assignments / Validation Rules / Trigger Rules / Buttons / Email Templates
Each is a managed sub-section (New/Edit/Delete; triggers add **Verify**; trigger action types Set Field / Add Error / Update Record). Email templates → `AdminObjectEmailTemplatesPanel.tsx` (To/CC/BCC one-recipient-per-line, Subject required, Body default `{{record.details}}`, trigger events, Active).

### 6.4 Tabs (`AdminTabsPanel.tsx` + `AdminCreateTabModal.tsx`)
- "New Tab": `Target App*`, `Tab Type*` `#create-tab-type` (**Object Workspace** / **Custom Website Tab**), `Object*` (object type), `Label*`, `API Name*`, Icon; external adds `Website URL*` + `Website Display` (Embed/Open). → `POST /admin/apps/:appId/tabs`.
- **Rules:** object tab requires object in app; external requires valid http(s) URL and no object; label globally unique; create auto-makes `tab:view` permission.
- **Connections:** appears in Keystone tab bar (gated by `canViewTab`).

### 6.5 Flows (`AdminFlowsPanel.tsx`)
Flow list + editor. **Create Flow:** Target App, Name, API Name, mode (create/edit), surface (Main record+actions / Actions only / Main record only), Active, Default for mode, Allow cancel. **Steps:** visibility (Always / expression e.g. `$flow.amount > 1000 && $flow.country === 'US'` / field condition), field bindings, action configs (object, HTTP URL, record source, delete conditions, field mappings), drag reorder. → flow + steps CRUD + `reorderAdminFlowSteps`.

### 6.6 Roles / Groups (`AdminRolesPanel.tsx`, `AdminGroupsPanel.tsx`)
- New Role/Group: `App*`, `Name*`, `Description`. Detail has **membership management** (add/remove users, search/letter filter, bulk add).
- **Rules:** name globally unique (case-insensitive); `system_admin` role permanent (no rename/delete); **single role per user** (second role → 409/400); groups allow many; delete blocked while assigned (409).
- **Connections:** roles/groups are principals for Access Records + Permission grants.

### 6.7 Users (`AdminUsersPanel.tsx` + `AdminUserModal.tsx`)
- New/Edit User: `Username*` `#user-username` (min 3, **not unique**), First/Last name, Email, Status (Active/Disabled; locked for bootstrap admin), Manager, **Super User** checkbox, (create) `Temporary password*` (min 8). Detail actions: **Login As**, **Edit**, **Reset Password**.
- Embedded tabs: **Access Logs** (`AdminUserAccessLogsPanel`), **Record Read Logs** (`AdminUserRecordReadLogsPanel`).
- **Rules:** optimistic concurrency on update (`row_version` mismatch → 409); bootstrap admin can't be disabled; `is_super_user` honored only if column exists. Login As requires active target.

### 6.8 Permissions (`AdminPermissionsPanel.tsx`)
- Permission-denied state if not permission-admin ("Permission administration is restricted").
- **New Permission:** `Resource Type*`, `Action*`, `Resource ID`, `Scope JSON`. Detail: editable Scope JSON; **Grants** list (principal + type/effect/source pills, Remove); **Add Grant** (Source runtime/metadata, Effect allow/deny, Principal Type role/group/user, Principal). Delete is intentionally disabled.

### 6.9 Access Records (`AdminAccessControlsPanel.tsx` + `AdminCreateAccessRecordModal.tsx`)
- `Object*`, `Principal Type` (Role/Group/User), `Principal*`; **Object Access** checkboxes Read/Create/Update/Delete/View All/Modify All (with dependency logic); **Attachment access** editor; **field-level** read/edit editor. Detail: Save / Reset / Delete.
- **Connections:** the primary lever that makes objects/records/fields visible & editable in Keystone.

### 6.10 System Settings (`AdminSystemSettingsPanel.tsx`)
One card per setting (label + help + key chip + description) with type-aware control (boolean checkbox / json textarea / number/text input, Enter saves), Save (dirty-gated) + Reset. Read-only state if not allowed. Drives things like allowed file types, access-log toggles, page sizes, UI chrome, app display name.

### 6.11 Email Logs / Scheduled Jobs / Audit Logs / Recycle Bin / Search Results / Agent
- **Email Logs:** list (Logged At, Delivery Status badge, Subject, To, Source Record, Actor); row → full email detail.
- **Scheduled Jobs:** health chips (Due/Running/Error/Worker); New/Edit job (Name, cron + human preview, Timezone, Misfire skip/catch_up/run_once_now, Enabled, Parameters JSON or script, Retry Policy JSON); actions Run Now / Pause / Resume / Delete; Runs + Run Logs + Retry/Cancel.
- **Audit Logs:** field-level metadata audit list (read-only).
- **Recycle Bin:** Deleted Records list; row **Restore**/**Purge**, bulk Purge + Restore (N); confirm modals; partial-failure summary ("Restore parent first"). Restore returns metadata to active system + Keystone.
- **Search Results:** full-page grouped global-search results.
- **Agent:** Admin AI assistant (chat, modes, history, prompt audit).

**Admin API base:** reads `${API_BASE}/api/...`; mutations `${API_BASE}/admin/...`. ~140 functions in `apps/admin/src/api.ts`.

---

## 7. Keystone (end-user) App — screens & functional requirements

All requests send `Authorization: Bearer <token>` + `credentials:include`; 401 → single silent refresh → `auth:expired`. Everything is driven by `GET /api/apps/{appId}/objects/{object}/describe` + access endpoints (`fetchObjectAccess`, `fetchRecordAccess` → `allowed.{read,create,update,delete,attachments}`). Denied → `<PermissionDenied>` or hidden actions.

### 7.1 Topbar (`ShockwaveTopbar.tsx`)
- **Impersonation banner** (conditional).
- **App launcher** `.app-picker-button` aria-label "Apps" (search "Search apps"; empty "Create or grant app access before using Keystone"). → `GET /api/apps`. Selection persists (`last_app_id`).
- **Tabs picker** `.tabs-picker-button` aria-label "Tabs" (search "Search tabs"). → `GET /api/apps/{appId}/tabs`.
- **Agent** button.
- **Global Search** placeholder "Global Search" (disabled until app selected; min 2 chars; supports `object:term` scoping). → `GET /api/apps/{appId}/search?q=`.
- **User menu:** Last login, Preferences, Docs, Recycle Bin, Log out.

### 7.2 Workspace tabs (`ShockwaveWorkspace.tsx`, `ShockwaveRecordTabs.tsx`, `ShockwaveSubtabs.tsx`)
Multi-tab workspace; tab types `object | record | custom | data_import | agent | flows | flow_run | recycle_bin | search_results`. Closable tabs (object-home for active record's object is protected); related records open as **subtabs**.

### 7.3 Object Home / List View (`ListViewObjectHome` + `listViewAdapter.ts`)
- Toolbar: list-view selector, pin, view-mode (table/kanban/chart), Summary, total ("N records"), Refresh, Settings, Fit columns, Export CSV/PDF, search, **New {object}** (only if create access).
- Table: columns from list-view `columns_json`, sortable/resizable/reorder/wrap, row checkboxes, hover summary, **inline edit** (double-click; gated by object `inline_edit_enabled`), row click → record tab.
- Bulk: select-all-matching, **Bulk Delete** (gated by bulk+delete access), bulk update.
- Settings modal: filters, columns tree, **sharing** (private/role/group/user), sort, pin, default, create/clone/delete list view.
- → `POST .../list-views/query`, list-view CRUD, `bulkListViewAction`, `exportListView`, prefs.
- **AC:** add field in Admin → appears in column picker; remove create access → "New" hidden.

### 7.4 Create Record modal
Title "New {object}". Body from creation-layout sections; controls per field type (text/number/date/datetime/time/textarea/rich text/picklist/multi-picklist/boolean radios/reference lookup/file-disabled-until-saved). Required `*`. Record-type radios when multiple active. Footer: Cancel / **Create** / **Create & New**. → `POST .../records`. Auto-name modes hide/show Name field.

### 7.5 Record Home (`ShockwaveRecordPanel.tsx`)
- **Hero:** object label + name + status pill; actions **Edit** (if editAllowed), **Delete** (if deleteAllowed), **Run Flow** (if edit-mode flow), Admin-defined buttons, **Copy record link** (aria-label "Copy record link").
- **Layout sections** (from `record_layout`): types fields/form/summary/system/related/attachments/audit, collapsible, per-section Edit.
- **Field cards:** hover-edit pencil; reference values are links opening subtabs.
- **Related lists:** New (if create), Link existing (if editable), View all; inline cell edit on name/status; per-row edit/delete/unlink.
- **Edit footer:** Cancel / Save (dirty-gated).
- → `GET .../records/{id}` (user object → `/api/users/{id}`); `PATCH .../records/{id}` with **`If-Match: "rv-{rowVersion}"`** optimistic concurrency + `X-Update-Source`; `DELETE`. Stale rowVersion → **conflict comparison modal**.

### 7.6 Attachments (`ShockwaveAttachmentsPanel.tsx`)
Header "Attachments"; field selector (>1 file field), **Upload**, **Attach Existing**, drag-drop. Table: Name/Category/Size/Uploaded/By/Notes/Actions; actions Download / Download PDF (text-like only) / Delete. Upload modal: allowed-extensions+max-MB guidance, "Upload category*", Notes. States: PermissionDenied "Attachment access is restricted" / "No attachment fields are configured" / "No attachments yet". → file upload/link/download/delete endpoints.

### 7.7 Record Audit Log (`ShockwaveRecordAuditListView.tsx`)
List view of audit entries (action, action_at, actor link, field_name, old/new). → `POST .../records/{id}/audit/query`, export. AC: edit a field → audit row with old/new + your username.

### 7.8 Lookup input + Lookup List modal (`LookupInput.tsx`, `LookupListModal.tsx`)
Debounced search (min 1), Clear, "New {object}" inline create, "View all". Modal: "Select {object}", lookup list views (separate, `lookup_only`), search, Columns, row-click select. → `lookupSearch` (`GET .../lookup?q=&object_id=`), `fetchLookupTarget`, `createRecord`.

### 7.9 Picklists (`ShockwavePicklistDropdown.tsx`, `ShockwaveMultiPicklistDropdown.tsx`)
Searchable panel; "Select" clears; if `restrict_picklist_to_values===false` → custom-value entry. Options = active `picklist_values`. AC: deactivate value in Admin → disappears.

### 7.10 Global Search Results tab (`ShockwaveSearchResultsTab.tsx`)
Two-pane: left per-object counts, right grouped DataTables (primary column → record). Inclusion = `global_search_enabled`; per-object cap = `global_search_results_limit`; columns from `search_layout`.

### 7.11 Recycle Bin (`ShockwaveRecycleBinPanel.tsx`)
"Deleted Records" list; row Details/Restore/Purge; bulk Purge + Restore (N). Modals: Confirm Restore, **Resolve Restore Conflict** (unique override), **Restore Parent Record** (dependency), Confirm Purge, partial-failure summary, Details (read-only snapshot rendered with the object layout). → recycle endpoints. 28-day retention.

### 7.12 Data Import Wizard (`ShockwaveDataImportPanel.tsx`)
3 steps: **Choose data** (object picker, action Add/Update/Add+Update, CSV upload + preview), **Edit mapping** (auto-map, **Matching field** required for update/add_update, per-column Map modal), **Start import** (summary, **Start Import**, status cards Import/Email/Processed/Errors, poll every 4s). Gated by app **import** permission. → `submitDataImport` (`POST .../data-import/submit`).

### 7.13 Flows Home / Flow Run (`ShockwaveFlowsHome.tsx`, `ShockwaveFlowRunPanel.tsx`)
- Home: list views **Available Flows** (Start create-mode) / **Executed Flows** (status tabs All/In Progress/Completed/Cancelled/Failed; Resume/View + Run Log). Run Detail + Run Log modals.
- Run panel: stepper, per-step fields (all types, visibility rules), Back/Next/Save&Exit/Cancel/Submit, lock handling, draft-record ensure, file upload. → flow execute endpoints. Submit → record(s) created → opens record.

### 7.14 Agent / Custom Tab / Preferences / Metadata Info
- **Agent workspace:** chat + voice + history + prompt audit (`/api/agents/*`).
- **Custom Tab:** external URL — iframe (embed) or "Launch Website" (new window).
- **Preferences modal:** Timezone, Date format, Default List View Page Size, Theme (many), PDF export mode, Compact tables. → `/api/users/me/preferences`. Theme applies live.
- **Metadata Info dialogs:** info buttons show admin-configured help text (only when configured).

**Keystone selectors for Playwright:** buttons by text ("New {object}", "Edit", "Delete", "Run Flow", "Restore", "Purge", "Start Import", "Create", "Create & New", "Save", "Cancel"); aria-labels "Apps"/"Tabs"/"Global Search"/"Copy record link"; modal titles via `<h3>`; inputs via placeholders ("Global Search", "Search apps", "Search tabs", "Search options...").

---

## 8. App Service — backend feature/business-rule reference

All routes are **unprefixed**: admin `/admin/*` (`requireAdmin`), runtime `/api/*` (`app.authenticate`), auth `/auth/*`. Errors are RFC-7807 (`sendProblem`); PG unique violation (23505) → `409` with parsed field. IDs = `<3-char-prefix>` + 7 chars `[a-z1-9]` (record IDs CSPRNG, 3 retries on collision).

### 8.1 Records CRUD (`records/routes.ts`) — `/api/apps/:appId/objects/:object`
- `GET /records` (offset pagination, **per-row access filtering** — pages can be short, no total), `POST /records`, `GET /records/:id`, `GET /records/:id/access`, `GET/POST /records/:id/audit[/query|/export]`, `PATCH /records/:id`, `DELETE /records/:id`, `POST /buttons/:buttonApi/execute`.
- **Create pipeline (one transaction):** object create access → allowed/denied field filter (`403 field_write_denied`) → type validation per field → defaults + record-type picklist defaults → record-type resolve → required check (skippable for flow drafts via `x-core-platform-flow-draft`) → **beforeInsert validations → beforeInsert triggers** → name generation (defaults: name←id, status←"Active") → unique pre-check → INSERT (`row_version=1`) → audit → **afterInsert triggers** → enqueued cross-record updates → access log + automatic emails. `201` + `ETag`.
- **Update:** load in scope → record update access (deny → `404`) → **precondition required** (`If-Match` or `if_unmodified_since`, else `428`) → version mismatch → `409` → field filter/validate → beforeUpdate validations+triggers → required/unique → UPDATE guarded by `row_version` → audit → afterUpdate triggers → enqueued updates.
- **Delete:** record delete access (deny → `404`) → beforeDelete validations+triggers → **cascade master-detail children** → DELETE → **recycle-bin snapshot (28-day)** + file cleanup → audit → afterDelete triggers. (No concurrency precondition required for delete — can race an update.)
- **System fields** server-managed; `Agent` object update blocked.
- **AC examples:** create `{name:"Acme-4821",amount:1234.5}` → 201 ETag `"rv-1"`; missing required → 400; bad email → 400; update without If-Match → 428; stale If-Match → 409; non-owner read w/o view_all → 404; trigger throw → 400 + rollback.

### 8.2 List Views (`list-views/routes.ts`)
- `GET/POST/PATCH/DELETE list-views`, `/clone`, `GET/PUT /preferences`, `POST /query` (main data), `POST /bulk`, `POST /export`.
- **Sharing:** owner always; public all; private none; specific/user/role/group scoped (`canAccessListView`). **Query** enforces object read (deny → 404) + sharing; page size from `pagination.page_size` else `system.list_view.page_size` (100). Related-field columns via relationship index (depth capped).
- **Bulk:** max 50000; needs per-id `expected_row_versions` or `if_unmodified_since` (else 428); reuses record-update lifecycle.
- **Export:** requires `export` permission; **synchronous & row-capped** (`resolveExportMaxRows`) — "full dataset" is bounded by that cap. (Async export-job producer `createExportJob` is **dead code**; only status/download routes are live.)

### 8.3 Search (`search/routes.ts`)
- `GET /search?q=&limit=` (only `global_search_enabled` objects; per-object cap; per-row access), `GET /lookup` (validates the source field references the target), `GET /lookup/target`.

### 8.4 Validations (`validations/engine.ts`)
- Rules by object+event (`beforeInsert/beforeUpdate/beforeDelete`), `enabled!==false`. Three forms: **script** (sandboxed), **formula** (`expression`, related-field resolution, truthy=violation), **operator** (`op/field/value`: required/is_null/eq/ne/lt/lte/gt/gte/in/not_in/contains/starts_with/ends_with, dotted paths). Failure → `400 validation_failed`. **Not cached** — live each save.

### 8.5 Triggers (`triggers/engine.ts`, `worker.ts`, `preflight.ts`)
- Before/after insert/update/delete, name-ordered. **Limits** (system settings): `max_recursion=25`, `max_chain_iterations=25`, `max_ms=10000`, `max_memory_mb=128`. Chaining on before-insert/update; cycle detection. **Sandbox** = `worker_threads` with memory cap + hard-kill timeout; `preflight` bans require/import/process/globalThis/eval/Function/Buffer/child_process/fs/net/http/setInterval/`while(true)` (regex-based — note for security testing). Every run → `trigger_audit_log`. `TRIGGER_RUNTIME=noop` disables.
- **AC:** beforeInsert sets a field → persisted; throw → 400 + no row; self-retrigger >25 → `trigger_chain_limit_exceeded`; `require(` → rejected.

### 8.6 Flows (`flows/routes.ts`, `flows/admin-routes.ts`)
- Runtime app-level + object-level: `execute/start|next|back|save-exit|ensure-draft-record|cancel|submit`, `runs`, `runs/:id/resume`. Admin CRUD of flows/steps + reorder. All gated by **`flow` permission**. Session in `runtime.flow_session` with locking (`lock_token`). Draft creates skip required validation; final submit enforces it.

### 8.7 Scheduler (`scheduler/*`, `admin/routes.scheduler.ts`)
- 5-field cron + timezone (validated), misfire skip/catch_up/run_once_now, retry policy, leasing + heartbeat + `max_run_seconds` timeout → `timed_out`. Scheduled record create/update run **full validation+trigger lifecycle**. Routes: CRUD + pause/resume/run-now + runs/logs/retry/cancel (super-user gated).

### 8.8 Data Import (`data-import/service.ts`)
- `POST /api/apps/:appId/data-import/submit` — requires app **import** permission + requester email + ownership of the tracking record + linked `ready` source file. Action add→create / update→update / add_update→both. Restricted fields never imported. Per-row through scheduled-record lifecycle (validations+triggers); resumable; results CSV attached + completion email.

### 8.9 Exports (`exports/*`)
- `GET /api/export-jobs/:jobId[/download]` — ownership + re-validated export/object/sharing/field access; `409 export_not_ready`, `410 export_expired`. Worker pages CSV/PDF. (Producer path unused — see 8.2.)

### 8.10 Files / Attachments (`files/routes.ts`)
- List/upload(multipart)/download/download-pdf/link/delete. Upload: field must be `file` type; extension+category validated; record update + attachment upload + field write access; size cap → `413`; SHA-256 checksum; writes `meta.file`+`file_link`+record field jsonb + audit. Download: only `ready/upload`; authorized via active links + object read + attachment download + field read. Link: same-app only. Delete = soft-detach (restorable with record).

### 8.11 Recycle Bin (`recycle-bin/service.ts`)
- `GET /api/apps/:appId/recycle-bin`, `POST /api/recycle-bin/:id/restore`, `DELETE /api/recycle-bin/:id` (+ admin equivalents). 28-day retention (`purge_after_at`). Restore checks parent dependency (`409 dependency_missing`) + unique conflict (`409 restore_conflict`), re-inserts (`row_version+1`), re-activates files, recursive child restore. Meta restore reloads metadata + re-applies schema.

### 8.12 Email notifications / Buttons / Agents / Logging / Cache
- **Email:** automatic templates on after-insert/update/delete (best-effort, never blocks the write); delivery logged.
- **Buttons:** URL (client) or `process` (server registry — only `sample_process` registered; missing handler → 400); execute needs `execute` permission + per-record read.
- **Agents:** OpenAI-backed (`OPENAI_API_KEY`); chat/realtime/history/prompts/audit; sessions persisted.
- **Logging:** access log (allow/deny gated by system settings + per-object flags; record-open uses distinct actions); per-object/meta audit honoring per-field `audit_log_enabled`.
- **Cache:** in-process TTL ~60s for object/field/permission; Redis only for rate-limiting (falls back to in-process). After an Admin permission change, effects appear within ~60s unless explicitly invalidated.

### 8.13 Admin metadata APIs
Apps, objects (+fields/layouts/forms/record-types/validation/triggers/buttons/email-templates), tabs, access-records, access-control, permissions(+grants), roles/groups(+members), users(+password/login-as), icons, system-settings, audit, scheduler. All `requireAdmin`; labels/api_names/prefixes uniqueness-constrained (case-insensitive); deletes go to recycle bin.

---

## 9. Admin → Keystone propagation matrix (the #1 deliverable)

| Admin action | Backend effect | Where it shows in Keystone | How to verify | Timing/cache |
|---|---|---|---|---|
| **Create App** | `meta.app` row | App launcher (filtered by `canViewApp`) | Admin sees it instantly; non-admin only after `app:view` permission + non-deny access_control | Immediate (admin); non-admin ACL cache ~60s |
| **Create Object** | table + RT + 5 layouts + form + assignments + system fields + "All" list view | **Not visible** until a Tab + access_record exist | create object → no Keystone change yet | Immediate DB |
| **Create Field** | ALTER TABLE add column (+indexes); **not added to layouts** | column picker immediately; **edit/create form only after added to layout** | add field → reload Keystone record/list | Immediate (some reads ~60s cache) |
| **Create Tab** | `meta.tab` (+`tab:view` permission) | Keystone tab bar (filtered by `canViewTab`) | admin sees instantly; non-admin needs tab view access_control + permission | Immediate (admin); ~60s (non-admin) |
| **Create Access Record** | object/record/field perms for principal | object/records readable/editable; fields hidden/masked per rules | as target user: object appears, masked field masked | **~60s** perm-set cache |
| **Permission grant** | capability gating | app/tab/**buttons** visibility | grant button `execute` → button appears | ~60s principals cache |
| **Edit Layout** | `meta.layout.definition_json`/assignment | record detail/edit re-renders (precedence user>role>group>default, record-type aware) | reopen record | Immediate next `describe` |
| **Add Validation rule** | `meta.validation_rule` | Keystone **blocks invalid save** with message | create/update violating record → 422 | **Immediate** (no cache) |
| **Add Trigger** | `meta.trigger_rule` | side effects on create/update | create record → observe mutation + `trigger_audit_log` | **Immediate** |
| **Add Flow** | flow + steps | multi-step flow UI in Keystone | open create/edit with active flow | Immediate next fetch |
| **Scheduled job** | row → scheduler worker | job effects surface in lists | `run-now` → check runs/logs + records | within ~5s poll (worker running) |
| **Picklist values** | `meta.field.picklist_json` | form dropdown options (active, RT-filtered) | add value → reopen form | Immediate next describe |

---

## 10. End-to-end cross-app test scenarios

Use `admin/admin` for Admin (5002), a seeded test user for Keystone (5003). Use random suffixes to dodge unique-constraint 409s.

1. **App visibility (capability gating):** create app `Logistics_7f3`/`lg`; non-admin launcher hidden; add `app:view` perm + non-deny access_control → appears within ~60s.
2. **Full object chain:** object `Shipment_a1`/`shp` → object Tab → access_record read/create → object tab appears, "All" list loads, New works; revoke → disappears after TTL.
3. **Field → form propagation (gotcha):** add text field `tracking_code` → shows in column picker but **not** edit form; add to record_edit layout → now on form.
4. **Picklist:** add `priority` low/medium/high → dropdown shows them; deactivate `high` → gone.
5. **Validation blocks save:** rule `{beforeInsert, field:tracking_code, op:required}` → create without it → 422 with message; with it → 201.
6. **Trigger fires:** afterInsert sets `status='received'` → create → status auto-set; check audit + `trigger_audit_log`.
7. **Field masking:** access_record read + field `{mask:true}` → record shows masked/read-only; describe omits write.
8. **Record-level scope:** read without `view_all` → user sees only own/subordinate records; peer's record → 403/404; grant `view_all` → all visible.
9. **Impersonation:** Login As → new Keystone tab with handoff → banner; reuse handoff URL → 409.
10. **App-scope inheritance:** parent `Core_x9` + child `Sales_x9`; object on parent → visible under child (ancestor scope).
11. **Tab vs object access:** object access granted but no tab view → reachable via search/lookup, tab hidden; add tab access_control → appears.
12. **Scheduled job → Keystone:** job inserts a Shipment → run-now → record appears in list within poll window (scheduler worker required).
13. **Concurrency:** two edits to same record → second gets conflict comparison modal (If-Match rowVersion).
14. **Recycle/restore:** delete record → in Keystone Recycle Bin → restore; if active record holds same unique value → restore conflict override; deleted child whose parent also deleted → "restore parent first".
15. **Attachments:** upload `.exe` where only `.pdf` allowed → 400; oversize → 413; delete then restore parent → file re-activates.
16. **Data import:** CSV (3 rows, 1 bad) Add → completes with 1 error row + results CSV + email; Update with no match field → Next disabled.
17. **Export gating:** export without `export` permission defined+denied → 403; with → CSV downloads.
18. **Auth edge cases:** wrong password → 401; deactivated account → 403; self-service reset → all old sessions 401; admin reset → old sessions survive (asymmetry).

---

## 11. Edge cases & gotchas to put in the test plan

- **Default-deny vs fail-open split:** access_records default-deny; `checkPermission` fails open EXCEPT app/tab visibility which is closed-until-defined. Test both states.
- **OR-merge access records, no per-record deny** — denies only exist in access_control / permission_grant.
- **Manager chain escalates access** in three evaluators (record scope, access-control inherit, permission inherit) — test a manager seeing subordinates' data.
- **Fields don't auto-join layouts** — #1 false-negative source for "I added a field but don't see it."
- **PATCH requires a precondition (428); DELETE does not** — delete can race an update.
- **List GET returns short pages (access-filtered) and no total count.**
- **Exports are synchronous and row-capped** — "export all" is bounded; async pipeline is dead code.
- **~60s caches** on access/permission/metadata — visibility changes lag up to a TTL; validations/triggers are immediate.
- **username is NOT unique**; label/api_name/prefix ARE (case-insensitive).
- **Two separate browser sessions** for Admin vs Keystone (different storage namespaces); no SSO except impersonation.
- **`NODE_ENV=development` disables CORS checks.**
- **Trigger sandbox bans are regex-on-source** — potential bypass via string-splitting (security test).
- **Recycle retention = 28 days** (`purge_after_at`); past that → purged, not restorable.
- **Bootstrap admin** cannot be disabled; **`system_admin` role** cannot be renamed/deleted; **single role per user**.

---

## 12. Coverage checklist (module → test type)

| Area | Manual smoke | E2E (Playwright) | API/integration |
|---|---|---|---|
| Auth/login/logout/refresh/reset | ✔ | ✔ | ✔ (401/403/428/409 paths) |
| Impersonation handoff | ✔ | ✔ | ✔ (one-time-use 409) |
| App/Object/Field/Tab CRUD (Admin) | ✔ | ✔ | ✔ (uniqueness 409, side effects) |
| Access records / field masking / row scope | ✔ | ✔ | ✔ (default-deny, view_all) |
| Access-control + permission gating (app/tab/button) | ✔ | ✔ | ✔ (fail-open vs closed) |
| Records CRUD + concurrency | ✔ | ✔ | ✔ (ETag/If-Match) |
| List views (filter/sort/share/prefs/bulk/export) | ✔ | ✔ | ✔ |
| Validations / Triggers | – | ✔ (via Keystone save) | ✔ (limits, sandbox) |
| Flows (create/edit/run/resume/lock) | ✔ | ✔ | ✔ |
| Scheduler | ✔ | – | ✔ (cron, run-now, timeout) |
| Data import | ✔ | ✔ | ✔ |
| Files/attachments | ✔ | ✔ | ✔ (type/size/sharing) |
| Recycle bin (restore/purge/dependency/conflict) | ✔ | ✔ | ✔ |
| Global search / lookup | ✔ | ✔ | ✔ |
| Audit & access logs | ✔ | – | ✔ |
| App-scope ancestor inheritance | ✔ | ✔ | ✔ |

---

*Generated from code-only analysis of `D:\core-platform` (apps/service, apps/admin, apps/shockwave). Every rule above is traceable to a route handler, service, or component cited in the section.*

---

# 13. LIVE VERIFICATION RESULTS (Playwright MCP, executed against running apps)

This section records **actual results** from driving the live apps (Admin :5002, Keystone :5003, Service :5001) with the Playwright MCP on 2026-06-08, logged in as `admin/admin`. Each Admin action was performed in the UI and its effect confirmed in Keystone and/or via the backend API (ground-truth system values). Screenshots are under `evidence/admin/` and `evidence/keystone/`.

## Test fixture created (the connected chain)
| Entity | Created via | System-generated ID | Notes |
|---|---|---|---|
| App "QA Audit MCP" | Admin UI → Apps → New | `app9dqjy3b` | prefix `qz1`, parent `app0000001` (Core Platform) |
| Object "Invoice" | Admin UI → Objects → New (2-step) | `obj2lf5p5u` | prefix `iqz`, in app9dqjy3b |
| Tab "Invoice" | Admin UI → Tabs → New | `tabtc2293i` | object tab |
| Fields | Admin UI → Object → Fields → New | — | `tracking_code` (text), `amount` (currency), `priority` (picklist low/medium/high), `due_date` (date) |
| Records (Keystone) | Keystone UI → New | `iqztsezw4q`, `iqz5soas62`, `iqz8gkwnbr` | record IDs use object prefix `iqz` + 7 random chars |
| Validation rule | API (Admin UI overflow) | `valkuq6wdp` | "Amount Required" |
| Trigger rule | API (Admin UI overflow) | `trgmmf1e9g` | "Auto Tracking Code" |

## Confirmed system-generated values (ground truth from API)
- **App create** → `created_by: usradmin1`, `created_at`/`modified_at` set; **edit** advanced `modified_at` only. Auto-created 2 permission defs: `app:view` (`perj5lu6vz`) + `app:import` (`per2ipltwu`). ✔
- **Object create** auto-provisioned: default record type `master` (`rtplddrkzw`, is_default=true), **7 system fields** (id, name, status, created_by, created_at, modified_by, modified_at), **5 layouts** (record_layout, record_edit, record_creation, summary_dialog, search_page), **2 list views** ("All" + "Lookup List View"), and the business table. ✔
- **Record create** → `id` = `iqz`+7 chars (CSPRNG), `status` defaults to **"Active"** (server-assigned), `row_version` = **1**, `created_by`/`modified_by` = `usradmin1`, timestamps set. ✔
- **Record update** (If-Match `"rv-1"`) → 200, `row_version` **1 → 2**, `modified_at` advanced. ✔
- **Concurrency:** stale If-Match `"rv-1"` → **409**; missing precondition → **428**. ✔ (matches §8.1)
- **Audit log:** **one row per field**, `action` create/update, old→new values (e.g. amount `null → 999.99`; create rows for status/tracking_code/priority). ✔ (matches the per-field ADR)
- **Metadata audit:** per-field rows on app create; on edit, a `label` old→new row + a `modified_at` row. ✔

## Confirmed Admin → Keystone propagation (verified live)
| Admin action | Keystone result | Verified |
|---|---|---|
| Create App | App "QA Audit MCP" appears in Keystone app launcher (searchable) | ✔ |
| Create Object + Tab | "Invoice" tab appears in Keystone Tabs picker; object describe returns 200 | ✔ |
| App hierarchy | New child app's Objects/Tabs lists **inherit parent (Core Platform) objects** (Asset, Site, Vendor, Data Import) — ancestor scoping live | ✔ |
| Add fields | Fields appear in describe **but NOT on the Keystone create form** until added to the `record_creation` layout — **confirmed the "fields don't auto-join layout" gotcha** (create form first showed only Name+Status) | ✔ |
| Edit layout (add fields) | After adding the 4 fields to `record_creation`, the Keystone "New Invoices" form immediately showed Tracking Code, Amount, Priority, Due Date | ✔ |
| Picklist values | Keystone Priority dropdown shows exactly Low/Medium/High; selecting High persisted `priority:"high"` | ✔ |
| Validation rule (amount required) | Keystone create without amount is **blocked** with the exact message "Amount is required for invoices." (immediate, no cache) | ✔ |
| Trigger rule (auto tracking_code) | Keystone create with blank tracking_code → server auto-set `tracking_code:"AUTO-<name>"` | ✔ |

## Additional live findings / gotchas (new, beyond the code audit)
1. **Picklist option requires BOTH a Value and a Label, AND must be marked Active** — the create-field modal rejects with "Each picklist option requires a label." then "Picklist fields must include at least one active value." (test data must set all three).
2. **Tab create does NOT auto-fill Label/API Name** from the selected object — both are required and must be typed, or you get "Label is required / API Name is required."
3. **List view "All" columns** also do not include new custom fields by default (only system columns) — list-view columns are configured separately from fields, same as layouts.
4. **Keystone tab/app selection is sticky** (`last_app_id`/last tab); deep-linking via `?appId=&tab=&object=` may redirect to the last tab — use the in-app App/Tab pickers to switch reliably.
5. **Layout Designer is drag-and-drop**; Playwright's synthetic `dragTo` did **not** persist drops into sections (saved an empty `fields:[]`). For automation, use the layout's **Advanced JSON** editor or the `PATCH /admin/objects/:id/layouts/:layoutId` API (`{definition_json:{sections:[...]}}`) instead of synthetic drag.
6. **Admin & Keystone require separate logins** (different `sessionStorage` namespaces: `core_platform.*` vs `shockwave.*`) — confirmed live.
7. **Validation/Trigger authoring endpoints**: `POST /admin/objects/:id/validation-rules` expects `{name, rule_json:{event, op|expression|code, field, value, message}}`; `POST /admin/objects/:id/trigger-rules` expects `{name, trigger_json:{event, code}}` where code is the body of `async (api)=>{...}` with `api.record.get()/set()` and `api.validation.addError()`.

## Object Home sub-sections confirmed present (the "heart")
Settings, Record Types (1: master), Fields (7 system + 4 custom), Buttons (0), Email Templates (0), Layout (5), Form (1), Assignments, Validation Rules, Trigger Rules, Audit Log (per-object metadata changes). All reachable from the Object record's sub-tab bar (+ "More" overflow).

## Security & access propagation — verified live (Roles/Users/Access Records/Permissions/Impersonation)
Fixture: role "QA Reviewer MCP" (`roldptceb4`), user "qa.reviewer.mcp" (`usr1hsvexy`), access record (`acr91tnvtq`) granting the role `read + view_all` on Invoice, plus `app:view` and `tab:view` permission grants to the role.

| Test | Result | Verified |
|---|---|---|
| Create Role (Admin UI) | id `roldptceb4`, name unique | ✔ |
| Create User (Admin UI) | id `usr1hsvexy`, status active, temp password set | ✔ |
| Assign role (single-role-per-user) | `PUT /admin/users/:id/roles` → 200 | ✔ |
| Create Access Record (role→Invoice, read+view_all) | id `acr91tnvtq` | ✔ |
| **Login As** (Admin → Keystone impersonation) | new Keystone tab; `/api/users/me` → `username: qa.reviewer.mcp`, `is_impersonating: true`, `actor: admin`; banner shown | ✔ |
| Granted object access (Invoice) | `read:true, create:false, update:false, delete:false`; **New/Edit/Delete buttons hidden in UI**; all 3 records visible (view_all) | ✔ |
| **Default-deny** (Vendor, not granted) | `read:false, create:false, update:false, delete:false` — invisible to the user despite being in-app | ✔ |
| App/Tab visibility gating | App + Invoice tab visible only after `app:view`+`tab:view` permission grants to the role | ✔ |

**Conclusion:** the UI never bypasses the backend — Keystone shows/hides apps, tabs, records, and actions strictly per the access records + permission grants, with admin impersonation reflecting the target user's exact permissions.

*Verification performed via Playwright MCP (`mcp__playwright__browser_*`) driving real Chromium against the running stack.*

## All 17 sidebar sections — coverage status (live)
| # | Section | What was tested live | Status |
|---|---|---|---|
| 1 | **Apps** | Create app (UI) → `app9dqjy3b`; Edit (label) → modified_at advanced; auto `app:view`+`app:import` perms; per-field metadata audit | ✅ CRUD |
| 2 | **App Hierarchy** | Tree shows Core Platform → QA Audit MCP nesting; Toggle orientation | ✅ render |
| 3 | **Search Results** | Global-search results page renders (grouped by component) | ✅ render |
| 4 | **Agent** | Admin AI console renders (chat/history/prompt audit) | ✅ render |
| 5 | **Objects** | Full deep CRUD + every sub-tab (Settings, Record Types, Fields, Buttons, Email Templates, Layout, Form, Assignments, Validation Rules, Trigger Rules, Audit Log) | ✅ deep |
| 6 | **Tabs** | Create object tab (UI) → `tabtc2293i`; label/api required (no auto-fill) | ✅ CRUD |
| 7 | **Flows** | Flow list + authoring panel renders (Name/API/Mode/Version/Active/Default) | ✅ render |
| 8 | **Roles** | Create role (UI) → `roldptceb4`; assign to user | ✅ CRUD |
| 9 | **Groups** | Create group → `grpls526wl`; **delete → Recycle Bin → restore** | ✅ CRUD+recycle |
| 10 | **Users** | Create user (UI) → `usr1hsvexy`; Login As (impersonation) | ✅ CRUD |
| 11 | **Permissions** | Panel renders; created permission defs + grants (app:view, tab:view) verified via grants | ✅ CRUD |
| 12 | **Access Records** | Create access record `acr91tnvtq` (read+view_all); enforced in Keystone | ✅ CRUD+propagation |
| 13 | **System Settings** | Renders all keys (trigger limits, page sizes, export caps); update enforces typed validation (400 on type mismatch) | ✅ render+validation |
| 14 | **Email Logs** | List renders (Logged At/Status/Subject/To/Source/Actor) | ✅ render |
| 15 | **Scheduled Jobs** | Health chips (Due/Running/Error/Worker idle) + 3 jobs listed | ✅ render |
| 16 | **Audit Logs** | Field-level metadata audit list renders; per-field create/update rows verified | ✅ render+verified |
| 17 | **Recycle Bin** | Deleted group appears with 28-day `purge_after`; **Restore** returns it to Groups | ✅ delete→restore |

**Overall:** all 17 Admin sidebar sections were driven live via the Playwright MCP; the metadata→Keystone propagation chain (App→Object→Fields→Layout→Tab→Record), the access/permission model (default-deny, read-only grant, impersonation), validations, triggers, audit, concurrency, and recycle/restore were each confirmed against the running stack. Evidence screenshots: `evidence/admin/01..16-*.png`, `evidence/keystone/01..06-*.png`.
