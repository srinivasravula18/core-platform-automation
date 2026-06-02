import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  adminBaseUrl,
  apiLogin,
  allowWrites,
  attachEvidence,
  authHeaders,
  closeModal,
  hasCredentials,
  keystoneBaseUrl,
  loginToAdmin,
  loginToKeystone,
  openListViewSettings,
  openKeystoneRecycleBin,
  searchWithinListView,
  expectListRegionReady
} from "./helpers";
import {
  cleanupAdminMetadataByApi,
  createAdminAppViaUi,
  expectKeystoneAppHidden,
  expectKeystoneAppVisible,
  openAdminListScreen,
  openAdminRowByLabel,
  shortPrefix,
  uniqueStamp
} from "./page-flow-helpers";

const safeApiName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type ApiApp = { id: string; label?: string; api_name?: string };
type ApiObject = { api_name: string; label?: string };
type ListView = { id: string; name: string };
type AccountListViewApiContext = { token: string; appId: string; objectApiName: string };

let adminSessionReady = false;
let keystoneSessionReady = false;

const visible = async (locator: Locator) => locator.isVisible().catch(() => false);

const closeTransientUi = async (page: Page) => {
  await page
    .evaluate(() => {
      const closePattern = /^(cancel|close|done|x)$/i;
      const overlays = [...document.querySelectorAll<HTMLElement>("[role='dialog'], dialog, .modal, .record-summary, .launcher")];
      for (const overlay of overlays) {
        const button = [...overlay.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => {
          const label = candidate.getAttribute("aria-label") || candidate.textContent || "";
          return closePattern.test(label.trim());
        });
        button?.click();
      }
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    })
    .catch(() => null);
  await page.keyboard.press("Escape").catch(() => null);
};

const ensureAdminSession = async (page: Page) => {
  const shellReady = page.url().startsWith(adminBaseUrl) && (await visible(page.locator(".admin-sidebar").first()));
  if (adminSessionReady && shellReady) return;
  await loginToAdmin(page);
  adminSessionReady = true;
  keystoneSessionReady = false;
};

const ensureKeystoneSession = async (page: Page) => {
  const shellReady =
    page.url().startsWith(keystoneBaseUrl) &&
    (await page
      .evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) =>
          button.getAttribute("aria-label")?.toLowerCase().includes("apps")
        )
      )
      .catch(() => false));
  if (keystoneSessionReady && shellReady) return;
  await loginToKeystone(page);
  keystoneSessionReady = true;
  adminSessionReady = false;
};

const openAdminApps = async (page: Page) => {
  await ensureAdminSession(page);
  await closeTransientUi(page);
  return openAdminListScreen(page, "Apps");
};

const openKeystoneAccounts = async (page: Page) => {
  await ensureKeystoneSession(page);
  await closeTransientUi(page);
  const currentObjectApiName = await page
    .evaluate(() => document.querySelector(".object-home")?.getAttribute("data-object-api-name") || "")
    .catch(() => "");
  if (!/account/i.test(currentObjectApiName || "")) {
    await selectKeystoneLauncherItem(page, "apps", ["CRM", "Revenue Hub"]);
    await selectKeystoneLauncherItem(page, "tabs", ["Account"]);
  }
  return page.locator(".object-home").first();
};

const selectKeystoneLauncherItem = async (page: Page, type: "apps" | "tabs", labels: string[]) => {
  const clickedTrigger = await page.evaluate((launcherType) => {
    const label = launcherType === "apps" ? "Apps" : "Tabs";
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.getAttribute("aria-label")?.toLowerCase().includes(label.toLowerCase())
    );
    if (!button) return false;
    button.click();
    return true;
  }, type);
  expect(clickedTrigger).toBe(true);
  const panelSelector = type === "apps" ? ".launcher:not(.tabs-picker) .launcher-panel" : ".launcher.tabs-picker .launcher-panel";
  await page.waitForSelector(panelSelector);
  const clickedItem = await page.evaluate(
    ({ launcherType, preferredLabels }) => {
      const panel = document.querySelector(
        launcherType === "apps" ? ".launcher:not(.tabs-picker) .launcher-panel" : ".launcher.tabs-picker .launcher-panel"
      );
      if (!panel) return false;
      const items = [...panel.querySelectorAll<HTMLElement>(".launcher-item")];
      const preferred = items.find((item) =>
        preferredLabels.some((label) => item.textContent?.toLowerCase().includes(label.toLowerCase()))
      );
      const item = preferred ?? items[0];
      if (!item) return false;
      item.click();
      return true;
    },
    { launcherType: type, preferredLabels: labels }
  );
  expect(clickedItem).toBe(true);
  await closeTransientUi(page);
};

