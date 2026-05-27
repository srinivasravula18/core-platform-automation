# Permissions and Access Records E2E Coverage Plan

## Summary

Build a dedicated Playwright suite for permissions and access records inside the existing list-view regression framework. The suite must cover Admin UI creation/edit/delete, API contract validation, effective permission enforcement in Keystone business records, and negative security cases.

This plan is grounded in the current GitNexus index for `D:\core-platform`, indexed on 2026-05-27. GitNexus shows the permission/access surface connects these areas:

- Admin access-record and access-control routes: `apps/service/src/admin/routes.access.ts`
- Permission metadata and grants API: `apps/service/src/permissions/routes.ts`
- Permission evaluator: `apps/service/src/permissions/evaluator.ts`
- Object/record access evaluator: `apps/service/src/access/evaluator.ts`
- Effective principals: `apps/service/src/access/effective-principals.ts`
- Admin roles/groups routes: `apps/service/src/admin/routes.roles-groups.ts`
- Keystone app/object/list/record APIs: `apps/service/src/apps/routes.ts`, `apps/service/src/list-views/routes.ts`, `apps/service/src/records/routes.ts`
- User access APIs: `apps/service/src/users/routes.ts`
- Downstream access users: exports, flows, search, recycle bin, files, data import, scheduler record jobs

## GitNexus Connection Map

## Admin Action to Enforcement Model

The suite must not stop at "API returned 200". Each positive E2E case follows the same chain:

1. Admin performs a permission/access-record operation.
2. Admin metadata persists through `/admin/access-records`, `/admin/access-control`, roles/groups, or `/api/permissions`.
3. `checkPermission` or `evaluateAccess` reads the changed metadata.
4. Connected Keystone, list-view, record, search, user, export, recycle-bin, flow, or import surface reflects the new permission state.

Required Admin workflows:

- Admin creates a role/group/user access record -> `meta.access_record` row exists -> list/get/detail returns the row -> object/list/record access becomes allowed for the effective principal.
- Admin edits object permissions -> `permissions_json` changes persist after reload -> field, attachment, `view_all`, and `modify_all` rules remain intact -> downstream read/update/delete/create checks change accordingly.
- Admin deletes an access record -> list row disappears and detail clears -> `GET /admin/access-records/:id` returns `404` -> downstream access falls back to denied, empty, or permission-denied state.
- Admin creates or patches access control -> `meta.access_control` row is created/upserted -> allow/deny is visible from list query -> app/tab/list-view permission gates use the new effect.
- Admin creates permission metadata and grants -> permission/grant rows exist -> `POST /api/permissions/check` returns the expected allow/deny reason -> GitNexus-connected routes keep respecting that result.
- Admin changes role/group membership -> effective principals change -> inherited role/group access appears or disappears without creating a direct user access record.

### Admin Configuration Surface

Routes:

- `POST /admin/access-records`
- `GET /admin/access-records`
- `GET /admin/access-records/:id`
- `PATCH /admin/access-records/:id`
- `DELETE /admin/access-records/:id`
- `POST /admin/access-control`
- `GET /admin/access-control`
- `PATCH /admin/access-control/:id`
- `DELETE /admin/access-control/:id`
- `POST/GET/PATCH/DELETE /admin/roles`
- `POST/GET/PATCH/DELETE /admin/groups`
- Role/group user assignment routes under `/admin/roles/:id/users` and `/admin/groups/:id/users`

Primary symbols:

- `registerAdminAccessRoutes`
- `ensureActiveDirectUserPrincipal`
- `registerAdminRoleGroupRoutes`
- `requireAdmin`
- `sendProblem`
- `logAdminAccess`
- `logMetaAudit`
- `captureAdminRecycleEntry`

### Permission API Surface

Routes:

- `POST /api/permissions/check`
- `GET /api/permissions`
- `GET /api/permissions/export`
- `POST /api/permissions`
- `PATCH /api/permissions/:permissionId`
- `DELETE /api/permissions/:permissionId`
- `GET /api/permissions/:permissionId/grants`
- `POST /api/permissions/:permissionId/grants`
- `POST /api/permissions/:permissionId/metadata-grants`
- `DELETE /api/permissions/:permissionId/grants/:grantId`
- `DELETE /api/permissions/:permissionId/metadata-grants/:grantId`

Primary symbols:

- `registerPermissionRoutes`
- `ensurePermissionAdmin`
- `checkPermission`
- `ensureActiveDirectGrantUser`
- `findConflictingPermissionGrant`
- `hasRuntimePermissionGrantTable`
- `attachPermissionResourceNames`

### Enforcement Surface

GitNexus shows `checkPermission` is called by:

- `apps/service/src/apps/routes.ts`: app and tab visibility
- `apps/service/src/list-views/routes.ts`: list-view manage/query behavior
- `apps/service/src/records/routes.ts`: record operations
- `apps/service/src/exports/routes.ts`: export access
- `apps/service/src/flows/shared.ts`: flow permission checks
- `apps/service/src/data-import/service.ts`: import queue access
- `apps/service/src/admin/routes.ts`: scheduler/admin permission gates

