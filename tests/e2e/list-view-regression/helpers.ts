import { expect, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  TEST_PASSWORD,
  TEST_USERNAME,
  installSessionMarkerFromCookies,
  maybeSubmitLogin
} from "../helpers/sessionAuth";

export const adminBaseUrl = process.env.ADMIN_BASE_URL || "http://localhost:5002";
export const keystoneBaseUrl =
  process.env.TEST_BASE_URL || process.env.TEST_UI_URL || "http://localhost:5003";
export const serviceBaseUrl = process.env.TEST_API_URL || "http://localhost:5001";

export const hasCredentials = () => Boolean(TEST_USERNAME && TEST_PASSWORD);
export const allowWrites = () => process.env.ALLOW_DATA_WRITE === "true";
let cachedApiToken = "";

const safeName = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const attachEvidence = async (page: Page, testInfo: TestInfo, name: string) => {
  const screenshotPath = testInfo.outputPath(`${safeName(name)}.png`);
  await page.screenshot({ fullPage: true, path: screenshotPath });
  await testInfo.attach(`screenshot-${name}`, {
    path: screenshotPath,
    contentType: "image/png"
  });
};

export const loginToAdmin = async (page: Page) => {
  await installSessionMarkerFromCookies(page, adminBaseUrl, TEST_USERNAME);
  await page.goto(adminBaseUrl, { waitUntil: "domcontentloaded" });
  await maybeSubmitLogin(page, TEST_USERNAME, TEST_PASSWORD, 10_000);
  try {
    await expect(page.locator(".admin-sidebar")).toBeVisible();
    await expect(page.locator(".admin-main")).toBeVisible();
  } catch (error) {
    const authMessage = await page
      .getByText(/too many requests|invalid|failed|unauthorized|error/i)
      .first()
      .innerText({ timeout: 1_000 })
      .catch(() => "");
    throw new Error(
      `Admin authentication did not complete.${authMessage ? ` Auth message: ${authMessage}` : ""} ${
        error instanceof Error ? error.message : ""
      }`.trim()
    );
  }
};

export const loginToKeystone = async (page: Page) => {
  await installSessionMarkerFromCookies(page, keystoneBaseUrl, TEST_USERNAME);
  await page.goto(keystoneBaseUrl, { waitUntil: "domcontentloaded" });
  await maybeSubmitLogin(page, TEST_USERNAME, TEST_PASSWORD, 10_000);
  try {
    await expect(page.getByRole("button", { name: /apps/i })).toBeVisible();
  } catch (error) {
    const authMessage = await page
      .getByText(/too many requests|invalid|failed|unauthorized|error/i)
      .first()
      .innerText({ timeout: 1_000 })
      .catch(() => "");
    throw new Error(
      `Keystone authentication did not complete.${authMessage ? ` Auth message: ${authMessage}` : ""} ${
        error instanceof Error ? error.message : ""
      }`.trim()
    );
  }
  await page.locator('[data-permissions-loaded="true"]').first().waitFor({
    state: "visible",
    timeout: 20_000
  }).catch(() => null);
};

export const apiLogin = async (request: APIRequestContext) => {
  if (cachedApiToken) return cachedApiToken;
  const response = await request.post("/auth/login", {
    data: { username: TEST_USERNAME, password: TEST_PASSWORD }
  });
  const bodyText = await response.text();
  expect(response.ok(), bodyText).toBeTruthy();
  const payload = JSON.parse(bodyText) as { access_token?: string; token?: string };
  const token = payload.access_token ?? payload.token ?? "";
  expect(token).toBeTruthy();
  cachedApiToken = token;
  return token;
};

export const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json"
});

export const openAdminScreen = async (page: Page, label: string) => {
  const nav = page.locator(".admin-sidebar").getByRole("button", { name: label });
  await expect(nav).toBeVisible();
  await nav.click();
  const main = page.locator(".admin-main").first();
  await expect(main).toBeVisible();
  await expect(main).not.toContainText(/something went wrong|uncaught|failed to render/i);
  return main;
};