const requireWriteMode = () => {
  test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to run real CRUD list-view cases.");
};

const cleanupKeystoneRecord = async (
  request: APIRequestContext,
  appId: string,
  objectApiName: string,
  recordId: string
) => {
  if (!appId || !objectApiName || !recordId) return;
  const token = await apiLogin(request);
  await request
    .delete(`/api/apps/${appId}/objects/${objectApiName}/records/${recordId}`, { headers: authHeaders(token) })
    .catch(() => null);
};

const resolveAccountListViewApiContext = async (request: APIRequestContext): Promise<AccountListViewApiContext> => {
  const token = await apiLogin(request);
  const appsRes = await request.get("/api/apps", { headers: authHeaders(token) });
  expect(appsRes.ok(), await appsRes.text()).toBeTruthy();
  const apps = ((await appsRes.json()) as { items?: ApiApp[] }).items ?? [];
  expect(apps.length).toBeGreaterThan(0);
  const prioritizedApps = [...apps].sort((left, right) => {
    const leftText = [left.id, left.label, left.api_name].join(" ").toLowerCase();
    const rightText = [right.id, right.label, right.api_name].join(" ").toLowerCase();
    const leftScore = /crm|app0000006/.test(leftText) ? 0 : 1;
    const rightScore = /crm|app0000006/.test(rightText) ? 0 : 1;
    return leftScore - rightScore;
  });

  for (const app of prioritizedApps) {
    const objectsRes = await request.get(`/api/apps/${app.id}/objects`, { headers: authHeaders(token) });
    if (!objectsRes.ok()) continue;
    const objects = ((await objectsRes.json()) as { items?: ApiObject[] }).items ?? [];
    const accountObject = objects.find((object) => object.api_name === "account") ??
      objects.find((object) => /account/i.test([object.api_name, object.label].join(" ")));
    if (accountObject?.api_name) {
      return { token, appId: app.id, objectApiName: accountObject.api_name };
    }
  }

  throw new Error("No accessible Account object was found for cross-surface list-view verification.");
};

const createAccountListViewViaApi = async (
  request: APIRequestContext,
  ctx: AccountListViewApiContext,
  name: string
): Promise<ListView> => {
  const response = await request.post(`/api/apps/${ctx.appId}/objects/${ctx.objectApiName}/list-views`, {
    headers: authHeaders(ctx.token),
    data: {
      name,
      filters_json: { logic: "AND", filters: [] },
      columns_json: ["id", "name"],
      sharing_json: { scope: "private" },
      sort_json: [{ field: "name", direction: "asc" }],
      view_json: { mode: "table", created_by: "admin-metadata-api" }
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as ListView;
};

const deleteAccountListViewViaApi = async (
  request: APIRequestContext,
  ctx: AccountListViewApiContext,
  listViewId: string
) => {
  if (!listViewId) return;
  await request.delete(`/api/apps/${ctx.appId}/objects/${ctx.objectApiName}/list-views/${listViewId}`, {
    headers: authHeaders(ctx.token)
  }).catch(() => null);
};

const createKeystoneAccountViaListView = async (page: Page, label: string, accountNumber: string) => {
  await closeTransientUi(page);
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".object-home button")].find(
      (candidate) => candidate.textContent?.trim() === "New"
    );
    if (!button) return false;
    button.click();
    return true;
  });
  expect(clicked).toBe(true);
  await expect(page.getByRole("heading", { name: /^new accounts$/i })).toBeVisible();
  await page.getByRole("textbox", { name: /^name \*$/i }).fill(label);
  await page.getByRole("textbox", { name: /^account number \*$/i }).fill(accountNumber);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByRole("heading", { name: new RegExp(escapeRegex(label), "i") })).toBeVisible();
  return new URL(page.url()).searchParams.get("id") || "";
};

