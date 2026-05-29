import { expect, test, type APIRequestContext, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  adminBaseUrl,
  apiLogin,
  attachEvidence,
  authHeaders,
  expectListRegionReady,
  hasCredentials,
  loginToAdmin,
  searchWithinListView,
  selectKeystoneAppAndTab,
  serviceBaseUrl
} from "./helpers";

type ApiUser = {
  id: string;
  username: string;
  status?: string;
  is_super_user?: boolean;
};

type ApiPermission = {
  id: string;
  resource_type: string;
  resource_id: string | null;
  action: string;
  resource_name?: string | null;
};

type ApiPermissionGrant = {
  id: string;
  permission_id: string;
  principal_type: "user" | "role" | "group";
  principal_id: string;
  effect?: "allow" | "deny";
  source?: "metadata" | "runtime";
};

type ApiApp = { id: string; label?: string };
type ApiTab = {
  id: string;
  label?: string;
  object_id?: string | null;
  object_api_name?: string | null;
  object_label?: string | null;
};
type ApiAccessRecord = { id: string };

const KEYSTONE_BASE_URL =
  process.env.TEST_BASE_URL || process.env.TEST_UI_URL || "http://localhost:5003";
const EFFECT_USER = process.env.PERMISSIONS_EFFECT_USERNAME || "auto.case.user.528a";
const EFFECT_PASSWORD = process.env.PERMISSIONS_EFFECT_PASSWORD || "PermTest123!";
const KEYSTONE_FIXTURE_APPS = ["Core Platform", "Operations Hub", "CRM"];
const KEYSTONE_FIXTURE_TABS = ["Asset", "Account", "Vendor"];