export const expectListRegionReady = async (region: Locator) => {
  const table = region.getByRole("table").first();
  const empty = region.locator(".empty-state, :text-matches('no records|no results|no data|empty', 'i')").first();
  const error = region.locator(".permission-denied, .error, [role='alert']").first();
  await Promise.race([
    table.waitFor({ state: "visible", timeout: 15_000 }),
    empty.waitFor({ state: "visible", timeout: 15_000 }),
    error.waitFor({ state: "visible", timeout: 15_000 })
  ]);
};

export const expectListToolbar = async (region: Locator) => {
  const toolbar = region.locator(".list-view-toolbar, .list-view-bar").first();
  await expect(toolbar).toBeVisible();
  return toolbar;
};

export const searchWithinListView = async (region: Locator, query: string) => {
  const search = region
    .locator(".list-view-search input, input[aria-label*='search' i], input[placeholder*='search' i]")
    .first();
  await expect(search).toBeVisible();
  await search.fill(query);
  await new Promise((resolve) => setTimeout(resolve, 350));
  return search;
};

export const clickRefresh = async (region: Locator) => {
  const refresh = region.getByRole("button", { name: /refresh list view|refresh/i }).first();
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expectListRegionReady(region);
};

export const ensureTableMode = async (page: Page) => {
  const viewMenuButton = page.getByRole("button", { name: /select view mode/i }).first();
  await expect(viewMenuButton).toBeVisible();
  await viewMenuButton.click();
  await page.getByRole("button", { name: /^table$/i }).click();
  const objectHome = page.locator(".object-home").first();
  await expectListRegionReady(objectHome);
};

export const openListViewSettings = async (page: Page, region?: Locator) => {
  const scope = region ?? page.locator("body");
  const actionsButton = scope.getByRole("button", { name: /list view actions/i }).first();
  await expect(actionsButton).toBeVisible();
  await actionsButton.click();
  const settingsButton = page.getByRole("button", { name: /^settings$/i }).first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(page.getByRole("heading", { name: /list view settings/i })).toBeVisible();
};

export const closeModal = async (page: Page) => {
  const close = page.getByRole("button", { name: /^close$|^cancel$|^done$/i }).first();
  if (await close.isVisible().catch(() => false)) {
    await close.click();
    return;
  }
  await page.keyboard.press("Escape").catch(() => null);
};

const selectLauncherItem = async (panel: Locator, preferredLabels: string[]) => {
  const items = panel.locator(".launcher-list .launcher-item");
  await expect(items.first()).toBeVisible();
  for (const label of preferredLabels) {
    const item = items.filter({ hasText: new RegExp(escapeRegex(label), "i") }).first();
    if (await item.isVisible().catch(() => false)) {
      const selectedLabel = ((await item.textContent()) ?? "").trim();
      await item.click();
      return selectedLabel || label;
    }
  }
  const selectedLabel = ((await items.first().textContent()) ?? "").trim();
  await items.first().click();
  return selectedLabel;
};

export const selectKeystoneAppAndTab = async (
  page: Page,
  preferredApps: string[] = ["Operations Hub", "CRM", "LIMS", "HR", "Core Platform"],
  preferredTabs: string[] = ["Asset", "Account", "Vendor", "Site", "Project", "Sample", "Contact"]
) => {
  const appsButton = page.getByRole("button", { name: /apps/i });
  await expect(appsButton).toBeVisible();
  await appsButton.click();
  const appsPanel = page.locator(".launcher:not(.tabs-picker) .launcher-panel");
  await expect(appsPanel).toBeVisible();
  const appLabel = await selectLauncherItem(appsPanel, preferredApps);

  const tabsButton = page.getByRole("button", { name: /tabs/i });
  await expect(tabsButton).toBeVisible();
  await tabsButton.click();
  const tabsPanel = page.locator(".launcher.tabs-picker .launcher-panel");
  await expect(tabsPanel).toBeVisible();
  const tabLabel = await selectLauncherItem(tabsPanel, preferredTabs);

  const objectHome = page.locator(".object-home").first();
  await expect(objectHome).toBeVisible();
  await expectListRegionReady(objectHome);
  return { appLabel, tabLabel, objectHome };
};