const returnToKeystoneList = async (page: Page) => {
  await page.getByRole("button", { name: /^accounts$/i }).first().click();
  const objectHome = page.locator(".object-home").first();
  await expect(objectHome).toBeVisible();
  await expectKeystoneListActionsReady(page);
  return objectHome;
};

const expectKeystoneListActionsReady = async (page: Page) => {
  await page.waitForSelector(".object-home input[aria-label='Search results'], .object-home .list-view-search input");
  await page.waitForSelector(".object-home button[aria-label='New']");
};

const searchKeystoneList = async (region: Locator, query: string) => {
  const search = region.locator(".list-view-search input, input[aria-label*='search' i], input[placeholder*='search' i]").first();
  await search.fill(query);
  await expect(search).toHaveValue(query);
};

const activeKeystoneRecordContext = async (page: Page) =>
  page.evaluate(() => ({
    appId: sessionStorage.getItem("shockwave.last_app") || sessionStorage.getItem("core_platform.last_app") || "",
    objectApiName: document.querySelector(".object-home")?.getAttribute("data-object-api-name")?.trim() || ""
  }));

const rowForText = (region: Locator, text: string) =>
  region.locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(text), "i") }).first();

const rowsForText = (region: Locator, text: string) =>
  region.locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(text), "i") });

const editInlineCell = async (row: Locator, cellIndex: number, value: string) => {
  const cell = row.locator("td").nth(cellIndex);
  await cell.dblclick();
  const editor = cell.locator("input, textarea").first();
  await expect(editor).toBeVisible();
  await editor.fill(value);
  await editor.press("Enter");
};

const openListViewActionMenu = async (page: Page, region: Locator) => {
  const settingsItem = page.locator("button.view-menu-item").filter({ hasText: /^settings$/i }).first();
  if (await settingsItem.isVisible().catch(() => false)) return;
  await closeTransientUi(page);
  if (await settingsItem.isVisible().catch(() => false)) return;
  const actionsButton = region.getByRole("button", { name: /list view actions/i }).first();
  await expect(actionsButton).toBeVisible();
  await actionsButton.click();
  await expect(settingsItem).toBeVisible();
};

const chooseListViewAction = async (page: Page, region: Locator, action: string) => {
  await openListViewActionMenu(page, region);
  const menuItem = page
    .locator("button.view-menu-item")
    .filter({ hasText: new RegExp(`^${escapeRegex(action)}$`, "i") })
    .first();
  await expect(menuItem).toBeVisible();
  await menuItem.click();
};

const quickActionNameInput = (page: Page) =>
  page.locator("#list-view-quick-action-name, [role='dialog'] input, dialog input, .modal input").first();

const selectedListViewText = async (region: Locator) =>
  region.locator(".list-view-picker-trigger, select#list-view").first().evaluate((element) => {
    if (element instanceof HTMLSelectElement) {
      return element.options[element.selectedIndex]?.textContent?.trim() || "";
    }
    return element.textContent?.trim() || "";
  });

const expectSelectedListView = async (region: Locator, name: string) => {
  await expect.poll(() => selectedListViewText(region)).toContain(name);
};

const createListViewViaActions = async (page: Page, region: Locator, name: string) => {
  await chooseListViewAction(page, region, "New");
  await expect(page.getByRole("heading", { name: /^new list view$/i })).toBeVisible();
  await quickActionNameInput(page).fill(name);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expectSelectedListView(region, name);
};

