import { expect, type APIRequestContext, type Locator, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  apiLogin,
  attachEvidence,
  authHeaders,
  expectListRegionReady,
  loginToAdmin,
  loginToKeystone,
  openAdminScreen,
  searchWithinListView
} from "./helpers";

type ApiApp = { id: string; label?: string; api_name?: string; app_prefix?: string };
type ApiObject = { id: string; label?: string; api_name?: string; app_id?: string; plural_label?: string | null };
type ApiTab = {
  id: string;
  label?: string;
  api_name?: string;
  object_id?: string | null;
  object_api_name?: string | null;
  app_id?: string | null;
  object_app_id?: string | null;
};
type ApiUser = { id: string; username?: string; name?: string; email?: string };
type ApiRoleOrGroup = { id: string; name?: string; app_id?: string };
type ApiAccessRecord = {
  id: string;
  object_id: string;
  principal_type: "user" | "role" | "group";
  principal_id: string;
  permissions_json?: {
    object?: {
      read?: boolean;
      create?: boolean;
      update?: boolean;
      delete?: boolean;
      view_all?: boolean;
      modify_all?: boolean;
    };
    attachments?: Record<string, boolean | undefined>;
    fields?: Record<string, Record<string, boolean | undefined>>;
  };
};
type ApiPermission = {
  id: string;
  resource_type: string;
  resource_id?: string | null;
  action: string;
  scope_json?: unknown;
};
type ApiPermissionGrant = {
  id: string;
  permission_id: string;
  principal_type: "user" | "role" | "group";
  principal_id: string;
  effect?: "allow" | "deny";
  source?: "metadata" | "runtime";
};

export type CreatedAdminApp = {
  id: string;
  label: string;
  apiName: string;
  prefix: string;
};

export type CreatedAdminObject = {
  id: string;
  label: string;
  pluralLabel: string;
  apiName: string;
  prefix: string;
};

export type CreatedAdminTab = {
  id: string;
  label: string;
  apiName: string;
};

export type CreatedSecurityPrincipal = {
  id: string;
  name: string;
};

export const uniqueStamp = () => Date.now().toString(36);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const safeApiName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

export const shortPrefix = (seed: string, fallback = "e2e") =>
  (seed.replace(/[^a-z0-9]/gi, "").toLowerCase() || fallback).slice(-3).padStart(3, "x");

const readJsonItems = async <T>(response: Awaited<ReturnType<APIRequestContext["get"]>>) => {
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { items?: T[] };
  return body.items ?? [];
};

export const findAppByLabel = async (request: APIRequestContext, label: string) => {
  const token = await apiLogin(request);
  const items = await readJsonItems<ApiApp>(await request.get("/api/apps", { headers: authHeaders(token) }));
  return items.find((item) => String(item.label ?? "").trim().toLowerCase() === label.trim().toLowerCase()) ?? null;
};

export const findObjectByLabel = async (request: APIRequestContext, appId: string, label: string) => {
  const token = await apiLogin(request);
  const items = await readJsonItems<ApiObject>(
    await request.get(`/api/apps/${appId}/objects`, { headers: authHeaders(token) })
  );
  return items.find((item) => String(item.label ?? "").trim().toLowerCase() === label.trim().toLowerCase()) ?? null;
};

export const findTabByLabel = async (request: APIRequestContext, appId: string, label: string) => {
  const token = await apiLogin(request);
  const items = await readJsonItems<ApiTab>(
    await request.get(`/api/apps/${appId}/tabs`, { headers: authHeaders(token) })
  );
  return items.find((item) => String(item.label ?? "").trim().toLowerCase() === label.trim().toLowerCase()) ?? null;
};

export const currentApiUser = async (request: APIRequestContext) => {
  const token = await apiLogin(request);
  const response = await request.get("/api/users/me", { headers: authHeaders(token) });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as ApiUser;
};