const readJson = async <T>(response: Awaited<ReturnType<APIRequestContext["get"]>>) => {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON response, received: ${text}`);
  }
};

const findEffectUser = async (request: APIRequestContext, token: string) => {
  const response = await request.get(`/admin/users?q=${encodeURIComponent(EFFECT_USER)}`, {
    headers: authHeaders(token)
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const users = ((await readJson<{ items?: ApiUser[] }>(response)).items ?? []).filter(
    (user) => user.username === EFFECT_USER
  );
  return users.find((user) => user.status === "active" && user.is_super_user !== true) ?? null;
};

const resetEffectUserPassword = async (request: APIRequestContext, token: string, userId: string) => {
  const response = await request.post(`/admin/users/${userId}/password`, {
    headers: authHeaders(token),
    data: { password: EFFECT_PASSWORD }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
};

const findExportPermission = async (request: APIRequestContext, token: string) => {
  const response = await request.get("/api/permissions?resource_type=feature&resource_id=export&action=use", {
    headers: authHeaders(token)
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const items = (await readJson<{ items?: ApiPermission[] }>(response)).items ?? [];
  return items[0] ?? null;
};

const listGrants = async (request: APIRequestContext, token: string, permissionId: string) => {
  const response = await request.get(`/api/permissions/${permissionId}/grants`, {
    headers: authHeaders(token)
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await readJson<{ items?: ApiPermissionGrant[] }>(response)).items ?? [];
};

const deleteGrantByApi = async (
  request: APIRequestContext,
  token: string,
  permissionId: string,
  grant: ApiPermissionGrant
) => {
  const path =
    grant.source === "metadata"
      ? `/api/permissions/${permissionId}/metadata-grants/${grant.id}`
      : `/api/permissions/${permissionId}/grants/${grant.id}`;
  await request.delete(path, { headers: authHeaders(token) }).catch(() => null);
};

const cleanupEffectUserGrants = async (
  request: APIRequestContext,
  token: string,
  permissionId: string,
  userId: string
) => {
  const grants = await listGrants(request, token, permissionId);
  for (const grant of grants) {
    if (grant.principal_type === "user" && grant.principal_id === userId) {
      await deleteGrantByApi(request, token, permissionId, grant);
    }
  }
};

const findPermission = async (
  request: APIRequestContext,
  token: string,
  input: { resourceType: string; resourceId: string; action: string }
) => {
  const response = await request.get(
    `/api/permissions?resource_type=${encodeURIComponent(input.resourceType)}&resource_id=${encodeURIComponent(
      input.resourceId
    )}&action=${encodeURIComponent(input.action)}`,
    { headers: authHeaders(token) }
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const items = (await readJson<{ items?: ApiPermission[] }>(response)).items ?? [];
  return items.find(
    (item) =>
      item.resource_type === input.resourceType &&
      item.resource_id === input.resourceId &&
      item.action === input.action
  ) ?? null;
};

const createRuntimeGrantByApi = async (
  request: APIRequestContext,
  token: string,
  permissionId: string,
  userId: string,
  effect: "allow" | "deny" = "allow"
) => {
  const response = await request.post(`/api/permissions/${permissionId}/grants`, {
    headers: authHeaders(token),
    data: { principal_type: "user", principal_id: userId, effect }
  });
  if (response.status() === 409) return null;
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await readJson<ApiPermissionGrant>(response)).id;
};

const prepareKeystoneFixtureAccess = async (
  request: APIRequestContext,
  token: string,
  userId: string
) => {
  const appsResponse = await request.get("/api/apps", { headers: authHeaders(token) });
  expect(appsResponse.ok(), await appsResponse.text()).toBeTruthy();
  const apps = (await readJson<{ items?: ApiApp[] }>(appsResponse)).items ?? [];
  const app =
    KEYSTONE_FIXTURE_APPS.map((label) => apps.find((item) => item.label === label)).find(Boolean) ?? apps[0] ?? null;
  expect(app, "A Keystone app is required for permission effect verification.").toBeTruthy();

  const tabsResponse = await request.get(`/api/apps/${app!.id}/tabs`, { headers: authHeaders(token) });
  expect(tabsResponse.ok(), await tabsResponse.text()).toBeTruthy();
  const tabs = ((await readJson<{ items?: ApiTab[] }>(tabsResponse)).items ?? []).filter((item) => item.object_id);
  const tab =
    KEYSTONE_FIXTURE_TABS.map((label) =>
      tabs.find((item) => item.label === label || item.object_label === label || item.object_api_name === label.toLowerCase())
    ).find(Boolean) ??
    tabs[0] ??
    null;
  expect(tab, "A Keystone object tab is required for permission effect verification.").toBeTruthy();

  const createdGrantIds: Array<{ permissionId: string; grantId: string }> = [];
  for (const permissionInput of [
    { resourceType: "app", resourceId: app!.id, action: "view" },
    { resourceType: "tab", resourceId: tab!.id, action: "view" }
  ]) {
    const permission = await findPermission(request, token, permissionInput);
    if (permission) {
      await cleanupEffectUserGrants(request, token, permission.id, userId);
      const grantId = await createRuntimeGrantByApi(request, token, permission.id, userId, "allow");
      if (grantId) createdGrantIds.push({ permissionId: permission.id, grantId });
    }
  }

  const accessResponse = await request.post("/admin/access-records", {
    headers: authHeaders(token),
    data: {
      object_id: tab!.object_id,
      principal_type: "user",
      principal_id: userId,
      permissions_json: { object: { read: true, view_all: true } }
    }
  });
  let accessRecordId = "";
  let accessRecordCreated = false;
  if (accessResponse.status() === 409) {
    const query = new URLSearchParams({ object_id: tab!.object_id ?? "", principal_type: "user", principal_id: userId });
    const existing = await request.get(`/admin/access-records?${query.toString()}`, { headers: authHeaders(token) });
    accessRecordId = ((await readJson<{ items?: ApiAccessRecord[] }>(existing)).items ?? [])[0]?.id ?? "";
  } else {
    expect(accessResponse.ok(), await accessResponse.text()).toBeTruthy();
    accessRecordId = (await readJson<ApiAccessRecord>(accessResponse)).id;
    accessRecordCreated = true;
  }

  return {
    appLabel: app!.label ?? "",
    tabLabel: tab!.label ?? "",
    accessRecordId,
    accessRecordCreated,
    createdGrantIds
  };
};

const cleanupKeystoneFixtureAccess = async (
  request: APIRequestContext,
  token: string,
  fixture?: Awaited<ReturnType<typeof prepareKeystoneFixtureAccess>>
) => {
  if (!fixture) return;
  for (const grant of fixture.createdGrantIds) {
    await deleteGrantByApi(request, token, grant.permissionId, {
      id: grant.grantId,
      permission_id: grant.permissionId,
      principal_type: "user",
      principal_id: "",
      source: "runtime"
    });
  }
  if (fixture.accessRecordCreated && fixture.accessRecordId) {
    await request.delete(`/admin/access-records/${fixture.accessRecordId}`, { headers: authHeaders(token) }).catch(() => null);
  }
};

const loginAsEffectUser = async (request: APIRequestContext) => {
  let lastResponseText = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request.post(`${serviceBaseUrl}/auth/login`, {
      data: { username: EFFECT_USER, password: EFFECT_PASSWORD }
    });
    lastResponseText = await response.text();
    if (response.ok()) {
      const body = JSON.parse(lastResponseText) as {
        access_token?: string;
        token?: string;
        refresh_token?: string;
        refresh_family_id?: string;
      };
      const token = body.access_token ?? body.token ?? "";
      expect(token).toBeTruthy();
      return {
        token,
        refreshToken: body.refresh_token ?? "",
        refreshFamilyId: body.refresh_family_id ?? ""
      };
    }
    if (response.status() !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  throw new Error(`Effect user login failed: ${lastResponseText}`);
};

const checkExportPermissionAsEffectUser = async (request: APIRequestContext) => {
  const session = await loginAsEffectUser(request);
  const response = await request.post(`${serviceBaseUrl}/api/permissions/check`, {
    headers: authHeaders(session.token),
    data: { resource_type: "feature", resource_id: "export", action: "use" }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await readJson<{ allowed: boolean; reason?: string | null }>(response)).allowed;
};

const loadExportPermissionContext = async (request: APIRequestContext) => {
  const adminToken = await apiLogin(request);
  const user = await findEffectUser(request, adminToken);
  test.skip(!user, `Active non-super effect user ${EFFECT_USER} was not found.`);
  await resetEffectUserPassword(request, adminToken, user.id);
  const permission = await findExportPermission(request, adminToken);
  test.skip(!permission, "Feature export/use permission was not found.");
  return {
    adminToken,
    user: user as ApiUser,
    permission: permission as ApiPermission
  };
};

const openExportPermissionDetail = async (page: Page) => {
  await loginToAdmin(page);
  await page.goto(`${adminBaseUrl}/?nav=permissions`, { waitUntil: "domcontentloaded" });
  const main = page.locator(".admin-main").first();
  await expectListRegionReady(main);
  await searchWithinListView(main, "Exports");
  const row = main.locator("table tbody tr").filter({ hasText: /Exports/i }).filter({ hasText: /use/i }).first();
  await expect(row).toBeVisible({ timeout: 8_000 });
  await row.click();
  await expect(page.locator("#permission-grant-source")).toBeVisible({ timeout: 8_000 });
};

const addRuntimeGrantThroughPermissionsPage = async (
  page: Page,
  input: { userId: string; effect: "allow" | "deny" }
) => {
  await page.locator("#permission-grant-source").selectOption("runtime");
  await page.locator("#permission-grant-effect").selectOption(input.effect);
  await page.locator("#permission-grant-principal-type").selectOption("user");
  await expect(page.locator(`#permission-grant-principal option[value="${input.userId}"]`)).toBeAttached({
    timeout: 8_000
  });
  await page.locator("#permission-grant-principal").selectOption(input.userId);
  await page.getByRole("button", { name: /^add grant$/i }).click();
  await expect(page.locator(".grant-row").filter({ hasText: new RegExp(input.effect, "i") }).filter({ hasText: /runtime/i }).first()).toBeVisible({
    timeout: 8_000
  });
};

