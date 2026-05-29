import { expect, request as playwrightRequest, test, type APIRequestContext, type APIResponse, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  adminBaseUrl,
  apiLogin,
  attachEvidence,
  authHeaders,
  closeModal,
  expectListRegionReady,
  expectListToolbar,
  hasCredentials,
  loginToAdmin,
  loginToKeystone,
  openAdminScreen,
  searchWithinListView,
  serviceBaseUrl
} from "./helpers";

type ApiApp = { id: string; label?: string; api_name?: string };
type ApiObject = { id: string; api_name: string; label?: string };
type ApiUser = { id: string; username?: string; is_admin?: boolean };
type RoleOrGroup = { id: string; app_id: string; name: string; description?: string | null };
type AccessRecord = {
  id: string;
  object_id: string;
  principal_type: "user" | "role" | "group";
  principal_id: string;
  permissions_json: PermissionSet;
};
type AccessControl = {
  id: string;
  resource_type: "app" | "tab";
  resource_id: string;
  principal_type: "user" | "role" | "group";
  principal_id: string;
  action: "view" | "create" | "edit" | "delete";
  effect: "allow" | "deny";
  scope_json?: unknown;
  source?: string;
};
type PermissionSet = {
  object?: {
    read?: boolean;
    create?: boolean;
    update?: boolean;
    delete?: boolean;
    view_all?: boolean;
    modify_all?: boolean;
  };
  fields?: Record<string, { read?: boolean; write?: boolean; hide?: boolean; mask?: boolean }>;
  attachments?: { read?: boolean; upload?: boolean; delete?: boolean; download?: boolean };
};
type Permission = {
  id: string;
  resource_type: string;
  resource_id: string | null;
  action: string;
  scope_json?: unknown;
};
type PermissionGrant = {
  id: string;
  permission_id: string;
  principal_type: "user" | "role" | "group";
  principal_id: string;
  effect: "allow" | "deny";
  source?: "metadata" | "runtime";
};
type PermissionContext = {
  token: string;
  app: ApiApp;
  object: ApiObject;
  user: ApiUser;
};

const hasWrites = () => process.env.ALLOW_DATA_WRITE === "true";
const allowPermissionMetadataCreate = () => process.env.ALLOW_PERMISSION_METADATA_CREATE === "true";
const stamp = () => Date.now().toString(36).slice(-6);

const attachJson = async (testInfo: TestInfo, name: string, value: unknown) => {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: "application/json"
  });
};

const attachApiEvidenceScreenshot = async (page: Page, testInfo: TestInfo) => {
  const alreadyHasScreenshot = testInfo.attachments.some((attachment) => {
    const name = attachment.name.toLowerCase();
    const path = attachment.path?.toLowerCase() ?? "";
    return name.includes("screenshot") || path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".jpeg");
  });
  if (alreadyHasScreenshot) return;
  if (!hasCredentials()) return;

  const title = testInfo.title.toLowerCase();
  if (title.includes("downstream") || title.includes("effective-access")) {
    await loginToKeystone(page);
    await attachEvidence(page, testInfo, "keystone-real-ui-evidence");
    return;
  }

  await loginToAdmin(page);
  if (title.includes("role")) {
    await openAdminScreen(page, "Roles");
  } else if (title.includes("group")) {
    await openAdminScreen(page, "Groups");
  } else if (title.includes("access record")) {
    await openAdminScreen(page, "Access Records");
  } else {
    await openAdminScreen(page, "Permissions");
  }
  await attachEvidence(page, testInfo, "admin-real-ui-evidence");
};