export const findAdminRoleOrGroupByName = async (
  request: APIRequestContext,
  type: "roles" | "groups",
  appId: string,
  name: string
) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);
  const readItems = async (query: string) => {
    const response = await request.get(`/admin/${type}${query}`, { headers });
    if (!response.ok()) return [];
    return ((await response.json()) as { items?: ApiRoleOrGroup[] }).items ?? [];
  };
  const scoped = await readItems(`?app_id=${encodeURIComponent(appId)}`);
  return (
    scoped.find((item) => String(item.name ?? "").trim() === name) ??
    (await readItems(`?q=${encodeURIComponent(name)}`)).find((item) => String(item.name ?? "").trim() === name) ??
    null
  );
};

export const deleteAdminRoleOrGroupByName = async (
  request: APIRequestContext,
  type: "roles" | "groups",
  appId: string,
  names: string[]
) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);
  const scopedResponse = await request.get(`/admin/${type}?app_id=${encodeURIComponent(appId)}`, { headers });
  const scopedItems = scopedResponse.ok()
    ? ((await scopedResponse.json()) as { items?: ApiRoleOrGroup[] }).items ?? []
    : [];
  for (const name of names) {
    const queryResponse = await request.get(`/admin/${type}?q=${encodeURIComponent(name)}`, { headers });
    const queryItems = queryResponse.ok()
      ? ((await queryResponse.json()) as { items?: ApiRoleOrGroup[] }).items ?? []
      : [];
    const ids = new Set(
      [...scopedItems, ...queryItems]
        .filter((candidate) => String(candidate.name ?? "").trim() === name)
        .map((candidate) => candidate.id)
        .filter(Boolean)
    );
    for (const id of ids) {
      await request.delete(`/admin/${type}/${id}`, { headers }).catch(() => null);
    }
  }
};

export const findAccessRecord = async (
  request: APIRequestContext,
  input: { objectId: string; principalType: "user" | "role" | "group"; principalId: string }
) => {
  const token = await apiLogin(request);
  const params = new URLSearchParams({
    object_id: input.objectId,
    principal_type: input.principalType,
    principal_id: input.principalId
  });
  const response = await request.get(`/admin/access-records?${params.toString()}`, {
    headers: authHeaders(token)
  });
  if (!response.ok()) return null;
  const items = ((await response.json()) as { items?: ApiAccessRecord[] }).items ?? [];
  return (
    items.find(
      (item) =>
        item.object_id === input.objectId &&
        item.principal_type === input.principalType &&
        item.principal_id === input.principalId
    ) ?? null
  );
};

export const waitForAccessRecord = async (
  request: APIRequestContext,
  input: { objectId: string; principalType: "user" | "role" | "group"; principalId: string }
) =>
  expect
    .poll(async () => findAccessRecord(request, input), { timeout: 20_000 })
    .not.toBeNull()
    .then(async () => {
      const record = await findAccessRecord(request, input);
      expect(record).toBeTruthy();
      return record as ApiAccessRecord;
    });

export const getAccessRecordById = async (request: APIRequestContext, id: string) => {
  const token = await apiLogin(request);
  const response = await request.get(`/admin/access-records/${id}`, { headers: authHeaders(token) });
  if (response.status() === 404) return null;
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as ApiAccessRecord;
};

export const deleteAccessRecordById = async (request: APIRequestContext, id?: string) => {
  if (!id) return;
  const token = await apiLogin(request);
  await request.delete(`/admin/access-records/${id}`, { headers: authHeaders(token) }).catch(() => null);
};

export const findGrantablePermission = async (request: APIRequestContext) => {
  const token = await apiLogin(request);
  const response = await request.get("/api/permissions", { headers: authHeaders(token) });
  expect(response.ok(), await response.text()).toBeTruthy();
  const permissions = ((await response.json()) as { items?: ApiPermission[] }).items ?? [];
  return (
    permissions.find((permission) => permission.resource_type === "permission" && permission.action === "manage") ??
    permissions.find((permission) => permission.resource_type === "object" && permission.action === "read") ??
    permissions[0] ??
    null
  );
};

