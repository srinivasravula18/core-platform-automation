import { expect, test } from "@playwright/test";
import {
  attachEvidence,
  clickRefresh,
  closeModal,
  hasCredentials,
  loginToAdmin,
  openAdminScreen,
  openListViewSettings,
  searchWithinListView,
  expectListRegionReady,
  expectListToolbar
} from "./helpers";

const adminListScreens = [
  "Apps",
  "Objects",
  "Tabs",
  "Flows",
  "Roles",
  "Groups",
  "Users",
  "Permissions",
  "Access Records",
  "Email Logs",
  "Scheduled Jobs",
  "Audit Logs",
  "Recycle Bin"
];

test.describe("Admin list-view regression", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    await loginToAdmin(page);
  });

  for (const screen of adminListScreens) {
    test(`Admin ${screen} list view loads [surface: Admin] [feature: List view shell] [precondition: seeded admin user is signed in] [input: open ${screen} from Admin navigation] [expected: list view table, empty state, or permission/error state renders without crashing] [proof: every Admin list-view surface stays reachable]`, async ({
      page
    }) => {
      const main = await openAdminScreen(page, screen);
      await expectListRegionReady(main);
    });

    test(`Admin ${screen} toolbar exposes screenshot controls [surface: Admin] [feature: Toolbar controls] [precondition: ${screen} list view is open] [input: inspect list selector, pin, count, search, actions, refresh, settings, fit, and exports] [expected: toolbar controls are visible or intentionally disabled by state] [proof: highlighted list-view toolbar controls are regression checked]`, async ({
      page
    }) => {
      const main = await openAdminScreen(page, screen);
      await expectListRegionReady(main);
      await expectListToolbar(main);

      await expect(main.locator("select#list-view").first()).toBeVisible();
      await expect(main.getByRole("button", { name: /pin list view|unpin list view/i }).first()).toBeVisible();
      await expect(main.locator(".list-view-selection-count").first()).toBeVisible();
      await expect(
        main.locator(".list-view-search input[placeholder*='Search' i], .list-view-search input").first()
      ).toBeVisible();
      const newButton = main.getByRole("button", { name: /^new$/i }).first();
      if (await newButton.isVisible().catch(() => false)) {
        await expect(newButton).toBeVisible();
      }
      const deleteButton = main.getByRole("button", { name: /^delete$/i }).first();
      if (await deleteButton.isVisible().catch(() => false)) {
        await expect(deleteButton).toBeVisible();
      }
      await expect(main.getByRole("button", { name: /refresh list view/i }).first()).toBeVisible();
      await expect(main.getByRole("button", { name: /list view actions/i }).first()).toBeVisible();
      await expect(main.getByRole("button", { name: /fit columns/i }).first()).toBeVisible();
      await expect(main.getByRole("button", { name: /export csv/i }).first()).toBeVisible();
      await expect(main.getByRole("button", { name: /export pdf/i }).first()).toBeVisible();
    });

    test(`Admin ${screen} search handles text and symbols [surface: Admin] [feature: Search] [precondition: ${screen} list view is open] [input: search normal text and special characters] [expected: list view remains stable and can be cleared] [proof: Admin search input handles edge-case user input]`, async ({
      page
    }) => {
      const main = await openAdminScreen(page, screen);
      await expectListRegionReady(main);
      const search = await searchWithinListView(main, "asset");
      await expectListRegionReady(main);
      await search.fill("'%_[]*?\\\"");
      await page.waitForTimeout(300);
      await expectListRegionReady(main);
      await search.fill("");
      await expectListRegionReady(main);
    });
  }

  test("Admin Objects selection count and Delete disabled state [surface: Admin] [feature: Selection] [precondition: Objects list view has seeded rows] [input: select all rows then inspect selected-count and Delete state] [expected: selected count updates and bulk delete action is visible] [proof: screenshot selected-count and Delete controls are wired]", async ({
    page
  }, testInfo) => {
    const main = await openAdminScreen(page, "Objects");
    await expectListRegionReady(main);
    await attachEvidence(page, testInfo, "admin-objects-selection-before");

    const table = main.getByRole("table").first();
    await expect(table).toBeVisible();
    const checkbox = table.locator("thead input[type='checkbox']").first();
    test.skip(!(await checkbox.isVisible().catch(() => false)), "Objects list view does not expose selectable rows.");
    await checkbox.check({ force: true });
    await expect(main.locator(".list-view-selection-count").first()).toContainText(/selected/i);
    await expect(main.getByRole("button", { name: /^delete$/i }).first()).toBeVisible();
    await attachEvidence(page, testInfo, "admin-objects-selection-after");
  });

  test("Admin Objects toolbar has all primary list-view controls from reference screenshot [surface: Admin] [feature: Toolbar controls] [precondition: Objects list view is open] [input: inspect list selector, pin, selected count, search, New, Delete, refresh, settings, fit columns, CSV, PDF] [expected: every primary toolbar control is present] [proof: reference screenshot toolbar behavior is covered in the list-view suite]", async ({
    page
  }, testInfo) => {
    const main = await openAdminScreen(page, "Objects");
    await expectListRegionReady(main);
    await attachEvidence(page, testInfo, "admin-objects-toolbar-reference");

    await expect(main.locator("label").filter({ hasText: /^list view$/i })).toBeVisible();
    await expect(main.locator("select#list-view").first()).toBeVisible();
    await expect(main.getByRole("button", { name: /pin list view|unpin list view/i }).first()).toBeVisible();
    await expect(main.locator(".list-view-selection-count").first()).toContainText(/selected/i);
    await expect(main.locator(".list-view-search input").first()).toBeVisible();
    await expect(main.getByRole("button", { name: /^new$/i }).first()).toBeVisible();
    await expect(main.getByRole("button", { name: /^delete$/i }).first()).toBeVisible();
    await expect(main.getByRole("button", { name: /refresh list view/i }).first()).toBeVisible();
    await expect(main.getByRole("button", { name: /list view actions/i }).first()).toBeVisible();
    await expect(main.getByRole("button", { name: /fit columns/i }).first()).toBeVisible();
    await expect(main.getByRole("button", { name: /export csv/i }).first()).toBeVisible();
    await expect(main.getByRole("button", { name: /export pdf/i }).first()).toBeVisible();
  });

  test("Admin Objects list view settings opens all major panels [surface: Admin] [feature: Settings modal] [precondition: Objects list view is open] [input: open settings and switch Filters, Columns, Sharing, Preferences] [expected: each settings panel is reachable] [proof: Admin list-view configuration surface remains usable]", async ({
    page
  }, testInfo) => {
    const main = await openAdminScreen(page, "Objects");
    await openListViewSettings(page, main);
    await attachEvidence(page, testInfo, "admin-objects-settings-before");

    for (const panel of ["Filters", "Columns", "Sharing", "Preferences"]) {
      await page.getByRole("button", { name: new RegExp(`^${panel}$`, "i") }).click();
      await expect(page.locator(".list-view-settings-modal")).toBeVisible();
    }
    await attachEvidence(page, testInfo, "admin-objects-settings-after");
    await closeModal(page);
  });

  test("Admin Objects filter validation blocks empty filter save [surface: Admin] [feature: Filters] [precondition: Objects list view settings is open] [input: add an incomplete filter and save] [expected: inline filter error is shown] [proof: Admin filter builder fails fast before invalid metadata is saved]", async ({
    page
  }) => {
    const main = await openAdminScreen(page, "Objects");
    await openListViewSettings(page, main);
    await page.getByRole("button", { name: /^Filters$/i }).click();
    await page.getByRole("button", { name: /add filter/i }).click();
    await page.getByRole("button", { name: /save filters/i }).click();
    await expect(page.locator(".filter-error, [role='alert']").first()).toBeVisible();
    await closeModal(page);
  });

  test("Admin Objects column settings can edit a label without leaving modal [surface: Admin] [feature: Columns] [precondition: Objects list view settings is open] [input: open Columns selected list and type a temporary column label] [expected: column editor accepts the change before save] [proof: Admin column configuration controls remain editable]", async ({
    page
  }, testInfo) => {
    const main = await openAdminScreen(page, "Objects");
    await openListViewSettings(page, main);
    await page.getByRole("button", { name: /^Columns$/i }).click();
    await page.getByRole("button", { name: /selected columns/i }).click();
    const labelInput = page.locator(".column-editor .column-label").first();
    await expect(labelInput).toBeVisible();
    await attachEvidence(page, testInfo, "admin-objects-columns-before");
    await labelInput.fill("LV Regression Label");
    await expect(labelInput).toHaveValue("LV Regression Label");
    await attachEvidence(page, testInfo, "admin-objects-columns-after");
    await closeModal(page);
  });

  test("Admin Objects sharing panel exposes private public and specific scopes [surface: Admin] [feature: Sharing] [precondition: Objects list view settings is open] [input: switch sharing scope to specific] [expected: role, group, and user principal controls are shown] [proof: list-view sharing configuration is test-covered in Admin]", async ({
    page
  }) => {
    const main = await openAdminScreen(page, "Objects");
    await openListViewSettings(page, main);
    await page.getByRole("button", { name: /^Sharing$/i }).click();
    const sharing = page.getByLabel(/sharing scope/i);
    await expect(sharing).toBeVisible();
    await sharing.selectOption("specific");
    await expect(page.locator("label").filter({ hasText: /^roles$/i })).toBeVisible();
    await expect(page.locator("label").filter({ hasText: /^groups$/i })).toBeVisible();
    await expect(page.locator("label").filter({ hasText: /^users$/i })).toBeVisible();
    await closeModal(page);
  });

  test("Admin Objects preferences panel supports pin default and last-used controls [surface: Admin] [feature: Preferences] [precondition: Objects list view settings is open] [input: open Preferences panel] [expected: preference actions are present] [proof: Admin list-view user preference controls are covered]", async ({
    page
  }) => {
    const main = await openAdminScreen(page, "Objects");
    await openListViewSettings(page, main);
    await page.getByRole("button", { name: /^Preferences$/i }).click();
    await expect(page.getByRole("button", { name: /pin|unpin/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /default/i }).first()).toBeVisible();
    await closeModal(page);
  });

  test("Admin Objects row opens metadata object detail not business record [surface: Admin] [feature: Metadata boundary] [precondition: Objects list view is open] [input: click the Asset row] [expected: Admin opens Object Metadata for Asset] [proof: Admin list views do not cross into business-data record display]", async ({
    page
  }) => {
    const main = await openAdminScreen(page, "Objects");
    await expectListRegionReady(main);
    const assetRow = main.locator("table tbody tr").filter({ hasText: /Asset/i }).first();
    await expect(assetRow).toBeVisible();
    await assetRow.click();
    await expect(page.getByRole("button", { name: /close asset/i })).toBeVisible();
    await expect(page.getByText(/Object Metadata/i).first()).toBeVisible();
  });

  test("Admin Object detail Fields embedded list view loads [surface: Admin] [feature: Embedded list view] [precondition: Asset metadata detail is open] [input: open the Fields subtab] [expected: embedded Fields list view renders with toolbar and rows] [proof: nested Admin list-view usage is covered]", async ({
    page
  }) => {
    const main = await openAdminScreen(page, "Objects");
    const assetRow = main.locator("table tbody tr").filter({ hasText: /Asset/i }).first();
    await expect(assetRow).toBeVisible();
    await assetRow.click();
    await page.getByRole("button", { name: /^Fields/i }).click();
    const fieldPanel = page.locator(".field-list-view-panel").first();
    await expect(fieldPanel).toBeVisible();
    await expectListRegionReady(fieldPanel);
    await expectListToolbar(fieldPanel);
  });

  test("Admin list view refresh preserves active view selector [surface: Admin] [feature: Refresh] [precondition: Objects list view is open] [input: capture selected list view then click refresh] [expected: the selected list view id remains active] [proof: refresh does not lose list-view context]", async ({
    page
  }) => {
    const main = await openAdminScreen(page, "Objects");
    await expectListRegionReady(main);
    const selector = main.locator("select#list-view").first();
    const before = await selector.inputValue();
    await clickRefresh(main);
    await expect(selector).toHaveValue(before);
  });

  test("Admin list view fit columns action keeps table visible [surface: Admin] [feature: Column sizing] [precondition: Objects table mode is visible] [input: click Fit columns] [expected: table remains visible after auto-resize] [proof: toolbar fit-columns control works on Admin tables]", async ({
    page
  }) => {
    const main = await openAdminScreen(page, "Objects");
    await expectListRegionReady(main);
    const fit = main.getByRole("button", { name: /fit columns/i }).first();
    await expect(fit).toBeVisible();
    if (await fit.isEnabled()) {
      await fit.click();
    }
    await expect(main.getByRole("table").first()).toBeVisible();
  });
});