GitNexus shows `evaluateAccess` is called by:

- `apps/service/src/apps/routes.ts`: object visibility and scoped object filtering
- `apps/service/src/list-views/routes.ts` and `utils.ts`: list/read policies
- `apps/service/src/records/routes.ts`: record read/create/update/delete paths
- `apps/service/src/search/routes.ts`: search visibility
- `apps/service/src/files/routes.ts`: file source access
- `apps/service/src/recycle-bin/routes.ts` and `service.ts`: recycle bin visibility/restore
- `apps/service/src/exports/routes.ts` and `worker.ts`: export job access
- `apps/service/src/flows/routes.ts`: referenced object access
- `apps/service/src/scheduler/record-jobs.ts`: scheduled record create/update
- `apps/service/src/data-import/service.ts`: import ownership checks

## New Spec Layout

Add:

```text
tests/e2e/list-view-regression/permissions-access-records.spec.ts
```

Reuse existing helpers from:

```text
tests/e2e/list-view-regression/helpers.ts
```

Required helper additions in the new spec or shared helper:

- `resolvePermissionSeedContext(request)`: resolves token, app, object, active user, disposable role, disposable group.
- `createDisposableRole(request, token)`.
- `createDisposableGroup(request, token)`.
- `assignUserToRole(request, token, roleId, userId)`.
- `assignUserToGroup(request, token, groupId, userId)`.
- `createAccessRecord(request, token, objectId, principalType, principalId, permissionsJson)`.
- `deleteAccessRecordBestEffort(request, token, id)`.
- `createAccessControl(request, token, resourceType, resourceId, principalType, principalId, action, effect)`.
- `deleteAccessControlBestEffort(request, token, id)`.
- `createPermission(request, token, resourceType, resourceId, action, scopeJson)`.
- `deleteGrantBestEffort(request, token, permissionId, grantId, source)`.

Writes must run only when:

```text
ALLOW_DATA_WRITE=true
```

Otherwise tests that mutate metadata must `test.skip()` with a clear annotation.

## Coverage Matrix

### Access Records Admin API

Tags: `@bvt @security @api`

- Create an access record for a role principal.
- Create an access record for a group principal.
- Create an access record for a user principal.
- Verify `permissions_json` persists for object, field, and attachment permissions.
- Patch `permissions_json`, fetch by ID, and assert update persists.
- List by `object_id`, `principal_type`, and `principal_id`.
- Delete access record and assert subsequent `GET /admin/access-records/:id` returns `404 not_found`.
- Verify duplicate object/principal pair returns `409 duplicate_access_record`.
- Verify inactive direct user principal returns `409 inactive_user`.

### Access Control Admin API

Tags: `@bvt @security @api`

- Create allow grant for `resource_type`, `resource_id`, `principal_type`, `principal_id`, and `action`.
- Re-post same identity with changed `effect` and verify upsert behavior.
- Patch `effect` from `allow` to `deny`.
- Patch `scope_json` and verify persistence via list query.
- Patch with empty body and assert `400 invalid_request` with `No updates provided.`
- Delete and assert subsequent patch/delete returns `404 not_found`.
- Invalid `principal_type`, missing `action`, or invalid `effect` returns `400 invalid_request`.

### Permission Metadata and Grants API

Tags: `@bvt @sanity @security`

- Create permission metadata for `resource_type=object`, selected `resource_id`, and an action such as `read`.
- List permissions filtered by `resource_type`, `resource_id`, and `action`.
- Patch `scope_json`; verify identity fields cannot be patched.
- Verify `DELETE /api/permissions/:permissionId` returns `409 invalid_state`.
- Create metadata grant for user, role, and group.
- Create runtime grant when `permission_grant_runtime` exists; otherwise assert `409 invalid_state`.
- Verify duplicate same-effect grant returns `409 conflict`.
- Verify opposite-effect conflict returns `409 conflict`.
- Verify inactive direct user grant returns `409 inactive_user`.
- Verify `POST /api/permissions/check` returns `allowed` and `reason`.
- Verify unauthenticated access to permission management returns `401`.
- Verify non-admin user, when seeded, receives `403 forbidden`.

### Keystone Effective Access

Tags: `@regression @security @keystone`

- Use Admin/API setup to create access for a target user, role, or group to one selected object.
- Verify allowed principal can see the app/object in Keystone through app and tab launchers.
- Verify allowed principal can query list views for the object.
- Verify denied or ungranted principal receives blocked, empty, or permission-denied state.
- Verify `read` access allows list/record read but does not expose create/edit/delete controls.
- Verify `modify_all` enables update paths and broader object actions expected by `evaluateAccess`.
- Verify `view_all` requires read behavior by checking list visibility and record detail visibility.
- Verify field-level rules:
  - hidden fields are absent from list/detail UI when metadata supports it.
  - masked fields render obscured values.
  - read-only fields render but cannot be edited.
- Verify attachment permissions persist and are reflected in UI controls where attachments are exposed.