export const listPermissionGrants = async (request: APIRequestContext, permissionId: string) => {
  const token = await apiLogin(request);
  const response = await request.get(`/api/permissions/${permissionId}/grants`, {
    headers: authHeaders(token)
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { items?: ApiPermissionGrant[] }).items ?? [];
};

export const deletePermissionGrantById = async (
  request: APIRequestContext,
  permissionId: string,
  grantId?: string,
  source: "metadata" | "runtime" = "runtime"
) => {
  if (!permissionId || !grantId) return;
  const token = await apiLogin(request);
  const path =
    source === "metadata"
      ? `/api/permissions/${permissionId}/metadata-grants/${grantId}`
      : `/api/permissions/${permissionId}/grants/${grantId}`;
  await request.delete(path, { headers: authHeaders(token) }).catch(() => null);
};

const waitForAppByLabel = async (request: APIRequestContext, label: string) =>
  expect
    .poll(async () => findAppByLabel(request, label), { timeout: 20_000 })
    .not.toBeNull()
    .then(async () => {
      const app = await findAppByLabel(request, label);
      expect(app).toBeTruthy();
      return app as ApiApp;
    });

const waitForObjectByLabel = async (request: APIRequestContext, appId: string, label: string) =>
  expect
    .poll(async () => findObjectByLabel(request, appId, label), { timeout: 20_000 })
    .not.toBeNull()
    .then(async () => {
      const object = await findObjectByLabel(request, appId, label);
      expect(object).toBeTruthy();
      return object as ApiObject;
    });

const waitForTabByLabel = async (request: APIRequestContext, appId: string, label: string) =>
  expect
    .poll(async () => findTabByLabel(request, appId, label), { timeout: 20_000 })
    .not.toBeNull()
    .then(async () => {
      const tab = await findTabByLabel(request, appId, label);
      expect(tab).toBeTruthy();
      return tab as ApiTab;
    });

export const selectOptionContainingText = async (select: Locator, text: string) => {
  await expect(select).toBeVisible();
  const option = select.locator("option").filter({ hasText: new RegExp(escapeRegex(text), "i") }).first();
  await option.waitFor({ state: "attached", timeout: 15_000 });
  const value = await option.getAttribute("value");
  expect(value, `No select option found containing "${text}".`).toBeTruthy();
  await select.selectOption(value ?? "");
};

export const openAdminListScreen = async (page: Page, screen: string) => {
  const main = await openAdminScreen(page, screen);
  const listTab = main
    .locator(".record-tabs, .admin-apps-primary-tabs")
    .getByRole("button", { name: new RegExp(`^${escapeRegex(screen)}$`, "i") })
    .first();
  if (await listTab.isVisible().catch(() => false)) {
    await listTab.click();
  }
  await expectListRegionReady(main);
  return main;
};

export const selectAdminAppContext = async (page: Page, appLabel: string) => {
  const current = page.locator(".nav-selected-app").first();
  const currentLabel = (await current.textContent().catch(() => "")) ?? "";
  if ((await current.isVisible().catch(() => false)) && currentLabel.includes(appLabel)) {
    return;
  }
  const launcherButton = page.getByRole("button", { name: /^apps$/i }).first();
  await expect(launcherButton).toBeVisible();
  await launcherButton.click();
  const panel = page.locator(".launcher-panel").filter({ hasText: /^Apps/i }).first();
  await expect(panel).toBeVisible();
  const search = panel.locator(".launcher-search").first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(appLabel);
  }
  const item = panel.locator(".launcher-list button").filter({ hasText: new RegExp(escapeRegex(appLabel), "i") }).first();
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.click();
  await expect(page.locator(".nav-selected-app").first()).toContainText(appLabel, { timeout: 20_000 });
};

export const openAdminRowByLabel = async (page: Page, screen: string, label: string) => {
  const main = await openAdminListScreen(page, screen);
  await searchWithinListView(main, label);
  const row = main.locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(label), "i") }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  return row;
};

export const createAdminAppViaUi = async (
  page: Page,
  request: APIRequestContext,
  input: { label: string; apiName?: string; prefix?: string },
  testInfo?: TestInfo
): Promise<CreatedAdminApp> => {
  await loginToAdmin(page);
  const apps = await openAdminListScreen(page, "Apps");
  await apps.getByRole("button", { name: /^new$/i }).click();
  await expect(page.getByRole("heading", { name: /^new app$/i })).toBeVisible();
  await page.locator("#create-app-label").fill(input.label);
  if (input.apiName) {
    await page.locator("#create-app-api").fill(input.apiName);
  }
  const apiName = input.apiName ?? (await page.locator("#create-app-api").inputValue());
  const prefix = input.prefix ?? shortPrefix(apiName);
  await page.locator("#create-app-prefix").fill(prefix);
  if (testInfo) await attachEvidence(page, testInfo, "admin-app-create-form");
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/app created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  const app = await waitForAppByLabel(request, input.label);
  return { id: app.id, label: input.label, apiName, prefix };
};