const currentUserGrantRow = (page: Page, effect?: "allow" | "deny") => {
  let row = page.locator(".grant-row");
  if (effect) row = row.filter({ hasText: new RegExp(effect, "i") });
  return row.filter({ hasText: /runtime/i }).first();
};

const removeCurrentUserGrantThroughPermissionsPage = async (page: Page, effect?: "allow" | "deny") => {
  const row = currentUserGrantRow(page, effect);
  await expect(row).toBeVisible({ timeout: 8_000 });
  await row.getByRole("button", { name: /^remove$/i }).click();
  await expect(page.getByRole("heading", { name: /^remove grant$/i })).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: /^confirm$/i }).click();
  await expect(row).toBeHidden({ timeout: 8_000 });
};

const openKeystoneAsEffectUser = async (
  page: Page,
  request: APIRequestContext,
  expectExports: boolean,
  testInfo: TestInfo,
  evidenceName: string
) => {
  const session = await loginAsEffectUser(request);
  const keystonePage = await page.context().newPage();
  const storagePayload = {
    token: session.token,
    username: EFFECT_USER,
    refreshToken: session.refreshToken,
    refreshFamilyId: session.refreshFamilyId
  };
  try {
    await keystonePage.addInitScript(({ token, username, refreshToken, refreshFamilyId }) => {
      window.sessionStorage.clear();
      window.localStorage.clear();
      window.sessionStorage.setItem("shockwave.auth_namespace_v1", "1");
      window.sessionStorage.setItem("shockwave.auth_token", token);
      window.sessionStorage.setItem("shockwave.current_username", username);
      window.sessionStorage.setItem("core_platform.auth_token", token);
      window.sessionStorage.setItem("core_platform.current_username", username);
      if (refreshToken) {
        window.sessionStorage.setItem("shockwave.refresh_token", refreshToken);
        window.sessionStorage.setItem("core_platform.refresh_token", refreshToken);
      }
      if (refreshFamilyId) {
        window.sessionStorage.setItem("shockwave.refresh_family_id", refreshFamilyId);
        window.sessionStorage.setItem("core_platform.refresh_family_id", refreshFamilyId);
      }
    }, storagePayload);
    await keystonePage.goto(KEYSTONE_BASE_URL, { waitUntil: "domcontentloaded" });
    await keystonePage.locator('[data-permissions-loaded="true"]').first().waitFor({ state: "visible", timeout: 8_000 });
    const noApps = keystonePage.getByText(/no accessible apps/i).first();
    expect(await noApps.isVisible().catch(() => false), `${EFFECT_USER} must have Keystone app access for this E2E.`).toBe(
      false
    );
    const { objectHome } = await selectKeystoneAppAndTab(keystonePage, ["Core Platform", "Operations Hub", "CRM"], [
      "Asset",
      "Account",
      "Vendor"
    ]);
    await attachEvidence(keystonePage, testInfo, evidenceName);
    const exportButton = objectHome.getByRole("button", { name: /export csv/i }).first();
    if (expectExports) {
      await expect(exportButton).toBeVisible({ timeout: 8_000 });
      await expect(exportButton).toBeEnabled({ timeout: 8_000 });
    } else {
      await expect(exportButton).toBeVisible({ timeout: 8_000 });
      await expect(exportButton).toBeDisabled({ timeout: 8_000 });
    }
  } finally {
    await keystonePage.close().catch(() => null);
  }
};