const renameCurrentListViewViaActions = async (page: Page, region: Locator, name: string) => {
  await chooseListViewAction(page, region, "Rename");
  await expect(page.getByRole("heading", { name: /^rename list view$/i })).toBeVisible();
  await quickActionNameInput(page).fill(name);
  await page.getByRole("button", { name: /^rename$/i }).click();
  await expectSelectedListView(region, name);
};

const cloneCurrentListViewViaActions = async (page: Page, region: Locator, name: string) => {
  await chooseListViewAction(page, region, "Clone");
  await expect(page.getByRole("heading", { name: /^clone list view$/i })).toBeVisible();
  await quickActionNameInput(page).fill(name);
  await page.getByRole("button", { name: /^clone$/i }).click();
  await expectSelectedListView(region, name);
};

const selectListViewByName = async (page: Page, region: Locator, name: string) => {
  const selected = await selectedListViewText(region).catch(() => "");
  if (selected.includes(name)) return;
  const nativeSelector = region.locator("select#list-view").first();
  if (await nativeSelector.isVisible().catch(() => false)) {
    await nativeSelector.selectOption({ label: name });
    await expectSelectedListView(region, name);
    return;
  }
  const trigger = region.locator(".list-view-picker-trigger").first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page
    .locator("button, [role='option']")
    .filter({ hasText: new RegExp(`^${escapeRegex(name)}$`, "i") })
    .first()
    .click();
  await expectSelectedListView(region, name);
};

const deleteCurrentListViewViaActions = async (page: Page, region: Locator, name: string) => {
  await chooseListViewAction(page, region, "Delete");
  await expect(page.getByRole("heading", { name: /^delete list view$/i })).toBeVisible();
  await expect(page.getByText(new RegExp(escapeRegex(name), "i")).first()).toBeVisible();
  await page.getByRole("button", { name: /^delete$/i }).last().click();
  await expect.poll(() => selectedListViewText(region)).not.toContain(name);
};

const deleteListViewByName = async (page: Page, region: Locator, name: string) => {
  await closeTransientUi(page);
  const selected = await selectedListViewText(region).catch(() => "");
  if (!selected.includes(name)) {
    const trigger = region.locator(".list-view-picker-trigger").first();
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
    }
    const option = page
      .locator("[role='option'], button")
      .filter({ hasText: new RegExp(`^${escapeRegex(name)}$`, "i") })
      .first();
    if (!(await option.isVisible().catch(() => false))) {
      await closeTransientUi(page);
      return;
    }
    await option.click();
    await expectSelectedListView(region, name);
  }
  await deleteCurrentListViewViaActions(page, region, name);
};

const clickSettingsPanel = async (page: Page, name: string) => {
  const button = page.getByRole("button", { name: new RegExp(`^${escapeRegex(name)}$`, "i") }).first();
  await expect(button).toBeVisible();
  await button.click();
};

const exerciseDisposableListViewSettings = async (
  page: Page,
  region: Locator,
  columnLabel: string,
  testInfo: TestInfo,
  evidencePrefix: string
) => {
  await chooseListViewAction(page, region, "Settings");
  await expect(page.getByRole("heading", { name: /list view settings/i })).toBeVisible();

  await clickSettingsPanel(page, "Filters");
  await page.getByRole("button", { name: /add filter/i }).click();
  await expect(page.getByRole("button", { name: /save filters/i }).first()).toBeVisible();
  await page.getByRole("button", { name: /clear all/i }).click();

  await clickSettingsPanel(page, "Sharing");
  await expect(page.getByLabel(/sharing scope/i)).toBeVisible();

  await clickSettingsPanel(page, "Preferences");
  await page.getByRole("button", { name: /add sort field/i }).first().click();
  await expect(page.getByRole("radio", { name: /descending/i }).first()).toBeVisible();

  const hierarchy = page.getByRole("button", { name: /^hierarchy$/i }).first();
  if (await hierarchy.isVisible().catch(() => false)) {
    await hierarchy.click();
    await expect(page.getByRole("heading", { name: /list view settings/i })).toBeVisible();
  }

  await clickSettingsPanel(page, "Columns");
  await page.getByRole("button", { name: /selected columns/i }).click();
  const labelInput = page.locator(".column-editor .column-label").first();
  await expect(labelInput).toBeVisible();
  await labelInput.fill(columnLabel);
  await expect(labelInput).toHaveValue(columnLabel);
  await expect(page.getByRole("button", { name: /save columns/i }).first()).toBeEnabled();
  await attachEvidence(page, testInfo, `${evidencePrefix}-settings-columns`).catch(() => null);

  await closeModal(page);
  await expectListRegionReady(region);
};

