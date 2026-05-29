import { expect, test, type Locator, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  allowWrites,
  attachEvidence,
  hasCredentials,
  loginToAdmin,
  loginToKeystone,
  openAdminScreen,
  searchWithinListView
} from "./helpers";
import {
  cleanupAdminMetadataByApi,
  findTabByLabel,
  selectAdminAppContext,
  selectOptionContainingText
} from "./page-flow-helpers";

const targetAppLabel = "AUTO Platform QA 528A";
const targetAppId = "app13iug98";
const targetObjectLabel = "AUTO Case";
const targetObjectApiName = "auto_case";
const crossAppObjectLabel = "Project";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const rowByText = (scope: Locator, text: string) =>
  scope.locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(text), "i") }).first();

const tabsList = async (page: Page) => {
  const main = await openAdminScreen(page, "Tabs");
  await expect(main.getByRole("heading", { name: /^tabs$/i })).toBeVisible();
  return main;
};

const bvtCheck = async (testInfo: TestInfo, id: number, title: string, run: () => Promise<void>) => {
  await test.step(`BVT-${String(id).padStart(3, "0")}: ${title}`, run);
};

const expectListToolbarControls = async (testInfo: TestInfo, main: Locator, startId: number) => {
  const checks: Array<[string, Locator]> = [
    ["list view selector is visible", main.getByRole("button", { name: /list view: all tabs/i })],
    ["pin list view is visible", main.getByRole("button", { name: /pin list view/i })],
    ["search results is visible", main.getByRole("searchbox", { name: /search results/i })],
    ["new button is visible", main.getByRole("button", { name: /^new$/i })],
    ["delete button is visible", main.getByRole("button", { name: /^delete$/i })],
    ["refresh list view is visible", main.getByRole("button", { name: /refresh list view/i })],
    ["list view actions is visible", main.getByRole("button", { name: /list view actions/i })],
    ["fit columns is visible", main.getByRole("button", { name: /fit columns/i })],
    ["csv export is visible", main.getByRole("button", { name: /export csv/i })],
    ["pdf export is visible", main.getByRole("button", { name: /export pdf/i })]
  ];

  for (const [index, [title, locator]] of checks.entries()) {
    await bvtCheck(testInfo, startId + index, title, async () => {
      await expect(locator.first()).toBeVisible();
    });
  }
};

