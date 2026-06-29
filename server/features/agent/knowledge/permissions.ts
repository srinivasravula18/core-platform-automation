import type { FeatureKnowledge } from './types';

/**
 * Permissions + Access Records. IMPORTANT: these are TWO separate Admin nav features that are
 * easy to conflate. `permissions` = permission rules + grants (NO CRUD flags). `access_controls`
 * (label "Access Records") = object-level CRUD flags + field-level access (where View All / Modify
 * All / Read / Allow Sharing live). Admin-only; Keystone merely consumes the resulting access.
 */
export const permissionsKnowledge: FeatureKnowledge = {
  id: 'permissions',
  title: 'Permissions & Access Records (CRUD flags, field perms, grants)',
  apps: ['admin'],
  navigation:
    'Permissions: /?nav=permissions (list = no id; detail = &id=<permId>). Access Records: /?nav=access_controls (label "Access Records"; &id=<recId>). Both require permissionAdminAllowed or the body shows "Permission administration is restricted".',
  matchTerms: ['permission', 'permissions', 'access record', 'access records', 'access control', 'crud', 'view all', 'modify all', 'field permission', 'grant', 'principal', 'allow sharing', 'read access', 'edit access'],
  uiLevel: `PERMISSIONS (nav=permissions): heading "Permissions"; shared list view (activeObjectApiName="permission"), table only, generic "New" suppressed — create via empty-state button "New Permission" or onNewPermission. Bulk delete DISABLED (reason: "Permissions can't be deleted directly..."). resource_id column shown as "Resource".
  CREATE modal "New Permission": #create-permission-resource-type (Select, req, first option "Select resource type"; values feature/setting/permission/app/tab/object/list_view), #create-permission-action (Select, req, "Select action"; values use/manage/read/create/update/delete/view/execute), #create-permission-resource-id (TextInput), #create-permission-scope (textarea, optional JSON). Footer "Cancel"/"Create".
  DETAIL: read-only "Permission Details" + "Add Grant" form (selects #permission-grant-source [runtime/metadata], #permission-grant-effect [allow/deny], #permission-grant-principal-type [role/group/user], #permission-grant-principal ["Select principal"]) + "Add Grant" button; "Grants" list rows with "Remove" → confirm "Remove Grant".
ACCESS RECORDS (nav=access_controls): panel heading "Access Controls"; shared list view (activeObjectApiName="access_record", label "Access Records"); create allowed → AdminCreateAccessRecordModal; bulk delete allowed.
  DETAIL "Object Access" — CRUD checkboxes by exact visible label: "Read", "Create", "Update", "Delete", "View All", "Modify All", "Merge", "Allow Sharing".
  FIELD ACCESS editor ("Field Access"): per-field <select> with options "Default"/"Hidden"/"Masked"/"Read only"/"Read + Write".
  Action bar: "Delete" / "Reset" / "Save" (busy "Saving...").`,
  codeLevel: `Files: AdminPermissionsPanel.tsx, AdminPermissionsListView.tsx, AdminCreatePermissionModal.tsx, AdminAccessControlsPanel.tsx (Object Access ~574, checkboxes ~604-741), AccessFieldPermissionsEditor.tsx, accessPermissions.ts (dependency rules ~127-155).
Rules: Permission create — Resource Type + Action required; invalid Scope JSON blocked. Permissions cannot be bulk-deleted. Grant — duplicate (same principal+effect+source) blocked; opposite-effect conflict blocked. Object Access dependencies — Create/Update/Delete/View All/Modify All all REQUIRE Read (turning off Read clears them; toggling one auto-enables Read); Modify All requires Update AND Delete (auto-enables them). Merge checkbox disabled for system_admin role / super-users. Field rules: required fields cannot be Hidden/Read-only (those options filtered out).`,
  intentMap: [
    { saysAny: ['create permission', 'new permission', 'add permission'], realControl: 'Permissions empty-state/"New Permission" button → "New Permission" modal', accessFlow: 'nav=permissions → New Permission → set #create-permission-resource-type + #create-permission-action → Create' },
    { saysAny: ['give access', 'grant access', 'crud', 'read/write access', 'view all', 'modify all', 'object access'], realControl: 'Access Records detail → Object Access checkboxes ("Read"/"Create"/.../"Modify All")', accessFlow: 'nav=access_controls → open/create a record → toggle Object Access checkboxes → "Save"' },
    { saysAny: ['field permission', 'hide field', 'mask field', 'read only field'], realControl: 'Access Records detail → "Field Access" per-field select', accessFlow: 'nav=access_controls → open record → Field Access → set field select to Default/Hidden/Masked/Read only/Read + Write → Save' },
    { saysAny: ['grant to user', 'grant to role', 'assign permission'], realControl: 'Permission detail → "Add Grant" form → "Add Grant"', accessFlow: 'open a permission → pick principal type/principal → Add Grant' },
  ],
  testNotes: `Disambiguate "permissions" vs "access records": CRUD flags / View All / Modify All / field access live in ACCESS RECORDS (nav=access_controls), not Permissions. Object Access checkboxes are dependency-linked (Read auto-required; Modify All forces Update+Delete) — assert the resulting checkbox states after toggling. Permissions can't be bulk-deleted (don't write a delete-permission case). Changes propagate to Keystone subject to ~60s access caches (see propagation module).`,
};
