# Permissions E2E Bug Audit

Date: 2026-05-29  
Scope: Permissions only, with related Admin access-control and Keystone permission loading checks.  
Method: Playwright MCP browser testing against Admin `http://localhost:5002`, Keystone `http://localhost:5003`, and API `http://localhost:5001`. Core platform source was read-only from `D:\core-platform`.

Evidence folder: `D:\core-platform-automation\evidences\permissions-audit-20260529-084117`

## Summary

| ID | Severity | Area | Status |
| --- | --- | --- | --- |
| PERM-001 | High | Admin Access Control / Permissions | Confirmed |
| PERM-002 | High | Admin Access Control logging | Confirmed |
| PERM-003 | Medium | Admin Permissions CRUD | Confirmed |

## PERM-001 - App `import` Permission Exists, But Access-Control Rejects `import`

Severity: High

### Reproduction

1. Open Admin > Permissions.
2. Observe app permissions include `action = import`, for example `AUTO Platform QA 528A`.
3. Submit an access-control entry for the same app with `action = import`.

### Expected

If the platform creates `app/import` permission metadata, the linked access-control API should either accept `import` or the product should not expose/create this action as a grantable permission.

### Actual

The API rejects the payload:

```json
{
  "status": 400,
  "detail": "Invalid access control payload.",
  "errors": [
    {
      "field": "action",
      "message": "Choose one of: view, create, edit, delete."
    }
  ]
}
```

### Evidence

Screenshot: `D:\core-platform-automation\evidences\permissions-audit-20260529-084117\admin-permissions-import-row-api-repro.png`

Source context:

- `D:\core-platform\apps\service\src\permissions\app-import-permissions.ts` defines and creates `APP_IMPORT_ACTION = "import"`.
- `D:\core-platform\apps\service\src\metadata\schemas.ts` restricts `accessControlSchema.action` to `view/create/edit/delete`.
- `D:\core-platform\apps\admin\src\api.ts` types `createAccessControlEntry.action` as `view/create/edit/delete`.

### Likely Cause

Code/API contract mismatch. Permissions metadata supports `app/import`, but access-control schema and Admin API types do not.

## PERM-002 - Valid Access-Control Write Fails With Missing `logs.cpl_access_control_log`

Severity: High

### Reproduction

1. From Admin permissions/access-control context, submit a valid access-control payload:
   - `resource_type = app`
   - `action = view`
   - `principal_type = user`
   - `effect = allow`
2. Use an existing app and current admin user.

### Expected

The access-control record should be created or updated successfully.

### Actual

The API returns `500`:

```json
{
  "statusCode": 500,
  "code": "42P01",
  "error": "Internal Server Error",
  "message": "relation \"logs.cpl_access_control_log\" does not exist"
}
```

### Evidence

Screenshot: `D:\core-platform-automation\evidences\permissions-audit-20260529-084117\admin-permissions-import-row-api-repro.png`

Source context:

- `D:\core-platform\apps\service\src\admin\routes.access.ts` writes the access-control record, then calls `deps.logAdminAccess(...)`.
- `D:\core-platform\apps\service\src\logging\access-log.ts` writes into the computed logs table.

### Likely Cause

Environment/database migration issue. The route reaches logging after the access-control operation path, but the expected access-control log relation does not exist in the active database.

## PERM-003 - Permissions Page Can Create Standalone Permission That Cannot Be Deleted

Severity: Medium

### Reproduction

1. Open Admin > Permissions.
2. Click `New`.
3. Create a permission:
   - `resource_type = feature`
   - `action = use`
   - `resource_id = mcp_permission_audit_qckien`
   - valid Scope JSON
4. Update the Scope JSON.
5. Try to delete the created permission via the API/delete behavior.

### Expected

A permission created directly from the Permissions page should have a supported cleanup path from the same product surface.

### Actual

Create and update succeed, but delete returns:

```json
{
  "status": 409,
  "detail": "Permissions can't be deleted directly. Delete the related tab, button, app, or other owning configuration instead."
}
```

This creates orphanable direct-created permission metadata. The tested permission remains because the product/API refused deletion.

### Evidence

Screenshots:

- `D:\core-platform-automation\evidences\permissions-audit-20260529-084117\admin-permissions-create-filled.png`
- `D:\core-platform-automation\evidences\permissions-audit-20260529-084117\admin-permissions-create-after-submit.png`
- `D:\core-platform-automation\evidences\permissions-audit-20260529-084117\admin-permissions-detail-updated.png`

Source context:

- `D:\core-platform\apps\admin\src\hooks\useAdminPermissions.ts` exposes direct create/update/delete handlers.
- `D:\core-platform\apps\service\src\permissions\routes.ts` allows `POST /api/permissions` and `PATCH /api/permissions/:permissionId`, but `DELETE /api/permissions/:permissionId` always returns the owning-configuration conflict.

### Likely Cause

Product/API design mismatch. The UI exposes standalone permission creation, but the backend deletion rule assumes every permission is owned by another metadata object.

## Passed Checks

- Admin Permissions list loads and shows permission metadata.
- Admin direct permission create succeeds.
- Admin direct permission Scope JSON update succeeds.
- Runtime permission grant create/delete succeeds.
- Metadata permission grant create/delete succeeds.
- Keystone loads successfully after the Permissions checks, with `data-permissions-loaded="true"`.

Supporting screenshots:

- `D:\core-platform-automation\evidences\permissions-audit-20260529-084117\admin-permissions-runtime-grant-after-add.png`
- `D:\core-platform-automation\evidences\permissions-audit-20260529-084117\admin-permissions-metadata-grant-after-add.png`
- `D:\core-platform-automation\evidences\permissions-audit-20260529-084117\keystone-permissions-connected.png`