### Downstream Regression Surfaces

Tags: `@regression @security`

These are required because GitNexus shows `checkPermission` and `evaluateAccess` feed them:

- List views: `/api/apps/:appId/objects/:object/list-views/query`
- Records: `/api/apps/:appId/objects/:object/records` and `/:id`
- Record access: `/api/apps/:appId/objects/:object/records/:id/access`
- Search: `/api/apps/:appId/search`
- Users: `/api/users/access`
- Exports: export routes and list-view export already covered by existing suite
- Recycle bin: business entry visibility/restore
- Flows: flow execution and referenced object checks when seeded flow metadata exists

Implement these as smoke assertions first: create access, call the downstream API, remove access, call again, and assert the response changes from allowed to denied/empty/not found according to the route contract.

### Admin UI

Tags: `@bvt @security @admin`

- Open Admin and navigate to Permissions / Access Controls.
- Verify the access-record list loads without crash or auth error.
- Create access record through UI for role, group, and user where controls expose all principal types.
- Toggle object permissions and verify dependency behavior:
  - `modify_all` implies broader edit/update permissions.
  - `view_all` requires or implies read visibility.
  - field permissions persist.
  - attachment permissions persist.
- Edit an existing access record, save, reload, reopen, and verify values remain.
- Delete an existing access record; verify it disappears and the detail tab or drawer clears.
- Capture screenshots after list load, create, edit reload, and delete.

## Negative Security Cases

Tags: `@sanity @security @regression`

- Missing `object_id` on `POST /admin/access-records`: `400 invalid_request`.
- Missing `principal_id` on `POST /admin/access-records`: `400 invalid_request`.
- Duplicate access record: `409 duplicate_access_record`.
- Direct inactive user access record: `409 inactive_user`.
- Patch unknown access record: `404 not_found`.
- Delete unknown access record: `404 not_found`.
- Invalid access-control `resource_type`, `principal_type`, `effect`, or missing `action`: `400 invalid_request`.
- Empty access-control patch: `400 invalid_request`, detail `No updates provided.`
- Rename/delete protected `system_admin` role: `409 conflict`.
- Duplicate role/group names: `409 conflict`.
- Permission API without token: `401`.
- Permission/admin access API with invalid token: `401`.
- Permission/admin access API as non-admin seeded user: `403` or configured deny response.

## Test Data and Cleanup

Use disposable IDs/names with a timestamp suffix:

```text
E2E Permission <timestamp>
E2E Access Role <timestamp>
E2E Access Group <timestamp>
E2E Access Record <timestamp>
```

Cleanup order:

1. Delete runtime permission grants.
2. Delete metadata permission grants.
3. Delete access-control rows.
4. Delete access-record rows.
5. Remove user assignments from disposable role/group.
6. Delete disposable role/group.

Do not delete metadata permissions if the API returns `409 invalid_state`; record the response and rely on reset.

## Evidence Requirements

Each scenario must attach:

- API response body for create/update/delete/negative cases.
- Screenshot for Admin UI load/create/edit/delete.
- Screenshot for Keystone allowed state.
- Screenshot for Keystone denied/empty state.

Evidence should stay in the existing Playwright output configured by:

```text
tests/e2e/playwright.list-view-regression.config.ts
```

## Run Plan

Discovery:

```powershell
npm run test:ui:list-view:list
```

Safe negative/API read checks:

```powershell
npx playwright test -c tests/e2e/playwright.list-view-regression.config.ts -g "Permissions|Access Records|@security"
```

Write scenarios:

```powershell
$env:ALLOW_DATA_WRITE="true"
npx playwright test -c tests/e2e/playwright.list-view-regression.config.ts -g "Permissions|Access Records|@security"
```

Full regression after the suite is stable:

```powershell
$env:ALLOW_DATA_WRITE="true"
npm run test:ui:list-view:full
```

## Acceptance Criteria

- All GitNexus-connected routes above have at least one positive or negative test.
- Access-record CRUD is covered through API and Admin UI.
- Permission metadata/grants are covered through API.
- Keystone object/list/record visibility changes when access changes.
- Negative cases assert exact status and problem type where the service defines one.
- Write tests skip when `ALLOW_DATA_WRITE` is not true.
- All created role/group/user assignments/access rows are cleaned up or isolated behind reset.
- Screenshots and API evidence are attached for every scenario.

## GitNexus Follow-Up Before Implementation

Before writing the spec, run these GitNexus checks again after reindex:

```text
list_repos
route_map(repo="core-platform")
context(registerAdminAccessRoutes)
context(registerPermissionRoutes)
context(checkPermission in apps/service/src/permissions/evaluator.ts)
context(evaluateAccess in apps/service/src/access/evaluator.ts)
impact(target="checkPermission", direction="upstream", includeTests=true)
impact(target="evaluateAccess", direction="upstream", includeTests=true)
```

If GitNexus reports degraded FTS indexes, still use `route_map`, `context`, and `cypher` as the source of truth, then rebuild the index before generating or refreshing tests.