test.describe("Admin Permissions page Keystone effects", () => {
  test("Admin Permissions list opens Exports permission detail and exposes grant controls @permissions-page-e2e @permissions-ui [surface: Admin] [feature: Permissions page navigation] [precondition: admin can open Permissions] [input: open Permissions, search Exports, open use permission] [expected: permission details and add-grant controls render] [proof: MCP-mapped selectors are covered by automation]", async ({
    page,
    request
  }, testInfo) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.setTimeout(60_000);
    await loadExportPermissionContext(request);

    await openExportPermissionDetail(page);
    await expect(page.getByText(/Permission Details/i).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.locator("#permission-grant-source")).toHaveValue("runtime");
    await expect(page.locator("#permission-grant-effect")).toHaveValue("allow");
    await expect(page.locator("#permission-grant-principal-type")).toHaveValue("role");
    await expect(page.locator("#permission-grant-principal")).toBeVisible();
    await expect(page.getByRole("button", { name: /^add grant$/i })).toBeVisible();
    await attachEvidence(page, testInfo, "admin-permissions-exports-detail-controls");
  });

  test("Admin Permissions grant principal selector switches role group and user options @permissions-page-e2e @permissions-ui [surface: Admin] [feature: Permissions grant form] [precondition: Exports permission detail is open] [input: switch Principal Type between role, group, and user] [expected: principal selector refreshes and includes the target non-super user] [proof: validates all principal type controls on Permissions page]", async ({
    page,
    request
  }, testInfo) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.setTimeout(60_000);
    const { user } = await loadExportPermissionContext(request);

    await openExportPermissionDetail(page);
    for (const principalType of ["role", "group", "user"] as const) {
      await page.locator("#permission-grant-principal-type").selectOption(principalType);
      await expect(page.locator("#permission-grant-principal option").first()).toBeAttached({ timeout: 8_000 });
    }
    await expect(page.locator(`#permission-grant-principal option[value="${user.id}"]`)).toBeAttached({
      timeout: 8_000
    });
    await attachEvidence(page, testInfo, "admin-permissions-principal-type-user-options");
  });

  test("Admin Permissions duplicate runtime grant is blocked before backend mutation @permissions-page-e2e @permissions-ui [surface: Admin] [feature: Permission grant validation] [precondition: runtime allow grant already exists for user] [input: add the same runtime allow grant again] [expected: duplicate runtime grant message appears and only one grant remains] [proof: validates Permissions page duplicate guard]", async ({
    page,
    request
  }, testInfo) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.setTimeout(60_000);
    const { adminToken, user, permission } = await loadExportPermissionContext(request);

    try {
      await cleanupEffectUserGrants(request, adminToken, permission.id, user.id);
      await openExportPermissionDetail(page);
      await addRuntimeGrantThroughPermissionsPage(page, { userId: user.id, effect: "allow" });
      await page.locator("#permission-grant-principal").selectOption(user.id);
      await page.getByRole("button", { name: /^add grant$/i }).click();
      await expect(page.getByText(/runtime permission grant already exists/i).first()).toBeVisible({
        timeout: 8_000
      });
      const matchingGrants = (await listGrants(request, adminToken, permission.id)).filter(
        (grant) =>
          grant.principal_type === "user" &&
          grant.principal_id === user.id &&
          grant.source === "runtime" &&
          grant.effect === "allow"
      );
      expect(matchingGrants).toHaveLength(1);
      await attachEvidence(page, testInfo, "admin-permissions-duplicate-runtime-grant-blocked");
    } finally {
      await cleanupEffectUserGrants(request, adminToken, permission.id, user.id);
    }
  });

  test("Admin Permissions opposite runtime effect is blocked until existing grant is removed @permissions-page-e2e @permissions-ui [surface: Admin] [feature: Permission grant validation] [precondition: runtime allow grant exists for user] [input: change effect to deny and click Add Grant] [expected: opposite effect conflict is shown and permission remains allowed] [proof: validates Permissions page conflict guard]", async ({
    page,
    request
  }, testInfo) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.setTimeout(60_000);
    const { adminToken, user, permission } = await loadExportPermissionContext(request);

    try {
      await cleanupEffectUserGrants(request, adminToken, permission.id, user.id);
      await openExportPermissionDetail(page);
      await addRuntimeGrantThroughPermissionsPage(page, { userId: user.id, effect: "allow" });
      await page.locator("#permission-grant-effect").selectOption("deny");
      await page.locator("#permission-grant-principal").selectOption(user.id);
      await page.getByRole("button", { name: /^add grant$/i }).click();
      await expect(page.getByText(/opposite effect already exists/i).first()).toBeVisible({ timeout: 8_000 });
      await expect.poll(() => checkExportPermissionAsEffectUser(request), { timeout: 8_000 }).toBe(true);
      await attachEvidence(page, testInfo, "admin-permissions-opposite-effect-blocked");
    } finally {
      await cleanupEffectUserGrants(request, adminToken, permission.id, user.id);
    }
  });

  test("Admin Permissions runtime grant removal changes Keystone export from enabled to disabled @permissions-page-e2e @permissions-ui [surface: Admin + Keystone] [feature: Permissions page removal connected effect] [precondition: non-super user has Keystone fixture access] [input: add runtime allow in Admin Permissions, verify Keystone enabled, remove grant, verify Keystone disabled] [expected: removing the grant from Permissions page immediately removes Keystone export capability] [proof: validates Add, Remove, API check, and Keystone UI connection]", async ({
    page,
    request
  }, testInfo) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.setTimeout(90_000);
    const { adminToken, user, permission } = await loadExportPermissionContext(request);
    let fixture: Awaited<ReturnType<typeof prepareKeystoneFixtureAccess>> | undefined;

    try {
      fixture = await prepareKeystoneFixtureAccess(request, adminToken, user.id);
      await cleanupEffectUserGrants(request, adminToken, permission.id, user.id);
      await openExportPermissionDetail(page);
      await addRuntimeGrantThroughPermissionsPage(page, { userId: user.id, effect: "allow" });
      await expect.poll(() => checkExportPermissionAsEffectUser(request), { timeout: 8_000 }).toBe(true);
      await openKeystoneAsEffectUser(page, request, true, testInfo, "keystone-export-enabled-before-grant-remove");

      await openExportPermissionDetail(page);
      await removeCurrentUserGrantThroughPermissionsPage(page, "allow");
      await expect.poll(() => checkExportPermissionAsEffectUser(request), { timeout: 8_000 }).toBe(false);
      await openKeystoneAsEffectUser(page, request, false, testInfo, "keystone-export-disabled-after-grant-remove");
    } finally {
      await cleanupEffectUserGrants(request, adminToken, permission.id, user.id);
      await cleanupKeystoneFixtureAccess(request, adminToken, fixture);
    }
  });

  test("Admin Permissions runtime export grant toggles Keystone export controls for non-super user @permissions-page-e2e @permissions-ui [surface: Admin + Keystone] [feature: Permissions page connected effect] [precondition: active non-super Keystone user exists and Admin can manage Permissions] [input: open Admin Permissions -> search Exports permission -> add runtime allow for user -> verify Keystone export action is enabled -> replace with runtime deny -> verify Keystone export action is disabled -> cleanup grant] [expected: Permissions page grant changes are reflected by Keystone permission loading for the same user] [proof: uses real Admin Permissions page controls and Keystone UI, not only API checks]", async ({
    page,
    request
  }, testInfo) => {
  test.skip(!hasCredentials(), "Admin credentials are not configured.");
  test.setTimeout(90_000);

    const adminToken = await apiLogin(request);
    const user = await findEffectUser(request, adminToken);
    test.skip(!user, `Active non-super effect user ${EFFECT_USER} was not found.`);
    await resetEffectUserPassword(request, adminToken, user.id);
    const permission = await findExportPermission(request, adminToken);
    test.skip(!permission, "Feature export/use permission was not found.");
    let fixture: Awaited<ReturnType<typeof prepareKeystoneFixtureAccess>> | undefined;

    try {
      fixture = await prepareKeystoneFixtureAccess(request, adminToken, user.id);
      await cleanupEffectUserGrants(request, adminToken, permission.id, user.id);

      await openExportPermissionDetail(page);
      await addRuntimeGrantThroughPermissionsPage(page, { userId: user.id, effect: "allow" });
      await expect.poll(() => checkExportPermissionAsEffectUser(request), { timeout: 8_000 }).toBe(true);
      await openKeystoneAsEffectUser(page, request, true, testInfo, "keystone-export-visible-after-admin-permission-allow");

      await cleanupEffectUserGrants(request, adminToken, permission.id, user.id);
      await openExportPermissionDetail(page);
      await addRuntimeGrantThroughPermissionsPage(page, { userId: user.id, effect: "deny" });
      await expect.poll(() => checkExportPermissionAsEffectUser(request), { timeout: 8_000 }).toBe(false);
      await openKeystoneAsEffectUser(page, request, false, testInfo, "keystone-export-hidden-after-admin-permission-deny");
    } finally {
      await cleanupEffectUserGrants(request, adminToken, permission?.id ?? "", user?.id ?? "");
      await cleanupKeystoneFixtureAccess(request, adminToken, fixture);
    }
  });
});