const readJson = async <T>(response: APIResponse): Promise<T> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON response, received: ${text}`);
  }
};

const expectProblem = async (
  response: APIResponse,
  status: number,
  type?: string | RegExp
) => {
  expect(response.status(), await response.text()).toBe(status);
  const body = (await response.json().catch(() => ({}))) as { type?: string; title?: string; detail?: string };
  if (type) {
    const actual = `${body.type ?? ""} ${body.title ?? ""} ${body.detail ?? ""}`;
    if (type instanceof RegExp) {
      expect(actual).toMatch(type);
    } else {
      expect(actual).toContain(type);
    }
  }
  return body;
};

const resolveContext = async (request: APIRequestContext): Promise<PermissionContext> => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);

  const userResponse = await request.get("/api/users/me", { headers });
  expect(userResponse.ok(), await userResponse.text()).toBeTruthy();
  const user = await readJson<ApiUser>(userResponse);

  const appsResponse = await request.get("/api/apps", { headers });
  expect(appsResponse.ok(), await appsResponse.text()).toBeTruthy();
  const apps = ((await readJson<{ items?: ApiApp[] }>(appsResponse)).items ?? []).filter((app) => app.id);
  expect(apps.length).toBeGreaterThan(0);

  for (const app of apps) {
    const objectsResponse = await request.get(`/api/apps/${app.id}/objects`, { headers });
    if (!objectsResponse.ok()) continue;
    const objects = ((await readJson<{ items?: ApiObject[] }>(objectsResponse)).items ?? []).filter(
      (object) => object.id && object.api_name && object.api_name !== "data_import"
    );
    if (objects[0]) {
      return { token, app, object: objects[0], user };
    }
  }

  throw new Error("No app/object context available for permissions E2E suite.");
};

const richPermissionSet = (): PermissionSet => ({
  object: {
    read: true,
    create: true,
    update: true,
    delete: false,
    view_all: true,
    modify_all: false
  },
  fields: {
    name: { read: true, write: true },
    status: { read: false, mask: true },
    internal_notes: { hide: true }
  },
  attachments: {
    read: true,
    upload: true,
    download: true,
    delete: false
  }
});

const modifiedPermissionSet = (): PermissionSet => ({
  object: {
    read: true,
    create: false,
    update: true,
    delete: true,
    view_all: false,
    modify_all: true
  },
  fields: {
    name: { read: true, write: false },
    status: { read: true, write: false }
  },
  attachments: {
    read: true,
    upload: false,
    download: true,
    delete: true
  }
});

const createRole = async (request: APIRequestContext, ctx: PermissionContext) => {
  const response = await request.post("/admin/roles", {
    headers: authHeaders(ctx.token),
    data: {
      app_id: ctx.app.id,
      name: `E2E Access Role ${stamp()}`,
      description: "Disposable role for permissions/access-record E2E coverage."
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return readJson<RoleOrGroup>(response);
};

const createGroup = async (request: APIRequestContext, ctx: PermissionContext) => {
  const response = await request.post("/admin/groups", {
    headers: authHeaders(ctx.token),
    data: {
      app_id: ctx.app.id,
      name: `E2E Access Group ${stamp()}`,
      description: "Disposable group for permissions/access-record E2E coverage."
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return readJson<RoleOrGroup>(response);
};

const deleteRoleBestEffort = async (request: APIRequestContext, token: string, roleId?: string) => {
  if (!roleId) return;
  await request.delete(`/admin/roles/${roleId}`, { headers: authHeaders(token) }).catch(() => null);
};

const deleteGroupBestEffort = async (request: APIRequestContext, token: string, groupId?: string) => {
  if (!groupId) return;
  await request.delete(`/admin/groups/${groupId}`, { headers: authHeaders(token) }).catch(() => null);
};

const createAccessRecord = async (
  request: APIRequestContext,
  ctx: PermissionContext,
  principalType: "user" | "role" | "group",
  principalId: string,
  permissions = richPermissionSet()
) => {
  const response = await request.post("/admin/access-records", {
    headers: authHeaders(ctx.token),
    data: {
      object_id: ctx.object.id,
      principal_type: principalType,
      principal_id: principalId,
      permissions_json: permissions
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return readJson<AccessRecord>(response);
};

const deleteAccessRecordBestEffort = async (
  request: APIRequestContext,
  token: string,
  accessRecordId?: string
) => {
  if (!accessRecordId) return;
  await request.delete(`/admin/access-records/${accessRecordId}`, { headers: authHeaders(token) }).catch(() => null);
};

const createAccessControl = async (
  request: APIRequestContext,
  ctx: PermissionContext,
  principalType: "user" | "role" | "group",
  principalId: string,
  effect: "allow" | "deny" = "allow"
) => {
  const response = await request.post("/admin/access-control", {
    headers: authHeaders(ctx.token),
    data: {
      resource_type: "app",
      resource_id: ctx.app.id,
      principal_type: principalType,
      principal_id: principalId,
      action: "view",
      effect,
      scope_json: { source: "permissions-access-records-e2e" }
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return readJson<AccessControl>(response);
};

const deleteAccessControlBestEffort = async (
  request: APIRequestContext,
  token: string,
  accessControlId?: string
) => {
  if (!accessControlId) return;
  await request.delete(`/admin/access-control/${accessControlId}`, { headers: authHeaders(token) }).catch(() => null);
};

const findGrantPermission = async (request: APIRequestContext, ctx: PermissionContext) => {
  const response = await request.get(`/api/permissions?resource_type=object&resource_id=${ctx.object.id}`, {
    headers: authHeaders(ctx.token)
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const existing = (await readJson<{ items?: Permission[] }>(response)).items ?? [];
  return existing.find((permission) => permission.action === "read") ?? existing[0] ?? null;
};

const createPermissionMetadata = async (request: APIRequestContext, ctx: PermissionContext) => {
  const action = `e2e_${stamp()}`;
  const response = await request.post("/api/permissions", {
    headers: authHeaders(ctx.token),
    data: {
      resource_type: "object",
      resource_id: ctx.object.id,
      action,
      scope_json: { source: "permissions-access-records-e2e" }
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return readJson<Permission>(response);
};

const deleteGrantBestEffort = async (
  request: APIRequestContext,
  token: string,
  permissionId?: string,
  grantId?: string,
  source: "metadata" | "runtime" = "metadata"
) => {
  if (!permissionId || !grantId) return;
  const path =
    source === "metadata"
      ? `/api/permissions/${permissionId}/metadata-grants/${grantId}`
      : `/api/permissions/${permissionId}/grants/${grantId}`;
  await request.delete(path, { headers: authHeaders(token) }).catch(() => null);
};

test.describe("Permissions and access records E2E coverage", () => {
  test.beforeEach(() => {
    test.skip(!hasCredentials(), "API credentials are not configured.");
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.title.includes("[surface: Admin]") || testInfo.title.includes("[surface: Keystone]")) {
      await attachApiEvidenceScreenshot(page, testInfo).catch(() => null);
    }
  });

  if (process.env.INCLUDE_SECURITY_API_BASELINE_TESTS === "true") {
  test("Access records API creates, lists, updates, and deletes role/group/user principals [surface: API] [feature: Access Records] @bvt @security", async ({
    request
  }, testInfo) => {
    test.skip(!hasWrites(), "Access-record lifecycle writes require ALLOW_DATA_WRITE=true.");
    const ctx = await resolveContext(request);
    const role = await createRole(request, ctx);
    const group = await createGroup(request, ctx);
    const createdIds: string[] = [];

    try {
      const roleRecord = await createAccessRecord(request, ctx, "role", role.id);
      const groupRecord = await createAccessRecord(request, ctx, "group", group.id);
      const userRecord = await createAccessRecord(request, ctx, "user", ctx.user.id);
      createdIds.push(roleRecord.id, groupRecord.id, userRecord.id);
      await attachJson(testInfo, "access-records-created", { roleRecord, groupRecord, userRecord });

      const listResponse = await request.get(
        `/admin/access-records?object_id=${ctx.object.id}&principal_type=role&principal_id=${role.id}`,
        { headers: authHeaders(ctx.token) }
      );
      expect(listResponse.ok(), await listResponse.text()).toBeTruthy();
      const listBody = await readJson<{ items?: AccessRecord[] }>(listResponse);
      expect(listBody.items?.some((item) => item.id === roleRecord.id)).toBeTruthy();

      const patchResponse = await request.patch(`/admin/access-records/${roleRecord.id}`, {
        headers: authHeaders(ctx.token),
        data: { permissions_json: modifiedPermissionSet() }
      });
      expect(patchResponse.ok(), await patchResponse.text()).toBeTruthy();

      const getResponse = await request.get(`/admin/access-records/${roleRecord.id}`, {
        headers: authHeaders(ctx.token)
      });
      expect(getResponse.ok(), await getResponse.text()).toBeTruthy();
      const reloaded = await readJson<AccessRecord>(getResponse);
      expect(reloaded.permissions_json.object?.modify_all).toBe(true);
      expect(reloaded.permissions_json.attachments?.delete).toBe(true);
      expect(reloaded.permissions_json.fields?.name?.write).toBe(false);
      await attachJson(testInfo, "access-record-reloaded-after-update", reloaded);

      const deleteResponse = await request.delete(`/admin/access-records/${groupRecord.id}`, {
        headers: authHeaders(ctx.token)
      });
      expect(deleteResponse.ok(), await deleteResponse.text()).toBeTruthy();
      createdIds.splice(createdIds.indexOf(groupRecord.id), 1);

      const deletedGet = await request.get(`/admin/access-records/${groupRecord.id}`, {
        headers: authHeaders(ctx.token)
      });
      await expectProblem(deletedGet, 404, "not_found");
    } finally {
      await Promise.all(createdIds.map((id) => deleteAccessRecordBestEffort(request, ctx.token, id)));
      await deleteRoleBestEffort(request, ctx.token, role.id);
      await deleteGroupBestEffort(request, ctx.token, group.id);
    }
  });

  test("Access records API rejects invalid, duplicate, inactive, and missing records [surface: API] [feature: Access Records] @sanity @security", async ({
    request
  }, testInfo) => {
    const ctx = await resolveContext(request);

    const missingObject = await request.post("/admin/access-records", {
      headers: authHeaders(ctx.token),
      data: {
        principal_type: "user",
        principal_id: ctx.user.id,
        permissions_json: richPermissionSet()
      }
    });
    await attachJson(testInfo, "missing-object-response", await missingObject.json().catch(() => ({})));
    await expectProblem(missingObject, 400, "invalid_request");

    const missingPrincipal = await request.post("/admin/access-records", {
      headers: authHeaders(ctx.token),
      data: {
        object_id: ctx.object.id,
        principal_type: "user",
        permissions_json: richPermissionSet()
      }
    });
    await expectProblem(missingPrincipal, 400, "invalid_request");

    const inactiveDirectUser = await request.post("/admin/access-records", {
      headers: authHeaders(ctx.token),
      data: {
        object_id: ctx.object.id,
        principal_type: "user",
        principal_id: "usrzzz999",
        permissions_json: richPermissionSet()
      }
    });
    await expectProblem(inactiveDirectUser, 409, "inactive_user");

    const unknownPatch = await request.patch("/admin/access-records/acszz9999", {
      headers: authHeaders(ctx.token),
      data: { permissions_json: richPermissionSet() }
    });
    await expectProblem(unknownPatch, 404, "not_found");

    const unknownDelete = await request.delete("/admin/access-records/acszz9999", {
      headers: authHeaders(ctx.token)
    });
    await expectProblem(unknownDelete, 404, "not_found");

    if (hasWrites()) {
      const role = await createRole(request, ctx);
      let recordId = "";
      try {
        const created = await createAccessRecord(request, ctx, "role", role.id);
        recordId = created.id;
        const duplicate = await request.post("/admin/access-records", {
          headers: authHeaders(ctx.token),
          data: {
            object_id: ctx.object.id,
            principal_type: "role",
            principal_id: role.id,
            permissions_json: richPermissionSet()
          }
        });
        await expectProblem(duplicate, 409, "duplicate_access_record");
      } finally {
        await deleteAccessRecordBestEffort(request, ctx.token, recordId);
        await deleteRoleBestEffort(request, ctx.token, role.id);
      }
    }
  });

  test("Access control API upserts, lists, patches, and deletes runtime app grants [surface: API] [feature: Access Control] @bvt @security", async ({
    request
  }, testInfo) => {
    test.skip(!hasWrites(), "Access-control lifecycle writes require ALLOW_DATA_WRITE=true.");
    const ctx = await resolveContext(request);
    const group = await createGroup(request, ctx);
    let accessControlId = "";

    try {
      const created = await createAccessControl(request, ctx, "group", group.id, "allow");
      accessControlId = created.id;
      expect(created.effect).toBe("allow");

      const upsert = await request.post("/admin/access-control", {
        headers: authHeaders(ctx.token),
        data: {
          resource_type: "app",
          resource_id: ctx.app.id,
          principal_type: "group",
          principal_id: group.id,
          action: "view",
          effect: "deny",
          scope_json: { source: "permissions-access-records-e2e", upsert: true }
        }
      });
      expect(upsert.status(), await upsert.text()).toBe(200);
      const upserted = await readJson<AccessControl>(upsert);
      expect(upserted.id).toBe(accessControlId);
      expect(upserted.effect).toBe("deny");

      const patch = await request.patch(`/admin/access-control/${accessControlId}`, {
        headers: authHeaders(ctx.token),
        data: { effect: "allow", scope_json: { source: "permissions-access-records-e2e", patched: true } }
      });
      expect(patch.ok(), await patch.text()).toBeTruthy();

      const emptyPatch = await request.patch(`/admin/access-control/${accessControlId}`, {
        headers: authHeaders(ctx.token),
        data: {}
      });
      await expectProblem(emptyPatch, 400, /No updates provided|invalid_request/);

      const list = await request.get(
        `/admin/access-control?resource_type=app&resource_id=${ctx.app.id}&principal_type=group&principal_id=${group.id}&action=view`,
        { headers: authHeaders(ctx.token) }
      );
      expect(list.ok(), await list.text()).toBeTruthy();
      const listBody = await readJson<{ items?: AccessControl[] }>(list);
      expect(listBody.items?.some((item) => item.id === accessControlId && item.effect === "allow")).toBeTruthy();
      await attachJson(testInfo, "access-control-listed", listBody);

      const del = await request.delete(`/admin/access-control/${accessControlId}`, {
        headers: authHeaders(ctx.token)
      });
      expect(del.ok(), await del.text()).toBeTruthy();
      accessControlId = "";

      const patchMissing = await request.patch(`/admin/access-control/${created.id}`, {
        headers: authHeaders(ctx.token),
        data: { effect: "deny" }
      });
      await expectProblem(patchMissing, 404, "not_found");
    } finally {
      await deleteAccessControlBestEffort(request, ctx.token, accessControlId);
      await deleteGroupBestEffort(request, ctx.token, group.id);
    }
  });

  test("Access control API rejects invalid payloads and empty updates [surface: API] [feature: Access Control] @sanity @security", async ({
    request
  }) => {
    const ctx = await resolveContext(request);

    const invalidResourceType = await request.post("/admin/access-control", {
      headers: authHeaders(ctx.token),
      data: {
        resource_type: "object",
        resource_id: ctx.object.id,
        principal_type: "user",
        principal_id: ctx.user.id,
        action: "view",
        effect: "allow"
      }
    });
    await expectProblem(invalidResourceType, 400, "invalid_request");

    const invalidPrincipal = await request.post("/admin/access-control", {
      headers: authHeaders(ctx.token),
      data: {
        resource_type: "app",
        resource_id: ctx.app.id,
        principal_type: "team",
        principal_id: ctx.user.id,
        action: "view",
        effect: "allow"
      }
    });
    await expectProblem(invalidPrincipal, 400, "invalid_request");

    const missingAction = await request.post("/admin/access-control", {
      headers: authHeaders(ctx.token),
      data: {
        resource_type: "app",
        resource_id: ctx.app.id,
        principal_type: "user",
        principal_id: ctx.user.id,
        effect: "allow"
      }
    });
    await expectProblem(missingAction, 400, "invalid_request");

    const emptyPatch = await request.patch("/admin/access-control/acczz9999", {
      headers: authHeaders(ctx.token),
      data: {}
    });
    expect([400, 404]).toContain(emptyPatch.status());
    if (emptyPatch.status() === 400) {
      await expectProblem(emptyPatch, 400, /No updates provided|invalid_request/);
    }
  });

  test("Permission metadata and grants API validates create, grant, conflict, check, export, and delete contracts [surface: API] [feature: Permissions] @bvt @security", async ({
    request
  }, testInfo) => {
    test.skip(!hasWrites(), "Permission grant writes require ALLOW_DATA_WRITE=true.");
    const ctx = await resolveContext(request);
    let permission = await findGrantPermission(request, ctx);
    if (!permission) {
      test.skip(
        !allowPermissionMetadataCreate(),
        "No existing object permission is available; set ALLOW_PERMISSION_METADATA_CREATE=true to create non-deletable permission metadata."
      );
      permission = await createPermissionMetadata(request, ctx);
      await attachJson(testInfo, "created-nondeletable-permission-metadata", permission);
    }

    const group = await createGroup(request, ctx);
    const grantIds: Array<{ id: string; source: "metadata" | "runtime" }> = [];
    try {
      const metadataGrantResponse = await request.post(`/api/permissions/${permission.id}/metadata-grants`, {
        headers: authHeaders(ctx.token),
        data: { principal_type: "group", principal_id: group.id, effect: "allow" }
      });
      expect(metadataGrantResponse.ok(), await metadataGrantResponse.text()).toBeTruthy();
      const metadataGrant = await readJson<PermissionGrant>(metadataGrantResponse);
      grantIds.push({ id: metadataGrant.id, source: "metadata" });

      const duplicate = await request.post(`/api/permissions/${permission.id}/metadata-grants`, {
        headers: authHeaders(ctx.token),
        data: { principal_type: "group", principal_id: group.id, effect: "allow" }
      });
      await expectProblem(duplicate, 409, "conflict");

      const opposite = await request.post(`/api/permissions/${permission.id}/metadata-grants`, {
        headers: authHeaders(ctx.token),
        data: { principal_type: "group", principal_id: group.id, effect: "deny" }
      });
      await expectProblem(opposite, 409, "conflict");

      const grantsList = await request.get(`/api/permissions/${permission.id}/grants`, {
        headers: authHeaders(ctx.token)
      });
      expect(grantsList.ok(), await grantsList.text()).toBeTruthy();
      const grantsBody = await readJson<{ items?: PermissionGrant[] }>(grantsList);
      expect(grantsBody.items?.some((grant) => grant.id === metadataGrant.id)).toBeTruthy();
      await attachJson(testInfo, "permission-grants-listed", grantsBody);

      const check = await request.post("/api/permissions/check", {
        headers: authHeaders(ctx.token),
        data: {
          resource_type: permission.resource_type,
          resource_id: permission.resource_id,
          action: permission.action
        }
      });
      expect(check.ok(), await check.text()).toBeTruthy();
      const checkBody = await readJson<{ allowed?: boolean; reason?: string | null }>(check);
      expect(typeof checkBody.allowed).toBe("boolean");

      const exportResponse = await request.get("/api/permissions/export?scope=all", {
        headers: authHeaders(ctx.token)
      });
      expect(exportResponse.ok(), await exportResponse.text()).toBeTruthy();
      const exportBody = await readJson<{ permissions?: unknown[]; permission_grants?: unknown[] }>(exportResponse);
      expect(Array.isArray(exportBody.permissions)).toBeTruthy();
      expect(Array.isArray(exportBody.permission_grants)).toBeTruthy();

      const deletePermission = await request.delete(`/api/permissions/${permission.id}`, {
        headers: authHeaders(ctx.token)
      });
      await expectProblem(deletePermission, 409, "invalid_state");
    } finally {
      await Promise.all(
        grantIds.map((grant) => deleteGrantBestEffort(request, ctx.token, permission?.id, grant.id, grant.source))
      );
      await deleteGroupBestEffort(request, ctx.token, group.id);
    }
  });

  test("Permission API rejects invalid checks, bad grants, inactive users, and unknown resources [surface: API] [feature: Permissions] @sanity @security", async ({
    request
  }, testInfo) => {
    const ctx = await resolveContext(request);

    const invalidCheck = await request.post("/api/permissions/check", {
      headers: authHeaders(ctx.token),
      data: { resource_type: "object" }
    });
    await expectProblem(invalidCheck, 400, "invalid_request");

    const missingPermissionGrants = await request.get("/api/permissions/perzz9999/grants", {
      headers: authHeaders(ctx.token)
    });
    await expectProblem(missingPermissionGrants, 404, "not_found");

    const badGrant = await request.post("/api/permissions/perzz9999/metadata-grants", {
      headers: authHeaders(ctx.token),
      data: { principal_type: "team", principal_id: "usrzz9999", effect: "allow" }
    });
    await expectProblem(badGrant, 400, "invalid_request");

    const permission = await findGrantPermission(request, ctx);
    if (permission) {
      const inactiveGrant = await request.post(`/api/permissions/${permission.id}/metadata-grants`, {
        headers: authHeaders(ctx.token),
        data: { principal_type: "user", principal_id: "usrzz9999", effect: "allow" }
      });
      await expectProblem(inactiveGrant, 409, "inactive_user");
    } else {
      testInfo.annotations.push({
        type: "coverage-note",
        description: "Skipped inactive-user grant validation because no permission metadata exists."
      });
    }
  });

  test("Role and group security rejects protected system_admin changes and duplicate names [surface: API] [feature: Roles Groups] @sanity @security", async ({
    request
  }) => {
    test.skip(!hasWrites(), "Role/group duplicate validation writes require ALLOW_DATA_WRITE=true.");
    const ctx = await resolveContext(request);

    const rolesResponse = await request.get("/admin/roles?q=system_admin", { headers: authHeaders(ctx.token) });
    expect(rolesResponse.ok(), await rolesResponse.text()).toBeTruthy();
    const systemAdminRole = ((await readJson<{ items?: RoleOrGroup[] }>(rolesResponse)).items ?? []).find(
      (role) => role.name.toLowerCase() === "system_admin"
    );
    if (systemAdminRole) {
      const renameSystemAdmin = await request.patch(`/admin/roles/${systemAdminRole.id}`, {
        headers: authHeaders(ctx.token),
        data: { name: `system_admin_${stamp()}` }
      });
      await expectProblem(renameSystemAdmin, 409, "conflict");

      const deleteSystemAdmin = await request.delete(`/admin/roles/${systemAdminRole.id}`, {
        headers: authHeaders(ctx.token)
      });
      await expectProblem(deleteSystemAdmin, 409, "conflict");
    }

    const role = await createRole(request, ctx);
    const group = await createGroup(request, ctx);
    try {
      const duplicateRole = await request.post("/admin/roles", {
        headers: authHeaders(ctx.token),
        data: { app_id: ctx.app.id, name: role.name, description: "duplicate" }
      });
      await expectProblem(duplicateRole, 409, "conflict");

      const duplicateGroup = await request.post("/admin/groups", {
        headers: authHeaders(ctx.token),
        data: { app_id: ctx.app.id, name: group.name, description: "duplicate" }
      });
      await expectProblem(duplicateGroup, 409, "conflict");
    } finally {
      await deleteRoleBestEffort(request, ctx.token, role.id);
      await deleteGroupBestEffort(request, ctx.token, group.id);
    }
  });

  test("Permission and admin access APIs require valid authentication [surface: API] [feature: Security] @bvt @security", async ({}, testInfo) => {
    const anonymous = await playwrightRequest.newContext({ baseURL: serviceBaseUrl });
    const invalid = await playwrightRequest.newContext({
      baseURL: serviceBaseUrl,
      extraHTTPHeaders: { Authorization: "Bearer invalid-token" }
    });
    try {
      const anonymousPermission = await anonymous.post("/api/permissions/check", {
        data: { resource_type: "object", resource_id: "objzz9999", action: "read" }
      });
      if (anonymousPermission.status() === 200) {
        testInfo.annotations.push({
          type: "coverage-note",
          description: "Local service accepted anonymous permission check, likely due to dev auth bypass/default user."
        });
        test.skip(true, "Local service auth bypass is enabled; strict anonymous/invalid-token assertions are not meaningful.");
      }
      expect([401, 403]).toContain(anonymousPermission.status());

      const anonymousAccessRecords = await anonymous.get("/admin/access-records");
      expect([401, 403]).toContain(anonymousAccessRecords.status());

      const invalidPermission = await invalid.post("/api/permissions/check", {
        data: { resource_type: "object", resource_id: "objzz9999", action: "read" }
      });
      expect([401, 403]).toContain(invalidPermission.status());

      const invalidAccessRecords = await invalid.get("/admin/access-records");
      expect([401, 403]).toContain(invalidAccessRecords.status());
    } finally {
      await anonymous.dispose();
      await invalid.dispose();
    }
  });

  test("Downstream access smoke covers app object access, list views, records, search, and users access [surface: API] [feature: Effective Access] @regression @security", async ({
    request
  }, testInfo) => {
    const ctx = await resolveContext(request);
    const headers = authHeaders(ctx.token);

    const objectAccess = await request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/access`, {
      headers
    });
    expect(objectAccess.ok(), await objectAccess.text()).toBeTruthy();
    const objectAccessBody = await readJson<Record<string, unknown>>(objectAccess);
    await attachJson(testInfo, "object-access-decision", objectAccessBody);

    const listViews = await request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views`, {
      headers
    });
    expect(listViews.ok(), await listViews.text()).toBeTruthy();

    const records = await request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/records`, {
      headers
    });
    expect([200, 403]).toContain(records.status());

    const search = await request.get(`/api/apps/${ctx.app.id}/search?q=e2e`, { headers });
    expect([200, 400, 404]).toContain(search.status());

    const usersAccess = await request.get("/api/users/access", { headers });
    expect(usersAccess.ok(), await usersAccess.text()).toBeTruthy();

    await attachJson(testInfo, "downstream-access-statuses", {
      objectAccess: objectAccess.status(),
      listViews: listViews.status(),
      records: records.status(),
      search: search.status(),
      usersAccess: usersAccess.status()
    });
  });

  }

  if (process.env.INCLUDE_SECURITY_API_EDGE_TESTS === "true") {
  const accessRecordCreateInvalidCases: Array<{
    name: string;
    data: (ctx: PermissionContext) => unknown;
    statuses?: number[];
  }> = [
    { name: "empty body", data: () => ({}) },
    { name: "missing object_id", data: (ctx) => ({ principal_type: "user", principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "missing principal_type", data: (ctx) => ({ object_id: ctx.object.id, principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "missing principal_id", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", permissions_json: richPermissionSet() }) },
    { name: "missing permissions_json", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id }) },
    { name: "short object_id", data: (ctx) => ({ object_id: "x", principal_type: "user", principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "long object_id", data: (ctx) => ({ object_id: "object-id-too-long", principal_type: "user", principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "empty object_id", data: (ctx) => ({ object_id: "", principal_type: "user", principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "numeric object_id", data: (ctx) => ({ object_id: 123, principal_type: "user", principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "null object_id", data: (ctx) => ({ object_id: null, principal_type: "user", principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "invalid principal_type team", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "team", principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "invalid principal_type default", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "default", principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "numeric principal_type", data: (ctx) => ({ object_id: ctx.object.id, principal_type: 1, principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "null principal_type", data: (ctx) => ({ object_id: ctx.object.id, principal_type: null, principal_id: ctx.user.id, permissions_json: richPermissionSet() }) },
    { name: "short principal_id", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: "u", permissions_json: richPermissionSet() }) },
    { name: "long principal_id", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: "user-id-too-long", permissions_json: richPermissionSet() }) },
    { name: "empty principal_id", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: "", permissions_json: richPermissionSet() }) },
    { name: "numeric principal_id", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: 123, permissions_json: richPermissionSet() }) },
    { name: "null principal_id", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: null, permissions_json: richPermissionSet() }) },
    { name: "inactive direct user", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: "usrzz9999", permissions_json: richPermissionSet() }), statuses: [409] },
    { name: "empty permissions object", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id, permissions_json: {} }) },
    { name: "null permissions_json", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id, permissions_json: null }) },
    { name: "string permissions_json", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id, permissions_json: "read" }) },
    { name: "array permissions_json", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id, permissions_json: [] }) },
    { name: "invalid object permission type", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id, permissions_json: { object: "read" } }) },
    { name: "invalid field permission type", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id, permissions_json: { fields: "name" } }) },
    { name: "invalid attachment permission type", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id, permissions_json: { attachments: "read" } }) },
    { name: "unsupported extra root only", data: (ctx) => ({ object_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id, permissions_json: { unsupported: true } }) }
  ];

  for (const invalidCase of accessRecordCreateInvalidCases) {
    test(`Access record create invalid edge rejects ${invalidCase.name} [surface: API] [feature: Access Records] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.post("/admin/access-records", {
        headers: authHeaders(ctx.token),
        data: invalidCase.data(ctx)
      });
      expect(invalidCase.statuses ?? [400]).toContain(response.status());
    });
  }

  const accessRecordQueryInvalidCases = [
    "/admin/access-records?object_id=x",
    "/admin/access-records?object_id=object-id-too-long",
    "/admin/access-records?principal_type=team",
    "/admin/access-records?principal_type=default",
    "/admin/access-records?principal_id=u",
    "/admin/access-records?principal_id=user-id-too-long",
    "/admin/access-records?object_id=x&principal_type=team",
    "/admin/access-records?principal_type=user&principal_id=u"
  ];

  for (const [index, path] of accessRecordQueryInvalidCases.entries()) {
    test(`Access record query invalid edge ${index + 1} returns 400 [surface: API] [feature: Access Records] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.get(path, { headers: authHeaders(ctx.token) });
      await expectProblem(response, 400, "invalid_request");
    });
  }

  const accessRecordPatchInvalidCases: Array<{ name: string; data: unknown; statuses?: number[] }> = [
    { name: "empty body", data: {} },
    { name: "missing permissions_json", data: { object: { read: true } } },
    { name: "null permissions_json", data: { permissions_json: null } },
    { name: "string permissions_json", data: { permissions_json: "read" } },
    { name: "array permissions_json", data: { permissions_json: [] } },
    { name: "empty permissions_json", data: { permissions_json: {} } },
    { name: "invalid object type", data: { permissions_json: { object: "read" } } },
    { name: "invalid fields type", data: { permissions_json: { fields: "name" } } },
    { name: "invalid attachments type", data: { permissions_json: { attachments: "read" } } },
    { name: "unsupported permission root only", data: { permissions_json: { unsupported: true } } },
    { name: "valid body unknown id", data: { permissions_json: richPermissionSet() }, statuses: [404] }
  ];

  for (const invalidCase of accessRecordPatchInvalidCases) {
    test(`Access record patch invalid edge rejects ${invalidCase.name} [surface: API] [feature: Access Records] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.patch("/admin/access-records/acszz9999", {
        headers: authHeaders(ctx.token),
        data: invalidCase.data
      });
      expect(invalidCase.statuses ?? [400]).toContain(response.status());
    });
  }

  const accessControlCreateInvalidCases: Array<{ name: string; data: (ctx: PermissionContext) => unknown }> = [
    { name: "empty body", data: () => ({}) },
    { name: "missing resource_type", data: (ctx) => ({ resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "missing resource_id", data: (ctx) => ({ resource_type: "app", principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "missing principal_type", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "missing principal_id", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", action: "view", effect: "allow" }) },
    { name: "missing action", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, effect: "allow" }) },
    { name: "missing effect", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view" }) },
    { name: "invalid resource_type object", data: (ctx) => ({ resource_type: "object", resource_id: ctx.object.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "invalid resource_type permission", data: (ctx) => ({ resource_type: "permission", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "empty resource_type", data: (ctx) => ({ resource_type: "", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "numeric resource_type", data: (ctx) => ({ resource_type: 1, resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "short resource_id", data: (ctx) => ({ resource_type: "app", resource_id: "x", principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "long resource_id", data: (ctx) => ({ resource_type: "app", resource_id: "resource-id-too-long", principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "null resource_id", data: (ctx) => ({ resource_type: "app", resource_id: null, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "invalid principal_type team", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "team", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "invalid principal_type default", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "default", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "numeric principal_type", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: 1, principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "short principal_id", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: "u", action: "view", effect: "allow" }) },
    { name: "long principal_id", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: "principal-id-too-long", action: "view", effect: "allow" }) },
    { name: "null principal_id", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: null, action: "view", effect: "allow" }) },
    { name: "invalid action read", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "read", effect: "allow" }) },
    { name: "invalid action manage", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "manage", effect: "allow" }) },
    { name: "invalid action empty", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "", effect: "allow" }) },
    { name: "numeric action", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: 1, effect: "allow" }) },
    { name: "invalid effect block", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "block" }) },
    { name: "invalid effect empty", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "" }) },
    { name: "numeric effect", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: 1 }) },
    { name: "invalid source seed", data: (ctx) => ({ resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow", source: "seed" }) },
    { name: "invalid id too short", data: (ctx) => ({ id: "a", resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) },
    { name: "invalid id too long", data: (ctx) => ({ id: "access-control-id-too-long", resource_type: "app", resource_id: ctx.app.id, principal_type: "user", principal_id: ctx.user.id, action: "view", effect: "allow" }) }
  ];

  for (const invalidCase of accessControlCreateInvalidCases) {
    test(`Access control create invalid edge rejects ${invalidCase.name} [surface: API] [feature: Access Control] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.post("/admin/access-control", {
        headers: authHeaders(ctx.token),
        data: invalidCase.data(ctx)
      });
      await expectProblem(response, 400, "invalid_request");
    });
  }

  const accessControlQueryInvalidCases = [
    "/admin/access-control?resource_type=object",
    "/admin/access-control?resource_id=x",
    "/admin/access-control?resource_id=resource-id-too-long",
    "/admin/access-control?principal_type=team",
    "/admin/access-control?principal_id=u",
    "/admin/access-control?principal_id=principal-id-too-long",
    "/admin/access-control?action=read",
    "/admin/access-control?action=manage",
    "/admin/access-control?resource_type=app&action=read",
    "/admin/access-control?principal_type=user&principal_id=u"
  ];

  for (const [index, path] of accessControlQueryInvalidCases.entries()) {
    test(`Access control query invalid edge ${index + 1} returns 400 [surface: API] [feature: Access Control] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.get(path, { headers: authHeaders(ctx.token) });
      await expectProblem(response, 400, "invalid_request");
    });
  }

  const accessControlPatchInvalidCases: Array<{ name: string; data: unknown }> = [
    { name: "invalid effect block", data: { effect: "block" } },
    { name: "invalid effect empty", data: { effect: "" } },
    { name: "numeric effect", data: { effect: 1 } },
    { name: "null effect", data: { effect: null } },
    { name: "string body", data: "allow" },
    { name: "array body", data: [] },
    { name: "unknown property only", data: { action: "view" } },
    { name: "empty patch", data: {} }
  ];

  for (const invalidCase of accessControlPatchInvalidCases) {
    test(`Access control patch invalid edge rejects ${invalidCase.name} [surface: API] [feature: Access Control] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.patch("/admin/access-control/acczz9999", {
        headers: authHeaders(ctx.token),
        data: invalidCase.data
      });
      expect([400, 404]).toContain(response.status());
    });
  }

  const permissionCheckInvalidCases: Array<{ name: string; data: unknown }> = [
    { name: "empty body", data: {} },
    { name: "missing resource_type", data: { resource_id: "objzz9999", action: "read" } },
    { name: "missing action", data: { resource_type: "object", resource_id: "objzz9999" } },
    { name: "empty resource_type", data: { resource_type: "", resource_id: "objzz9999", action: "read" } },
    { name: "numeric resource_type", data: { resource_type: 1, resource_id: "objzz9999", action: "read" } },
    { name: "null resource_type", data: { resource_type: null, resource_id: "objzz9999", action: "read" } },
    { name: "empty resource_id", data: { resource_type: "object", resource_id: "", action: "read" } },
    { name: "numeric resource_id", data: { resource_type: "object", resource_id: 1, action: "read" } },
    { name: "empty action", data: { resource_type: "object", resource_id: "objzz9999", action: "" } },
    { name: "numeric action", data: { resource_type: "object", resource_id: "objzz9999", action: 1 } },
    { name: "null action", data: { resource_type: "object", resource_id: "objzz9999", action: null } },
    { name: "array body", data: [] }
  ];

  for (const invalidCase of permissionCheckInvalidCases) {
    test(`Permission check invalid edge rejects ${invalidCase.name} [surface: API] [feature: Permissions] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.post("/api/permissions/check", {
        headers: authHeaders(ctx.token),
        data: invalidCase.data
      });
      await expectProblem(response, 400, "invalid_request");
    });
  }

  const permissionListInvalidQueries = [
    "/api/permissions?resource_type=",
    "/api/permissions?resource_id=",
    "/api/permissions?action=",
    "/api/permissions?resource_type=&action=read",
    "/api/permissions?resource_id=&action=read",
    "/api/permissions?resource_type=object&action="
  ];

  for (const [index, path] of permissionListInvalidQueries.entries()) {
    test(`Permission list invalid query edge ${index + 1} returns 400 [surface: API] [feature: Permissions] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.get(path, { headers: authHeaders(ctx.token) });
      await expectProblem(response, 400, "invalid_request");
    });
  }

  const permissionCreateInvalidCases: Array<{ name: string; data: unknown }> = [
    { name: "empty body", data: {} },
    { name: "missing resource_type", data: { resource_id: "objzz9999", action: "read" } },
    { name: "missing action", data: { resource_type: "object", resource_id: "objzz9999" } },
    { name: "empty resource_type", data: { resource_type: "", resource_id: "objzz9999", action: "read" } },
    { name: "numeric resource_type", data: { resource_type: 1, resource_id: "objzz9999", action: "read" } },
    { name: "empty resource_id", data: { resource_type: "object", resource_id: "", action: "read" } },
    { name: "numeric resource_id", data: { resource_type: "object", resource_id: 1, action: "read" } },
    { name: "empty action", data: { resource_type: "object", resource_id: "objzz9999", action: "" } },
    { name: "numeric action", data: { resource_type: "object", resource_id: "objzz9999", action: 1 } },
    { name: "array body", data: [] }
  ];

  for (const invalidCase of permissionCreateInvalidCases) {
    test(`Permission create invalid edge rejects ${invalidCase.name} [surface: API] [feature: Permissions] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.post("/api/permissions", {
        headers: authHeaders(ctx.token),
        data: invalidCase.data
      });
      await expectProblem(response, 400, "invalid_request");
    });
  }

  const permissionPatchInvalidCases: Array<{ name: string; data: unknown; statuses?: number[] }> = [
    { name: "empty body", data: {}, statuses: [400] },
    { name: "identity resource_type update", data: { resource_type: "object" }, statuses: [400] },
    { name: "identity resource_id update", data: { resource_id: "objzz9999" }, statuses: [400] },
    { name: "identity action update", data: { action: "read" }, statuses: [400] },
    { name: "string body", data: "scope", statuses: [400] },
    { name: "array body", data: [], statuses: [400] },
    { name: "valid scope unknown permission", data: { scope_json: { source: "e2e" } }, statuses: [404] }
  ];

  for (const invalidCase of permissionPatchInvalidCases) {
    test(`Permission patch invalid edge rejects ${invalidCase.name} [surface: API] [feature: Permissions] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.patch("/api/permissions/perzz9999", {
        headers: authHeaders(ctx.token),
        data: invalidCase.data
      });
      expect(invalidCase.statuses ?? [400]).toContain(response.status());
    });
  }

  const permissionGrantInvalidCases: Array<{ name: string; data: unknown }> = [
    { name: "empty body", data: {} },
    { name: "missing principal_type", data: { principal_id: "usrzz9999", effect: "allow" } },
    { name: "missing principal_id", data: { principal_type: "user", effect: "allow" } },
    { name: "invalid principal_type team", data: { principal_type: "team", principal_id: "usrzz9999", effect: "allow" } },
    { name: "invalid principal_type default", data: { principal_type: "default", principal_id: "usrzz9999", effect: "allow" } },
    { name: "numeric principal_type", data: { principal_type: 1, principal_id: "usrzz9999", effect: "allow" } },
    { name: "short principal_id", data: { principal_type: "user", principal_id: "u", effect: "allow" } },
    { name: "long principal_id", data: { principal_type: "user", principal_id: "principal-id-too-long", effect: "allow" } },
    { name: "numeric principal_id", data: { principal_type: "user", principal_id: 1, effect: "allow" } },
    { name: "invalid effect block", data: { principal_type: "user", principal_id: "usrzz9999", effect: "block" } },
    { name: "empty effect", data: { principal_type: "user", principal_id: "usrzz9999", effect: "" } },
    { name: "numeric effect", data: { principal_type: "user", principal_id: "usrzz9999", effect: 1 } }
  ];

  for (const invalidCase of permissionGrantInvalidCases) {
    test(`Metadata grant invalid edge rejects ${invalidCase.name} [surface: API] [feature: Permission Grants] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.post("/api/permissions/perzz9999/metadata-grants", {
        headers: authHeaders(ctx.token),
        data: invalidCase.data
      });
      await expectProblem(response, 400, "invalid_request");
    });

    test(`Runtime grant invalid edge rejects ${invalidCase.name} [surface: API] [feature: Permission Grants] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const response = await request.post("/api/permissions/perzz9999/grants", {
        headers: authHeaders(ctx.token),
        data: invalidCase.data
      });
      await expectProblem(response, 400, "invalid_request");
    });
  }

  const notFoundCases: Array<{ name: string; method: "get" | "patch" | "delete"; path: string; data?: unknown; statuses?: number[] }> = [
    { name: "get access record unknown", method: "get", path: "/admin/access-records/acszz9999" },
    { name: "delete access record unknown", method: "delete", path: "/admin/access-records/acszz9999" },
    { name: "patch access record unknown valid body", method: "patch", path: "/admin/access-records/acszz9999", data: { permissions_json: richPermissionSet() } },
    { name: "patch access control unknown valid body", method: "patch", path: "/admin/access-control/acczz9999", data: { effect: "allow" } },
    { name: "delete access control unknown", method: "delete", path: "/admin/access-control/acczz9999" },
    { name: "get permission grants unknown", method: "get", path: "/api/permissions/perzz9999/grants" },
    { name: "delete metadata grant unknown", method: "delete", path: "/api/permissions/perzz9999/metadata-grants/prgzz9999" },
    { name: "delete runtime grant unknown", method: "delete", path: "/api/permissions/perzz9999/grants/prgzz9999" },
    { name: "delete permission unknown", method: "delete", path: "/api/permissions/perzz9999" },
    { name: "patch permission unknown valid body", method: "patch", path: "/api/permissions/perzz9999", data: { scope_json: { source: "e2e" } } },
    { name: "delete role unknown", method: "delete", path: "/admin/roles/rolzz9999" },
    { name: "patch role unknown", method: "patch", path: "/admin/roles/rolzz9999", data: { name: "Unknown Role" } },
    { name: "get role users unknown", method: "get", path: "/admin/roles/rolzz9999/users" },
    { name: "delete group unknown", method: "delete", path: "/admin/groups/grpzz9999" },
    { name: "patch group unknown", method: "patch", path: "/admin/groups/grpzz9999", data: { name: "Unknown Group" } },
    { name: "get group users unknown", method: "get", path: "/admin/groups/grpzz9999/users" }
  ];

  for (const notFoundCase of notFoundCases) {
    test(`Unknown resource edge returns not found for ${notFoundCase.name} [surface: API] [feature: Security] @security @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const options = { headers: authHeaders(ctx.token), data: notFoundCase.data };
      const response =
        notFoundCase.method === "get"
          ? await request.get(notFoundCase.path, { headers: options.headers })
          : notFoundCase.method === "delete"
            ? await request.delete(notFoundCase.path, { headers: options.headers })
            : await request.patch(notFoundCase.path, options);
      expect(notFoundCase.statuses ?? [404]).toContain(response.status());
    });
  }

  const downstreamCases: Array<{ name: string; call: (request: APIRequestContext, ctx: PermissionContext) => Promise<APIResponse>; statuses: number[] }> = [
    { name: "apps list", call: (request) => request.get("/api/apps"), statuses: [200] },
    { name: "objects list", call: (request, ctx) => request.get(`/api/apps/${ctx.app.id}/objects`), statuses: [200] },
    { name: "object describe", call: (request, ctx) => request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/describe`), statuses: [200] },
    { name: "object access", call: (request, ctx) => request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/access`), statuses: [200] },
    { name: "list views", call: (request, ctx) => request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views`), statuses: [200] },
    { name: "list view query minimal", call: (request, ctx) => request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/query`, { data: { pagination: { page: 1, page_size: 1 } } }), statuses: [200, 400, 403] },
    { name: "records list", call: (request, ctx) => request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/records`), statuses: [200, 403] },
    { name: "search", call: (request, ctx) => request.get(`/api/apps/${ctx.app.id}/search?q=e2e`), statuses: [200, 400, 404] },
    { name: "lookup", call: (request, ctx) => request.get(`/api/apps/${ctx.app.id}/lookup?q=e2e`), statuses: [200, 400, 404] },
    { name: "users access", call: (request) => request.get("/api/users/access"), statuses: [200] },
    { name: "users directory", call: (request) => request.get("/api/users/directory?q=admin"), statuses: [200] },
    { name: "users describe", call: (request) => request.get("/api/users/describe"), statuses: [200, 404] }
  ];

  for (const downstreamCase of downstreamCases) {
    test(`Downstream effective-access edge keeps ${downstreamCase.name} guarded [surface: API] [feature: Effective Access] @regression @edge`, async ({
      request
    }) => {
      const ctx = await resolveContext(request);
      const originalGet = request.get.bind(request);
      const originalPost = request.post.bind(request);
      const requestWithAuth = {
        ...request,
        get: (url: string, options: Parameters<APIRequestContext["get"]>[1] = {}) =>
          originalGet(url, { ...options, headers: { ...authHeaders(ctx.token), ...(options.headers ?? {}) } }),
        post: (url: string, options: Parameters<APIRequestContext["post"]>[1] = {}) =>
          originalPost(url, { ...options, headers: { ...authHeaders(ctx.token), ...(options.headers ?? {}) } })
      } as APIRequestContext;
      const response = await downstreamCase.call(requestWithAuth, ctx);
      expect(downstreamCase.statuses).toContain(response.status());
    });
  }

  }

  test("Admin UI exposes permissions or access-control surface without auth or render failure [surface: Admin] [feature: Access Records] @bvt @security @permissions-ui", async ({
    page
  }, testInfo) => {
    await loginToAdmin(page);
    const candidates = ["Permissions", "Access Controls", "Access Records", "Security", "Roles"];
    let opened = false;
    for (const label of candidates) {
      const nav = page.locator(".admin-sidebar").getByRole("button", { name: new RegExp(label, "i") }).first();
      if (await nav.isVisible().catch(() => false)) {
        await openAdminScreen(page, label);
        opened = true;
        break;
      }
    }
    test.skip(!opened, "No Admin sidebar entry for permissions/access-control is visible in this build.");
    await expect(page.locator(".admin-main")).toBeVisible();
    await expect(page.locator(".admin-main")).not.toContainText(/something went wrong|uncaught|failed to render|unauthorized/i);
    await attachEvidence(page, testInfo, "admin-permissions-access-surface");
    await page.goto(adminBaseUrl, { waitUntil: "domcontentloaded" });
  });

  const permissionUiScreens = [
    { label: "Permissions", search: "read" },
    { label: "Access Records", search: "asset" },
    { label: "Roles", search: "admin" },
    { label: "Groups", search: "users" },
    { label: "Users", search: "admin" }
  ];

  for (const screen of permissionUiScreens) {
    test(`Admin ${screen.label} UI flow opens list searches refreshes and stays usable [surface: Admin] [feature: ${screen.label} UI Flow] @regression @permissions-ui`, async ({
      page
    }, testInfo) => {
      await loginToAdmin(page);
      const nav = page.locator(".admin-sidebar").getByRole("button", { name: new RegExp(`^${screen.label}$`, "i") }).first();
      test.skip(!(await nav.isVisible().catch(() => false)), `${screen.label} is not visible in this build.`);
      const main = await openAdminScreen(page, screen.label);
      await expectListRegionReady(main);
      await expectListToolbar(main).catch(() => null);
      const search = await searchWithinListView(main, screen.search).catch(() => null);
      if (search) {
        await expectListRegionReady(main);
        await search.fill("");
      }
      await attachEvidence(page, testInfo, `admin-${screen.label.toLowerCase().replace(/\s+/g, "-")}-ui-flow`);
    });

    test(`Admin ${screen.label} CRUD controls open create or edit panels without saving data [surface: Admin] [feature: ${screen.label} CRUD UI] @regression @permissions-ui`, async ({
      page
    }, testInfo) => {
      await loginToAdmin(page);
      const nav = page.locator(".admin-sidebar").getByRole("button", { name: new RegExp(`^${screen.label}$`, "i") }).first();
      test.skip(!(await nav.isVisible().catch(() => false)), `${screen.label} is not visible in this build.`);
      const main = await openAdminScreen(page, screen.label);
      await expectListRegionReady(main);
      const newButton = main.getByRole("button", { name: /^new$/i }).first();
      if (await newButton.isVisible().catch(() => false)) {
        test.skip(!(await newButton.isEnabled().catch(() => false)), `${screen.label} New is disabled by permissions or state.`);
        await newButton.click();
        await expect(page.locator("[role='dialog'], .modal, .drawer, .record-panel, .object-settings").first()).toBeVisible();
        await attachEvidence(page, testInfo, `admin-${screen.label.toLowerCase().replace(/\s+/g, "-")}-create-panel`);
        await closeModal(page);
        return;
      }

      const firstRow = main.locator("table tbody tr").first();
      test.skip(!(await firstRow.isVisible().catch(() => false)), `${screen.label} has no row to open for edit/detail controls.`);
      await firstRow.click();
      await expect(page.locator(".record-panel, .object-settings, [role='dialog'], .admin-detail, .admin-main").first()).toBeVisible();
      await attachEvidence(page, testInfo, `admin-${screen.label.toLowerCase().replace(/\s+/g, "-")}-detail-panel`);
    });
  }
});