export const activeListViewContext = async (page: Page) => {
  const appId = await page.evaluate(
    () => sessionStorage.getItem("shockwave.last_app") || sessionStorage.getItem("core_platform.last_app") || ""
  );
  const objectApiName =
    (await page.locator(".object-home").first().getAttribute("data-object-api-name"))?.trim() || "";
  const listViewId = await page.locator("select#list-view").first().inputValue().catch(() => "");
  return { appId, objectApiName, listViewId };
};

export const ensureRecordExistsViaUiContext = async (page: Page, request: APIRequestContext) => {
  const rows = page.locator(".object-home table tbody tr");
  if ((await rows.count()) > 0) return;

  await createDisposableRecordViaUiContext(page, request);
  await clickRefresh(page.locator(".object-home").first());
  await expect(page.locator(".object-home table tbody tr").first()).toBeVisible();
};

export const createDisposableRecordViaUiContext = async (page: Page, request: APIRequestContext) => {
  const token = await apiLogin(request);
  const { appId, objectApiName, listViewId } = await activeListViewContext(page);
  if (!appId || !objectApiName) {
    throw new Error("Cannot create regression record without active app/object context.");
  }
  if (listViewId) {
    await request.patch(`/api/apps/${appId}/objects/${objectApiName}/list-views/${listViewId}`, {
      headers: authHeaders(token),
      data: { filters_json: { logic: "AND", filters: [] } }
    });
  }
  const describeRes = await request.get(`/api/apps/${appId}/objects/${objectApiName}/describe`, {
    headers: authHeaders(token)
  });
  expect(describeRes.ok(), await describeRes.text()).toBeTruthy();
  const describe = (await describeRes.json()) as {
    object?: { key_fields?: string[] };
    fields?: Array<{ api_name: string; type?: string; required?: boolean | null; read_only?: boolean | null }>;
  };
  const label = `LV Regression ${Date.now()}`;
  const payload: Record<string, unknown> = { name: label };
  const reserved = new Set(["id", "created_by", "created_at", "modified_by", "modified_at"]);
  const keyField = (describe.object?.key_fields ?? []).find((field) => field && !reserved.has(field));
  if (keyField && keyField !== "name") {
    payload[keyField] = label;
  }
  let assignedDisplayField = Boolean(keyField);
  for (const field of describe.fields ?? []) {
    if (reserved.has(field.api_name) || field.read_only || payload[field.api_name] !== undefined) continue;
    if (!field.required) continue;
    const type = String(field.type ?? "").toLowerCase();
    if (type.includes("number") || type.includes("decimal") || type.includes("integer")) {
      payload[field.api_name] = 1;
    } else if (type.includes("bool")) {
      payload[field.api_name] = true;
    } else if (type.includes("date") && !type.includes("time")) {
      payload[field.api_name] = new Date().toISOString().slice(0, 10);
    } else if (type.includes("date") || type.includes("time")) {
      payload[field.api_name] = new Date().toISOString();
    } else {
      payload[field.api_name] = assignedDisplayField ? `LV ${field.api_name}` : label;
      assignedDisplayField = true;
    }
  }
  const createRes = await request.post(`/api/apps/${appId}/objects/${objectApiName}/records`, {
    headers: authHeaders(token),
    data: payload
  });
  expect(createRes.ok(), await createRes.text()).toBeTruthy();
  const created = (await createRes.json().catch(() => ({}))) as { id?: string; record?: { id?: string } };
  return {
    appId,
    objectApiName,
    label,
    recordId: created.id ?? created.record?.id ?? ""
  };
};

export const openKeystoneRecycleBin = async (page: Page) => {
  const userMenu = page.locator(".user-menu-trigger").first();
  if (await userMenu.isVisible().catch(() => false)) {
    await userMenu.click();
  } else {
    await page.locator("header button").last().click();
  }
  await page.getByRole("button", { name: /^recycle bin$/i }).click();
  const recycle = page.locator(".object-home, .recycle-bin-panel, .shockwave-recycle-bin-panel").first();
  await expect(recycle).toBeVisible();
  await expectListRegionReady(recycle);
  return recycle;
};