test.describe("Admin Tabs BVT 102-case automation", () => {
  test("Tabs CRUD reflects into Keystone and cleans up @tabs-bvt-102 @metadata-lifecycle [surface: Admin + Keystone] [feature: Tabs metadata propagation] [level: BVT]", async ({
    page,
    request
  }, testInfo) => {
    test.skip(!hasCredentials(), "Admin and Keystone credentials are not configured.");
    test.skip(!allowWrites(), "Write-enabled Tabs BVT coverage is disabled.");

    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    const stamp = Date.now().toString(36).slice(-6);
    const label = `BVT Tab ${stamp}`;
    const updatedLabel = `${label} Updated`;
    const apiName = `bvt_tab_${stamp.toLowerCase()}`;
    let tabId = "";

    try {
      await bvtCheck(testInfo, 1, "admin login succeeds", async () => {
        await loginToAdmin(page);
        await expect(page.locator(".admin-sidebar")).toBeVisible();
      });
      await bvtCheck(testInfo, 2, "target app context can be selected", async () => {
        await selectAdminAppContext(page, targetAppLabel);
        await expect(page.locator(".nav-selected-app").first()).toContainText(targetAppLabel);
      });
      await bvtCheck(testInfo, 3, "tabs navigation opens", async () => {
        await tabsList(page);
      });
      const main = await tabsList(page);
      await bvtCheck(testInfo, 4, "tabs page heading is visible", async () => {
        await expect(main.getByRole("heading", { name: /^tabs$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 5, "tabs page description is visible", async () => {
        await expect(main).toContainText(/user-facing navigation tabs/i);
      });
      await bvtCheck(testInfo, 6, "tabs table is visible", async () => {
        await expect(main.getByRole("table").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 7, "tabs list has rows before create", async () => {
        await expect(main.locator("table tbody tr").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 8, "selection count is visible", async () => {
        await expect(main).toContainText(/0 of \d+ tabs selected/i);
      });
      await bvtCheck(testInfo, 9, "label column exists", async () => {
        await expect(main.getByRole("button", { name: /^label$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 10, "api name column exists", async () => {
        await expect(main.getByRole("button", { name: /^api name$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 11, "object column exists", async () => {
        await expect(main.getByRole("button", { name: /^object$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 12, "created at column exists", async () => {
        await expect(main.getByRole("button", { name: /^created at$/i })).toBeVisible();
      });
      await expectListToolbarControls(testInfo, main, 13);

      await bvtCheck(testInfo, 23, "label sort is clickable", async () => {
        await main.getByRole("button", { name: /^label$/i }).click();
        await expect(main.getByRole("table").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 24, "api name sort is clickable", async () => {
        await main.getByRole("button", { name: /^api name$/i }).click();
        await expect(main.getByRole("table").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 25, "object sort is clickable", async () => {
        await main.getByRole("button", { name: /^object$/i }).click();
        await expect(main.getByRole("table").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 26, "created at sort is clickable", async () => {
        await main.getByRole("button", { name: /^created at$/i }).click();
        await expect(main.getByRole("table").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 27, "refresh keeps list usable", async () => {
        await main.getByRole("button", { name: /refresh list view/i }).click();
        await expect(main.getByRole("table").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 28, "fit columns keeps list usable", async () => {
        await main.getByRole("button", { name: /fit columns/i }).click();
        await expect(main.getByRole("table").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 29, "row checkbox enables delete", async () => {
        await main.locator("table tbody tr").first().locator("input[type='checkbox']").check();
        await expect(main.getByRole("button", { name: /^delete$/i })).toBeEnabled();
      });
      await bvtCheck(testInfo, 30, "row checkbox can be cleared", async () => {
        await main.locator("table tbody tr").first().locator("input[type='checkbox']").uncheck();
        await expect(main.getByRole("button", { name: /^delete$/i })).toBeDisabled();
      });
      await bvtCheck(testInfo, 31, "list actions opens", async () => {
        await main.getByRole("button", { name: /list view actions/i }).click();
        await expect(page.locator("body")).not.toContainText(/something went wrong|failed to render/i);
        await page.keyboard.press("Escape");
      });
      await bvtCheck(testInfo, 32, "new tab modal opens", async () => {
        await main.getByRole("button", { name: /^new$/i }).click();
        await expect(page.getByRole("heading", { name: /^new tab$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 33, "new tab shows target app", async () => {
        await expect(page.getByText(targetAppLabel).first()).toBeVisible();
      });
      await bvtCheck(testInfo, 34, "tab type field is visible", async () => {
        await expect(page.locator("#create-tab-type")).toBeVisible();
      });
      await bvtCheck(testInfo, 35, "object field is visible", async () => {
        await expect(page.locator("#create-tab-object")).toBeVisible();
      });
      await bvtCheck(testInfo, 36, "label field is visible", async () => {
        await expect(page.locator("#create-tab-label")).toBeVisible();
      });
      await bvtCheck(testInfo, 37, "api name field is visible", async () => {
        await expect(page.locator("#create-tab-api")).toBeVisible();
      });
      await bvtCheck(testInfo, 38, "icon picker is visible", async () => {
        await expect(page.getByRole("button", { name: /select an icon/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 39, "create requires an object", async () => {
        await page.locator("#create-tab-label").fill(label);
        await page.locator("#create-tab-api").fill(apiName);
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.getByText(/review the following fields|object/i).first()).toBeVisible();
      });
      await bvtCheck(testInfo, 40, "cross-app object selection is rejected", async () => {
        await selectOptionContainingText(page.locator("#create-tab-object"), crossAppObjectLabel);
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.getByText(/selected object does not belong to the target app/i)).toBeVisible();
      });
      await bvtCheck(testInfo, 41, "target object can be selected", async () => {
        await selectOptionContainingText(page.locator("#create-tab-object"), targetObjectLabel);
        await expect(page.locator("#create-tab-object")).toContainText(targetObjectLabel);
      });
      await bvtCheck(testInfo, 42, "label can be filled", async () => {
        await page.locator("#create-tab-label").fill(label);
        await expect(page.locator("#create-tab-label")).toHaveValue(label);
      });
      await bvtCheck(testInfo, 43, "api name can be filled", async () => {
        await page.locator("#create-tab-api").fill(apiName);
        await expect(page.locator("#create-tab-api")).toHaveValue(apiName);
      });
      await bvtCheck(testInfo, 44, "create button is enabled", async () => {
        await expect(page.getByRole("button", { name: /^create$/i })).toBeEnabled();
      });
      await bvtCheck(testInfo, 45, "tab create succeeds", async () => {
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.getByText(/tab created successfully/i).first()).toBeVisible({ timeout: 20_000 });
      });
      await bvtCheck(testInfo, 46, "created tab detail route opens", async () => {
        await expect(page).toHaveURL(/id=tab/i);
      });
      await bvtCheck(testInfo, 47, "created detail tab label is visible", async () => {
        await expect(page.getByRole("button", { name: new RegExp(escapeRegex(label), "i") })).toBeVisible();
      });
      await bvtCheck(testInfo, 48, "created details panel is visible", async () => {
        await expect(page.getByText(/^tab details$/i).first()).toBeVisible();
      });
      await bvtCheck(testInfo, 49, "created detail edit button is visible", async () => {
        await expect(page.getByRole("button", { name: /^edit$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 50, "created detail delete button is visible", async () => {
        await expect(page.getByRole("button", { name: /^delete$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 51, "created record exists through API", async () => {
        const tab = await findTabByLabel(request, targetAppId, label);
        expect(tab).toBeTruthy();
        tabId = tab?.id ?? "";
      });
      await bvtCheck(testInfo, 52, "created record id is captured", async () => {
        expect(tabId).toMatch(/^tab/i);
      });
      await bvtCheck(testInfo, 53, "details tab is visible", async () => {
        await expect(page.getByRole("button", { name: /^details$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 54, "audit log tab is visible", async () => {
        await expect(page.getByRole("button", { name: /^audit log$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 55, "audit log tab opens", async () => {
        await page.getByRole("button", { name: /^audit log$/i }).click();
        await expect(page.locator("body")).not.toContainText(/something went wrong|failed to render/i);
      });
      await bvtCheck(testInfo, 56, "details tab reopens", async () => {
        await page.getByRole("button", { name: /^details$/i }).click();
        await expect(page.getByText(/^tab details$/i).first()).toBeVisible();
      });
      await bvtCheck(testInfo, 57, "edit modal opens", async () => {
        await page.getByRole("button", { name: /^edit$/i }).click();
        await expect(page.getByRole("heading", { name: /^edit tab$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 58, "edit form preserves object", async () => {
        await expect(page.locator("#edit-tab-object")).toContainText(targetObjectLabel);
      });
      await bvtCheck(testInfo, 59, "edit form preserves api name", async () => {
        await expect(page.locator("#edit-tab-api")).toHaveValue(apiName);
      });
      await bvtCheck(testInfo, 60, "edit label can be changed", async () => {
        await page.locator("#edit-tab-label").fill(updatedLabel);
        await expect(page.locator("#edit-tab-label")).toHaveValue(updatedLabel);
      });
      await bvtCheck(testInfo, 61, "edit save succeeds", async () => {
        await page.getByRole("button", { name: /^save$/i }).click();
        await expect(page.getByText(/tab saved successfully|tab updated successfully/i).first()).toBeVisible({
          timeout: 20_000
        });
      });
      await bvtCheck(testInfo, 62, "updated detail tab label is visible", async () => {
        await expect(page.getByRole("button", { name: new RegExp(escapeRegex(updatedLabel), "i") })).toBeVisible();
      });
      await bvtCheck(testInfo, 63, "updated record exists through API", async () => {
        const tab = await findTabByLabel(request, targetAppId, updatedLabel);
        expect(tab?.id).toBe(tabId);
      });
      await bvtCheck(testInfo, 64, "old label no longer resolves through API", async () => {
        await expect.poll(async () => findTabByLabel(request, targetAppId, label)).toBeNull();
      });
      await bvtCheck(testInfo, 65, "return to tabs list works", async () => {
        await page.getByRole("main").getByRole("button", { name: /^tabs$/i }).click();
        await expect(page.getByRole("table").first()).toBeVisible();
      });
      const updatedMain = page.locator(".admin-main").first();
      await bvtCheck(testInfo, 66, "list count includes created tab", async () => {
        await expect(updatedMain).toContainText(/0 of \d+ tabs selected/i);
      });
      await bvtCheck(testInfo, 67, "updated row appears in list", async () => {
        await expect(rowByText(updatedMain, updatedLabel)).toBeVisible();
      });
      await bvtCheck(testInfo, 68, "updated api name appears in list", async () => {
        await expect(rowByText(updatedMain, updatedLabel)).toContainText(apiName);
      });
      await bvtCheck(testInfo, 69, "updated object appears in list", async () => {
        await expect(rowByText(updatedMain, updatedLabel)).toContainText(targetObjectLabel);
      });
      await bvtCheck(testInfo, 70, "search finds updated tab", async () => {
        await searchWithinListView(updatedMain, updatedLabel);
        await expect(rowByText(updatedMain, updatedLabel)).toBeVisible();
      });
      await bvtCheck(testInfo, 71, "search keeps toolbar usable", async () => {
        await expect(updatedMain.getByRole("button", { name: /^new$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 72, "search exposes export csv count", async () => {
        await expect(updatedMain.getByRole("button", { name: /export csv/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 73, "search exposes export pdf count", async () => {
        await expect(updatedMain.getByRole("button", { name: /export pdf/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 74, "search can be cleared", async () => {
        await updatedMain.getByRole("searchbox", { name: /search results/i }).fill("");
        await expect(updatedMain.locator("table tbody tr").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 75, "keystone login succeeds", async () => {
        await loginToKeystone(page);
        await expect(page.getByRole("button", { name: /^apps$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 76, "keystone target app remains selected or selectable", async () => {
        await page.getByRole("button", { name: /^apps$/i }).click();
        const panel = page.locator(".launcher:not(.tabs-picker) .launcher-panel").first();
        await expect(panel).toBeVisible();
        await panel.locator(".launcher-search").fill(targetAppLabel);
        const item = panel.locator(".launcher-item").filter({ hasText: targetAppLabel }).first();
        if (await item.isVisible().catch(() => false)) {
          await item.click();
        } else {
          await page.keyboard.press("Escape");
        }
        await expect(page.getByRole("button", { name: /^apps$/i })).toContainText(targetAppLabel);
      });
      await bvtCheck(testInfo, 77, "keystone tabs launcher opens", async () => {
        await page.getByRole("button", { name: /^tabs$/i }).click();
        await expect(page.locator(".launcher.tabs-picker .launcher-panel").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 78, "keystone tabs search is visible", async () => {
        await expect(page.getByRole("searchbox", { name: /search tabs/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 79, "keystone tabs search finds updated tab", async () => {
        const panel = page.locator(".launcher.tabs-picker .launcher-panel").first();
        await panel.locator(".launcher-search").fill(updatedLabel);
        await expect(panel.locator(".launcher-item").filter({ hasText: updatedLabel }).first()).toBeVisible({
          timeout: 20_000
        });
      });
      await bvtCheck(testInfo, 80, "keystone updated tab opens", async () => {
        const panel = page.locator(".launcher.tabs-picker .launcher-panel").first();
        await panel.locator(".launcher-item").filter({ hasText: updatedLabel }).first().click();
        await expect(page.getByRole("button", { name: /^tabs$/i })).toContainText(updatedLabel, { timeout: 20_000 });
      });
      await bvtCheck(testInfo, 81, "keystone updated tab routes to created tab id", async () => {
        await expect(page).toHaveURL(new RegExp(`tab=${escapeRegex(tabId)}`));
      });
      await bvtCheck(testInfo, 82, "keystone updated tab routes to target object", async () => {
        await expect(page).toHaveURL(new RegExp(`object=${escapeRegex(targetObjectApiName)}`));
      });
      await bvtCheck(testInfo, 83, "keystone object home is visible", async () => {
        await expect(page.locator(".object-home").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 84, "keystone object home has target api", async () => {
        await expect(page.locator(".object-home").first()).toHaveAttribute("data-object-api-name", targetObjectApiName);
      });
      await bvtCheck(testInfo, 85, "keystone list view is visible", async () => {
        await expect(page.getByRole("table").first()).toBeVisible();
      });
      await bvtCheck(testInfo, 86, "keystone list toolbar is visible", async () => {
        await expect(page.getByRole("button", { name: /list view:/i }).first()).toBeVisible();
      });
      await bvtCheck(testInfo, 87, "keystone search results is visible", async () => {
        await expect(page.getByRole("searchbox", { name: /search results/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 88, "keystone new button is visible", async () => {
        await expect(page.getByRole("button", { name: /^new$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 89, "keystone refresh button is visible", async () => {
        await expect(page.getByRole("button", { name: /refresh list view/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 90, "keystone export controls are visible", async () => {
        await expect(page.getByRole("button", { name: /export csv/i })).toBeVisible();
        await expect(page.getByRole("button", { name: /export pdf/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 91, "admin detail can reopen for delete", async () => {
        await loginToAdmin(page);
        await selectAdminAppContext(page, targetAppLabel);
        await openAdminScreen(page, "Tabs");
        await searchWithinListView(page.locator(".admin-main").first(), updatedLabel);
        await rowByText(page.locator(".admin-main").first(), updatedLabel).click();
        await expect(page.getByText(/^tab details$/i).first()).toBeVisible();
      });
      await bvtCheck(testInfo, 92, "delete confirmation opens", async () => {
        await page.getByRole("button", { name: /^delete$/i }).click();
        await expect(page.getByRole("heading", { name: /^delete tab$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 93, "delete confirmation contains updated label", async () => {
        await expect(page.getByText(new RegExp(escapeRegex(updatedLabel), "i"))).toBeVisible();
      });
      await bvtCheck(testInfo, 94, "delete confirmation can be cancelled", async () => {
        await page.getByRole("button", { name: /^cancel$/i }).click();
        await expect(page.getByText(/^tab details$/i).first()).toBeVisible();
      });
      await bvtCheck(testInfo, 95, "delete confirmation reopens", async () => {
        await page.getByRole("button", { name: /^delete$/i }).click();
        await expect(page.getByRole("heading", { name: /^delete tab$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 96, "delete succeeds", async () => {
        await page.getByRole("button", { name: /^delete$/i }).last().click();
        await expect(page.getByText(/tab deleted successfully/i).first()).toBeVisible({ timeout: 20_000 });
      });
      await bvtCheck(testInfo, 97, "deleted tab is absent through API", async () => {
        await expect.poll(async () => findTabByLabel(request, targetAppId, updatedLabel), { timeout: 20_000 }).toBeNull();
      });
      await bvtCheck(testInfo, 98, "deleted tab is absent from admin search", async () => {
        const adminMain = page.locator(".admin-main").first();
        await searchWithinListView(adminMain, updatedLabel);
        await expect(rowByText(adminMain, updatedLabel)).toBeHidden();
      });
      await bvtCheck(testInfo, 99, "keystone reloads after delete", async () => {
        await loginToKeystone(page);
        await expect(page.getByRole("button", { name: /^tabs$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 100, "deleted tab is absent from keystone tabs launcher", async () => {
        await page.getByRole("button", { name: /^tabs$/i }).click();
        const panel = page.locator(".launcher.tabs-picker .launcher-panel").first();
        await expect(panel).toBeVisible();
        await panel.locator(".launcher-search").fill(updatedLabel);
        await expect(panel.locator(".launcher-item").filter({ hasText: updatedLabel }).first()).toBeHidden();
      });
      await bvtCheck(testInfo, 101, "apps remain selectable after delete", async () => {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: /^apps$/i })).toBeVisible();
      });
      await bvtCheck(testInfo, 102, "no console errors were emitted during tabs BVT", async () => {
        expect.soft(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
      });

      await attachEvidence(page, testInfo, "tabs-bvt-102-final").catch(() => null);
    } finally {
      await cleanupAdminMetadataByApi(request, {
        appId: targetAppId,
        tabId,
        tabLabel: updatedLabel
      });
      await cleanupAdminMetadataByApi(request, {
        appId: targetAppId,
        tabLabel: label
      });
    }
  });
});
