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

let adminSessionReady = false;
let keystoneSessionReady = false;

const visible = async (locator: Locator, timeout = 750) =>
  locator
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);

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
      const app = await createAdminAppViaUi(
        page,
        request,
        { label, apiName: safeApiName(label), prefix: shortPrefix(stamp) },
        testInfo
      );
      appId = app.id;

      await openAdminApps(page);
      await searchWithinListView(page.locator(".admin-main").first(), label);
      await expect(rowForText(page.locator(".admin-main").first(), label)).toBeVisible();

      await openAdminRowByLabel(page, "Apps", label);
      await page.getByRole("button", { name: /^edit$/i }).click();
      await page.locator("#edit-app-label").fill(editedLabel);
      await page.getByRole("button", { name: /^save$/i }).click();
      await expect(page.getByText(/app saved successfully|app updated successfully/i).first()).toBeVisible();
      await attachEvidence(page, testInfo, "admin-app-crud-edited").catch(() => null);

      await expectKeystoneAppVisible(page, editedLabel, testInfo, "admin-app-crud-keystone-visible");

      await ensureAdminSession(page);
      await openAdminRowByLabel(page, "Apps", editedLabel);
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByRole("heading", { name: /^delete app$/i })).toBeVisible();
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByText(/app deleted successfully/i).first()).toBeVisible();

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