export const createAdminObjectViaUi = async (
  page: Page,
  request: APIRequestContext,
  app: CreatedAdminApp,
  input: { label: string; apiName?: string; pluralLabel?: string; prefix?: string },
  testInfo?: TestInfo
): Promise<CreatedAdminObject> => {
  await loginToAdmin(page);
  const objects = await openAdminListScreen(page, "Objects");
  await objects.getByRole("button", { name: /^new$/i }).click();
  await expect(page.getByRole("heading", { name: /^new object$/i })).toBeVisible();
  const appSelect = page.locator("#create-object-app");
  if (await appSelect.isVisible().catch(() => false)) {
    await selectOptionContainingText(appSelect, app.label);
  }
  await page.locator("#create-object-label").fill(input.label);
  if (input.apiName) {
    await page.locator("#create-object-api").fill(input.apiName);
  }
  if (input.pluralLabel) {
    await page.locator("#create-object-plural-label").fill(input.pluralLabel);
  }
  const apiName = input.apiName ?? (await page.locator("#create-object-api").inputValue());
  const pluralLabel = input.pluralLabel ?? (await page.locator("#create-object-plural-label").inputValue());
  const prefix = input.prefix ?? shortPrefix(apiName);
  await page.locator("#create-object-prefix").fill(prefix);
  await page.locator("#create-object-depth").fill("5");
  if (testInfo) await attachEvidence(page, testInfo, "admin-object-create-step-1");
  await page.getByRole("button", { name: /^next$/i }).click();
  await expect(page.getByText(/step 2 of 2/i)).toBeVisible({ timeout: 20_000 });
  if (testInfo) await attachEvidence(page, testInfo, "admin-object-create-step-2");
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/object created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  const object = await waitForObjectByLabel(request, app.id, input.label);
  return { id: object.id, label: input.label, apiName, pluralLabel, prefix };
};

export const createAdminObjectTabViaUi = async (
  page: Page,
  request: APIRequestContext,
  app: CreatedAdminApp,
  object: CreatedAdminObject,
  input: { label: string; apiName?: string },
  testInfo?: TestInfo
): Promise<CreatedAdminTab> => {
  await loginToAdmin(page);
  const tabs = await openAdminListScreen(page, "Tabs");
  await tabs.getByRole("button", { name: /^new$/i }).click();
  await expect(page.getByRole("heading", { name: /^new tab$/i })).toBeVisible();
  const appSelect = page.locator("#create-tab-app");
  if (await appSelect.isVisible().catch(() => false)) {
    await selectOptionContainingText(appSelect, app.label);
  }
  await page.locator("#create-tab-type").selectOption("object");
  await selectOptionContainingText(page.locator("#create-tab-object"), object.label);
  await page.locator("#create-tab-label").fill(input.label);
  if (input.apiName) {
    await page.locator("#create-tab-api").fill(input.apiName);
  }
  const apiName = input.apiName ?? (await page.locator("#create-tab-api").inputValue());
  if (testInfo) await attachEvidence(page, testInfo, "admin-object-tab-create-form");
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/tab created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  const tab = await waitForTabByLabel(request, app.id, input.label);
  return { id: tab.id, label: input.label, apiName };
};