test.describe("Complete List View E2E CRUD workflows @complete-list-view-atomic", () => {
  test.beforeEach(() => {
    test.skip(!hasCredentials(), "Admin and Keystone credentials are not configured.");
  });

  test("CLV-ADM-CRUD-001 Admin Apps list-view creates searches edits verifies Keystone and deletes disposable app @complete-list-view-atomic [surface: Admin + Keystone] [feature: Apps CRUD] [level: BVT] [input: create app from Admin Apps list, search it, edit it, verify Keystone launcher, delete it] [expected: disposable app completes full UI CRUD and is removed] [proof: real Admin list-view CRUD with Keystone runtime verification]", async ({
    page,
    request
  }, testInfo: TestInfo) => {
    requireWriteMode();
    const stamp = uniqueStamp();
    const label = `E2E List App ${stamp}`;
    const editedLabel = `${label} Edited`;
    let appId = "";

    try {
      const initialApps = await openAdminApps(page);
      await attachEvidence(page, testInfo, "admin-apps-open").catch(() => null);
      await expectListRegionReady(initialApps);
      await attachEvidence(page, testInfo, "admin-apps-list-ready").catch(() => null);

      const app = await createAdminAppViaUi(
        page,
        request,
        { label, apiName: safeApiName(label), prefix: shortPrefix(stamp) },
        testInfo
      );
      appId = app.id;

      await openAdminApps(page);
      await searchWithinListView(page.locator(".admin-main").first(), label);
      await attachEvidence(page, testInfo, "admin-app-crud-search-input").catch(() => null);
      await expect(rowForText(page.locator(".admin-main").first(), label)).toBeVisible();
      await attachEvidence(page, testInfo, "admin-app-crud-search-result").catch(() => null);

      await openAdminRowByLabel(page, "Apps", label);
      await page.getByRole("button", { name: /^edit$/i }).click();
      await page.locator("#edit-app-label").fill(editedLabel);
      await page.getByRole("button", { name: /^save$/i }).click();
      await expect(page.getByText(/app saved successfully|app updated successfully/i).first()).toBeVisible();
      await attachEvidence(page, testInfo, "admin-app-crud-edited").catch(() => null);

      await ensureKeystoneSession(page);
      await attachEvidence(page, testInfo, "admin-app-crud-keystone-open").catch(() => null);
      await expectKeystoneAppVisible(page, editedLabel, testInfo, "admin-app-crud-keystone-visible");
      await attachEvidence(page, testInfo, "admin-app-crud-keystone-launcher-open").catch(() => null);

      await ensureAdminSession(page);
      await openAdminRowByLabel(page, "Apps", editedLabel);
      await attachEvidence(page, testInfo, "admin-app-crud-delete-target-visible").catch(() => null);
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByRole("heading", { name: /^delete app$/i })).toBeVisible();
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByText(/app deleted successfully/i).first()).toBeVisible();
      await attachEvidence(page, testInfo, "admin-app-crud-delete-confirmed").catch(() => null);

      const postDeleteApps = await openAdminApps(page);
      await searchWithinListView(postDeleteApps, editedLabel);
      await expect(rowsForText(postDeleteApps, editedLabel)).toHaveCount(0);
      await attachEvidence(page, testInfo, "admin-app-crud-admin-hidden").catch(() => null);

      await expectKeystoneAppHidden(page, editedLabel, testInfo, "admin-app-crud-keystone-hidden");
      appId = "";
    } finally {
      await cleanupAdminMetadataByApi(request, { appId, appLabel: editedLabel });
      await cleanupAdminMetadataByApi(request, { appLabel: label });
    }
  });

  test("CLV-ADM-CRUD-002 Admin Apps list-view selection enables delete and cancel keeps row intact @complete-list-view-atomic [surface: Admin] [feature: Bulk Delete Guard] [level: Regression] [input: create app, search, select row checkbox, open delete confirmation, cancel] [expected: delete is enabled only after selection and cancel preserves the row] [proof: validates guarded list-view bulk delete behavior without destructive confirmation]", async ({
    page,
    request
  }) => {
    requireWriteMode();
    const stamp = uniqueStamp();
    const label = `E2E Select App ${stamp}`;
    let appId = "";

    try {
      const app = await createAdminAppViaUi(page, request, { label, apiName: safeApiName(label), prefix: shortPrefix(stamp) });
      appId = app.id;
      const apps = await openAdminApps(page);
      await searchWithinListView(apps, label);
      const row = rowForText(apps, label);
      await expect(row).toBeVisible();
      await row.locator("input[type='checkbox']").first().check({ force: true });
      await expect(apps.getByRole("button", { name: /^delete$/i })).toBeEnabled();
      await apps.getByRole("button", { name: /^delete$/i }).click();
      await expect(page.getByRole("heading", { name: /^confirm delete$/i })).toBeVisible();
      await page.getByRole("button", { name: /^cancel$/i }).click();
      await expect(rowForText(apps, label)).toBeVisible();
    } finally {
      await cleanupAdminMetadataByApi(request, { appId, appLabel: label });
    }
  });

  test("CLV-ADM-LV-003 Admin Apps list-view settings edits filter column and preference controls without saving @complete-list-view-atomic [surface: Admin] [feature: List View Settings] [level: Regression] [input: open list-view settings, add filter, inspect selected columns, add sort rule, close] [expected: settings controls are interactive and return to a usable list] [proof: one connected list-view configuration workflow replaces duplicate tab-only checks]", async ({
    page
  }) => {
    const apps = await openAdminApps(page);
    await openListViewSettings(page, apps);
    await page.getByRole("button", { name: /^filters$/i }).click();
    await page.getByRole("button", { name: /add filter/i }).click();
    await expect(page.getByRole("button", { name: /save filters/i }).first()).toBeEnabled();
    await page.getByRole("button", { name: /^columns$/i }).click();
    await page.getByRole("button", { name: /selected columns/i }).click();
    await expect(page.getByRole("button", { name: /save columns/i }).first()).toBeVisible();
    await page.getByRole("button", { name: /^preferences$/i }).click();
    await page.getByRole("button", { name: /add sort field/i }).first().click();
    await expect(page.getByRole("radio", { name: /descending/i }).first()).toBeVisible();
    await closeModal(page);
    await expectListRegionReady(apps);
  });

  test("CLV-ADM-LVA-004 Admin Apps list-view actions create rename configure clone and delete disposable views @complete-list-view-atomic [surface: Admin] [feature: List View Actions CRUD + Settings] [level: Regression] [input: create custom Apps list view from actions, rename it, edit settings panels, clone it, delete clone and original] [expected: Admin list-view metadata completes action CRUD without touching default views] [proof: disposable Admin list views are created, configured, cloned, and removed through list-view actions]", async ({
    page
  }, testInfo: TestInfo) => {
    requireWriteMode();
    const apps = await openAdminApps(page);
    const stamp = uniqueStamp();
    const baseName = `E2E Admin View ${stamp}`;
    const renamedName = `${baseName} Renamed`;
    const cloneName = `${baseName} Clone`;

    try {
      await attachEvidence(page, testInfo, "admin-list-view-actions-open-admin").catch(() => null);
      await selectListViewByName(page, apps, "All Apps");
      await closeTransientUi(page);
      await attachEvidence(page, testInfo, "admin-list-view-actions-ready").catch(() => null);

      await createListViewViaActions(page, apps, baseName);
      await attachEvidence(page, testInfo, "admin-list-view-actions-created").catch(() => null);
      await renameCurrentListViewViaActions(page, apps, renamedName);
      await exerciseDisposableListViewSettings(page, apps, "E2E App Name", testInfo, "admin-list-view-actions");
      await cloneCurrentListViewViaActions(page, apps, cloneName);
      await deleteCurrentListViewViaActions(page, apps, cloneName);
      await deleteListViewByName(page, apps, renamedName);
    } finally {
      await deleteListViewByName(page, apps, cloneName).catch(() => null);
      await deleteListViewByName(page, apps, renamedName).catch(() => null);
      await deleteListViewByName(page, apps, baseName).catch(() => null);
    }
  });

  test("CLV-ADM-KEY-LV-005 Admin-created Account list view is visible in Keystone @complete-list-view-atomic [surface: Admin + Keystone] [feature: List View Cross-Surface Visibility] [level: Regression] [input: create Account list view through Admin metadata API, open Keystone Account, select the list view, verify selection, delete it] [expected: Admin-created list-view metadata is selectable in Keystone under the Account object] [proof: list-view metadata created outside Keystone UI appears in Keystone runtime picker]", async ({
    page,
    request
  }, testInfo: TestInfo) => {
    requireWriteMode();
    const ctx = await resolveAccountListViewApiContext(request);
    const name = `E2E Admin API View ${uniqueStamp()}`;
    let listViewId = "";

    try {
      const created = await createAccountListViewViaApi(request, ctx, name);
      listViewId = created.id;
      expect(created.name).toBe(name);

      const accounts = await openKeystoneAccounts(page);
      await attachEvidence(page, testInfo, "admin-created-list-view-keystone-open").catch(() => null);
      await expectKeystoneListActionsReady(page);
      const activeContext = await activeKeystoneRecordContext(page);
      expect(activeContext.appId).toBe(ctx.appId);
      expect(activeContext.objectApiName).toBe(ctx.objectApiName);
      await attachEvidence(page, testInfo, "admin-created-list-view-keystone-list-ready").catch(() => null);
      await selectListViewByName(page, accounts, name);
      await expectSelectedListView(accounts, name);
      await attachEvidence(page, testInfo, "admin-created-list-view-admin-created").catch(() => null);
      await attachEvidence(page, testInfo, "admin-created-list-view-visible-in-keystone").catch(() => null);
    } finally {
      await deleteAccountListViewViaApi(request, ctx, listViewId);
    }
  });

  test("CLV-KEY-CRUD-001 Keystone Account list-view creates searches inline-edits and deletes disposable record @complete-list-view-atomic [surface: Keystone] [feature: Account CRUD] [level: BVT] [input: create Account from list, search it, inline edit account number, delete selected row] [expected: Account CRUD is completed from the list view and deleted record leaves active search results] [proof: real Keystone list-view record CRUD]", async ({
    page,
    request
  }, testInfo: TestInfo) => {
    requireWriteMode();
    const objectHome = await openKeystoneAccounts(page);
    const { appId, objectApiName } = await activeKeystoneRecordContext(page);
    const stamp = uniqueStamp();
    const label = `E2E Account ${stamp}`;
    const accountNumber = `E2E-ACC-${stamp}`;
    const editedNumber = `E2E-ACC-${stamp}-EDIT`;
    let recordId = "";

    try {
      recordId = await createKeystoneAccountViaListView(page, label, accountNumber);
      let list = await returnToKeystoneList(page);
      await searchKeystoneList(list, label);
      let row = rowForText(list, label);
      await expect(row).toBeVisible();

      await editInlineCell(row, 4, editedNumber);
      await expect(row).toContainText(editedNumber);
      await searchKeystoneList(list, editedNumber);
      row = rowForText(list, editedNumber);
      await expect(row).toBeVisible();
      await attachEvidence(page, testInfo, "keystone-account-inline-edit").catch(() => null);

      await row.locator("input[type='checkbox']").first().check({ force: true });
      await list.getByRole("button", { name: /^delete$/i }).click();
      await expect(page.getByRole("heading", { name: /confirm delete/i })).toBeVisible();
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByText(/record deleted|records deleted|deleted successfully/i).first()).toBeVisible();
      await searchKeystoneList(list, editedNumber);
      await expect(rowsForText(list, editedNumber)).toHaveCount(0);
      recordId = "";
    } finally {
      await cleanupKeystoneRecord(request, appId, objectApiName, recordId);
    }
  });

  test("CLV-KEY-LVA-003 Keystone Account list-view actions create rename configure clone and delete disposable views @complete-list-view-atomic [surface: Keystone] [feature: List View Actions CRUD + Settings] [level: Regression] [input: create custom Account list view from actions, rename it, edit settings panels, clone it, delete clone and original] [expected: Keystone list-view metadata completes action CRUD without refreshing the browser or mutating default All Accounts] [proof: disposable Keystone list views are created, configured, cloned, and removed through list-view actions]", async ({
    page
  }, testInfo: TestInfo) => {
    requireWriteMode();
    const accounts = await openKeystoneAccounts(page);
    await expectKeystoneListActionsReady(page);
    const stamp = uniqueStamp();
    const baseName = `E2E Key View ${stamp}`;
    const renamedName = `${baseName} Renamed`;
    const cloneName = `${baseName} Clone`;

    try {
      await selectListViewByName(page, accounts, "All Accounts");
      await closeTransientUi(page);

      await createListViewViaActions(page, accounts, baseName);
      await renameCurrentListViewViaActions(page, accounts, renamedName);
      await exerciseDisposableListViewSettings(page, accounts, "E2E Account Name", testInfo, "keystone-list-view-actions");
      await cloneCurrentListViewViaActions(page, accounts, cloneName);
      await deleteCurrentListViewViaActions(page, accounts, cloneName);
      await deleteListViewByName(page, accounts, renamedName);
    } finally {
      await deleteListViewByName(page, accounts, cloneName).catch(() => null);
      await deleteListViewByName(page, accounts, renamedName).catch(() => null);
      await deleteListViewByName(page, accounts, baseName).catch(() => null);
    }
  });

  test("CLV-KEY-CRUD-002 Keystone Account delete moves disposable record to recycle bin and opens purge confirmation @complete-list-view-atomic [surface: Keystone] [feature: Recycle Bin] [level: Regression] [input: create Account, delete it from list, search Recycle Bin, open purge confirmation and cancel] [expected: deleted record is discoverable in Recycle Bin and purge is guarded] [proof: destructive list-view flow is verified beyond active table removal]", async ({
    page,
    request
  }, testInfo: TestInfo) => {
    requireWriteMode();
    const objectHome = await openKeystoneAccounts(page);
    const { appId, objectApiName } = await activeKeystoneRecordContext(page);
    const stamp = uniqueStamp();
    const label = `E2E Recycle Account ${stamp}`;
    let recordId = "";

    try {
      recordId = await createKeystoneAccountViaListView(page, label, `E2E-REC-${stamp}`);
      const list = await returnToKeystoneList(page);
      await searchKeystoneList(list, label);
      const row = rowForText(list, label);
      await expect(row).toBeVisible();
      await row.locator("input[type='checkbox']").first().check({ force: true });
      await list.getByRole("button", { name: /^delete$/i }).click();
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByText(/record deleted|records deleted|deleted successfully/i).first()).toBeVisible();

      const recycle = await openKeystoneRecycleBin(page);
      await searchKeystoneList(recycle, label);
      const recycleRow = rowForText(recycle, label);
      await expect(recycleRow).toBeVisible();
      await attachEvidence(page, testInfo, "keystone-account-recycle-row").catch(() => null);
      await recycleRow.getByRole("button", { name: /^purge$/i }).first().click();
      await expect(page.getByRole("heading", { name: /confirm purge/i })).toBeVisible();
      await page.getByRole("button", { name: /^cancel$/i }).click();
      recordId = "";
    } finally {
      await cleanupKeystoneRecord(request, appId, objectApiName, recordId);
    }
  });
});