export const createAdminRoleViaUi = async (
  page: Page,
  request: APIRequestContext,
  app: CreatedAdminApp,
  input: { name: string; description: string },
  testInfo?: TestInfo
): Promise<CreatedSecurityPrincipal> => {
  await loginToAdmin(page);
  await selectAdminAppContext(page, app.label);
  const roles = await openAdminListScreen(page, "Roles");
  await roles.getByRole("button", { name: /^new$/i }).click();
  await expect(page.getByRole("heading", { name: /^new role$/i })).toBeVisible();
  const appSelect = page.locator("#create-role-app");
  if (await appSelect.isVisible().catch(() => false)) {
    await selectOptionContainingText(appSelect, app.label);
  }
  await page.locator("#create-role-name").fill(input.name);
  await page.locator("#create-role-desc").fill(input.description);
  if (testInfo) await attachEvidence(page, testInfo, "admin-role-create-form");
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/role created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  const role = await expect
    .poll(async () => findAdminRoleOrGroupByName(request, "roles", app.id, input.name), { timeout: 20_000 })
    .not.toBeNull()
    .then(async () => findAdminRoleOrGroupByName(request, "roles", app.id, input.name));
  expect(role).toBeTruthy();
  return { id: (role as ApiRoleOrGroup).id, name: input.name };
};

export const createAdminGroupViaUi = async (
  page: Page,
  request: APIRequestContext,
  app: CreatedAdminApp,
  input: { name: string; description: string },
  testInfo?: TestInfo
): Promise<CreatedSecurityPrincipal> => {
  await loginToAdmin(page);
  await selectAdminAppContext(page, app.label);
  const groups = await openAdminListScreen(page, "Groups");
  await groups.getByRole("button", { name: /^new$/i }).click();
  await expect(page.getByRole("heading", { name: /^new group$/i })).toBeVisible();
  const appSelect = page.locator("#create-group-app");
  if (await appSelect.isVisible().catch(() => false)) {
    await selectOptionContainingText(appSelect, app.label);
  }
  await page.locator("#create-group-name").fill(input.name);
  await page.locator("#create-group-desc").fill(input.description);
  if (testInfo) await attachEvidence(page, testInfo, "admin-group-create-form");
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/group created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  const group = await expect
    .poll(async () => findAdminRoleOrGroupByName(request, "groups", app.id, input.name), { timeout: 20_000 })
    .not.toBeNull()
    .then(async () => findAdminRoleOrGroupByName(request, "groups", app.id, input.name));
  expect(group).toBeTruthy();
  return { id: (group as ApiRoleOrGroup).id, name: input.name };
};

export const updateAdminObjectDetailsViaUi = async (
  page: Page,
  request: APIRequestContext,
  app: CreatedAdminApp,
  object: CreatedAdminObject,
  input: { label: string; pluralLabel: string },
  testInfo?: TestInfo
) => {
  await loginToAdmin(page);
  await openAdminRowByLabel(page, "Objects", object.label);
  const settingsTab = page.getByRole("button", { name: /^Settings/i }).first();
  if (await settingsTab.isVisible().catch(() => false)) {
    await settingsTab.click();
  }
  await expect(page.locator("#object-label")).toBeVisible();
  await page.locator("#object-label").fill(input.label);
  await page.locator("#object-plural-label").fill(input.pluralLabel);
  const globalSearch = page.locator("label").filter({ hasText: /global search enabled/i }).locator("input").first();
  if (await globalSearch.isVisible().catch(() => false)) {
    await globalSearch.check({ force: true });
  }
  const inlineEdit = page.locator("label").filter({ hasText: /inline edit enabled/i }).locator("input").first();
  if (await inlineEdit.isVisible().catch(() => false)) {
    await inlineEdit.check({ force: true });
  }
  if (testInfo) await attachEvidence(page, testInfo, "admin-object-edit-details");
  const metadataPanel = page.locator(".object-settings").filter({ hasText: /Object Metadata/i }).first();
  await metadataPanel.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/object details saved successfully/i).first()).toBeVisible({ timeout: 20_000 });
  const updated = await waitForObjectByLabel(request, app.id, input.label);
  return { ...object, label: input.label, pluralLabel: input.pluralLabel, id: updated.id };
};

const openKeystoneAppsLauncher = async (page: Page, query: string) => {
  await loginToKeystone(page);
  const appsButton = page.getByRole("button", { name: /^apps$/i }).first();
  await expect(appsButton).toBeVisible();
  await appsButton.click();
  const panel = page.locator(".launcher:not(.tabs-picker) .launcher-panel").first();
  await expect(panel).toBeVisible();
  const search = panel.locator(".launcher-search").first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(query);
  }
  return panel;
};

const launcherItem = (panel: Locator, label: string) =>
  panel.locator(".launcher-list .launcher-item").filter({ hasText: new RegExp(escapeRegex(label), "i") }).first();

export const expectKeystoneAppVisible = async (
  page: Page,
  label: string,
  testInfo?: TestInfo,
  evidenceName = "keystone-app-visible"
) => {
  const panel = await openKeystoneAppsLauncher(page, label);
  const item = launcherItem(panel, label);
  await expect(item).toBeVisible({ timeout: 20_000 });
  if (testInfo) await attachEvidence(page, testInfo, evidenceName);
  return item;
};

export const expectKeystoneAppHidden = async (
  page: Page,
  label: string,
  testInfo?: TestInfo,
  evidenceName = "keystone-app-hidden"
) => {
  const panel = await openKeystoneAppsLauncher(page, label);
  await expect(launcherItem(panel, label)).toBeHidden({ timeout: 20_000 });
  if (testInfo) await attachEvidence(page, testInfo, evidenceName);
};

export const openKeystoneObjectTab = async (
  page: Page,
  appLabel: string,
  tabLabel: string,
  objectApiName: string,
  testInfo?: TestInfo,
  evidenceName = "keystone-object-tab"
) => {
  const appsPanel = await openKeystoneAppsLauncher(page, appLabel);
  await launcherItem(appsPanel, appLabel).click();
  const tabsButton = page.getByRole("button", { name: /^tabs$/i }).first();
  await expect(tabsButton).toBeVisible({ timeout: 20_000 });
  await tabsButton.click();
  const tabsPanel = page.locator(".launcher.tabs-picker .launcher-panel").first();
  await expect(tabsPanel).toBeVisible();
  const tabSearch = tabsPanel.locator(".launcher-search").first();
  if (await tabSearch.isVisible().catch(() => false)) {
    await tabSearch.fill(tabLabel);
  }
  await launcherItem(tabsPanel, tabLabel).click();
  const objectHome = page.locator(".object-home").first();
  await expect(objectHome).toBeVisible({ timeout: 20_000 });
  await expect(objectHome).toHaveAttribute("data-object-api-name", objectApiName, { timeout: 20_000 });
  await expectListRegionReady(objectHome);
  if (testInfo) await attachEvidence(page, testInfo, evidenceName);
  return objectHome;
};

export const cleanupAdminMetadataByApi = async (
  request: APIRequestContext,
  input: {
    appId?: string;
    appLabel?: string;
    objectId?: string;
    objectLabel?: string;
    tabId?: string;
    tabLabel?: string;
  }
) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);
  let appId = input.appId;
  if (!appId && input.appLabel) {
    appId = (await findAppByLabel(request, input.appLabel))?.id;
  }
  let tabId = input.tabId;
  if (!tabId && appId && input.tabLabel) {
    tabId = (await findTabByLabel(request, appId, input.tabLabel))?.id;
  }
  if (tabId && appId) {
    await request.delete(`/admin/apps/${appId}/tabs/${tabId}`, { headers }).catch(() => null);
  }
  let objectId = input.objectId;
  if (!objectId && appId && input.objectLabel) {
    objectId = (await findObjectByLabel(request, appId, input.objectLabel))?.id;
  }
  if (objectId) {
    await request.delete(`/admin/objects/${objectId}`, { headers }).catch(() => null);
  }
  if (appId) {
    await request.delete(`/admin/apps/${appId}`, { headers }).catch(() => null);
  }
  for (const query of [input.tabLabel, input.objectLabel, input.appLabel].filter(Boolean) as string[]) {
    const response = await request.get(`/admin/recycle-bin?q=${encodeURIComponent(query)}&limit=50`, { headers });
    if (!response.ok()) continue;
    const items = ((await response.json()) as { items?: Array<{ id?: string }> }).items ?? [];
    for (const item of items) {
      if (item.id) {
        await request.delete(`/admin/recycle-bin/${item.id}`, { headers }).catch(() => null);
      }
    }
  }
};

export { safeApiName };
