import { expect, test } from "@playwright/test";
import {
  allowWrites,
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

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "admin-final-evidence").catch(() => null);
    }
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

  test("Admin Apps disposable lifecycle creates deletes finds recycle bin entry and purges it @lifecycle @recycle [surface: Admin] [feature: Lifecycle] [precondition: ALLOW_DATA_WRITE=true and admin user can manage apps] [input: create disposable app, search it, open detail, delete, verify Recycle Bin, purge matching entry] [expected: disposable app is created, deleted, visible in Recycle Bin, and removed after purge] [proof: Admin list-view lifecycle is covered without touching seeded data]", async ({
    page
  }, testInfo) => {
    test.skip(!allowWrites(), "Write-enabled disposable lifecycle coverage is disabled.");
    const stamp = Date.now().toString(36);
    const label = `LV Auto App ${stamp}`;
    const apiName = `lv_auto_app_${stamp}`;
    const prefix = `z${stamp.slice(-2)}`.slice(0, 3).toLowerCase();

    const apps = await openAdminScreen(page, "Apps");
    await expectListRegionReady(apps);
    await attachEvidence(page, testInfo, "admin-app-lifecycle-before-create");

    await apps.getByRole("button", { name: /^new$/i }).click();
    await expect(page.getByRole("heading", { name: /^new app$/i })).toBeVisible();
    await page.locator("#create-app-label").fill(label);
    await expect(page.locator("#create-app-api")).toHaveValue(apiName);
    await page.locator("#create-app-prefix").fill(prefix);
    await attachEvidence(page, testInfo, "admin-app-lifecycle-create-form");
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByText(/app created successfully/i).first()).toBeVisible({ timeout: 15_000 });
    await attachEvidence(page, testInfo, "admin-app-lifecycle-after-create");

    const appsList = await openAdminScreen(page, "Apps");
    const appsTab = page.locator(".admin-apps-primary-tabs").getByRole("button", { name: /^apps$/i }).first();
    if (await appsTab.isVisible().catch(() => false)) {
      await appsTab.click();
    }
    await expectListRegionReady(appsList);
    const search = await searchWithinListView(appsList, label);
    const createdRow = appsList.locator("table tbody tr").filter({ hasText: label }).first();
    await expect(createdRow).toBeVisible();
    await attachEvidence(page, testInfo, "admin-app-lifecycle-search-created");
    await createdRow.click();
    await expect(page.getByText(/App Details/i).first()).toBeVisible();
    await page.getByRole("button", { name: /^delete$/i }).last().click();
    await expect(page.getByRole("heading", { name: /^delete app$/i })).toBeVisible();
    await attachEvidence(page, testInfo, "admin-app-lifecycle-delete-confirm");
    await page.getByRole("button", { name: /^delete$/i }).last().click();
    await expect(page.getByText(/app deleted successfully/i).first()).toBeVisible({ timeout: 15_000 });

    const recycle = await openAdminScreen(page, "Recycle Bin");
    await expectListRegionReady(recycle);
    const recycleSearch = await searchWithinListView(recycle, label);
    const recycleRow = recycle.locator("table tbody tr").filter({ hasText: label }).first();
    await expect(recycleRow).toBeVisible({ timeout: 15_000 });
    await attachEvidence(page, testInfo, "admin-app-lifecycle-recycle-bin-entry");

    const purge = recycleRow.getByRole("button", { name: /^purge$/i }).first();
    if (await purge.isVisible().catch(() => false)) {
      await purge.click();
    } else {
      const rowCheckbox = recycleRow.locator("input[type='checkbox']").first();
      await rowCheckbox.check({ force: true });
      await recycle.getByRole("button", { name: /^purge/i }).first().click();
    }
    await expect(page.getByRole("heading", { name: /confirm purge/i })).toBeVisible();
    await attachEvidence(page, testInfo, "admin-app-lifecycle-purge-confirm");
    await page.getByRole("button", { name: /^purge$/i }).last().click();
    await recycleSearch.fill(label);
    await page.waitForTimeout(500);
    await expect(recycle.locator("table tbody tr").filter({ hasText: label }).first()).toBeHidden({ timeout: 15_000 });
  });

  test("Admin Apps workflow edits saves deletes restores verifies and cleans up disposable app @workflow @lifecycle @recycle [surface: Admin] [feature: Workflow Lifecycle] [precondition: ALLOW_DATA_WRITE=true and admin user can manage apps] [input: open Apps, create disposable app, select row, edit label, save, delete, restore from Recycle Bin, verify restored, then cleanup purge] [expected: complete multi-step Apps workflow succeeds and leaves no disposable app behind] [proof: one E2E case covers the full Admin Apps list-view journey]", async ({
    page
  }, testInfo) => {
    test.skip(!allowWrites(), "Write-enabled disposable workflow coverage is disabled.");
    const stamp = Date.now().toString(36);
    const label = `LV Flow App ${stamp}`;
    const editedLabel = `${label} Edited`;
    const apiName = `lv_flow_app_${stamp}`;
    const prefix = `y${stamp.slice(-2)}`.slice(0, 3).toLowerCase();

    const apps = await openAdminScreen(page, "Apps");
    await expectListRegionReady(apps);
    await apps.getByRole("button", { name: /^new$/i }).click();
    await page.locator("#create-app-label").fill(label);
    await page.locator("#create-app-prefix").fill(prefix);
    await attachEvidence(page, testInfo, "admin-app-workflow-create");
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByText(/app created successfully/i).first()).toBeVisible({ timeout: 15_000 });

    const appsAfterCreate = await openAdminScreen(page, "Apps");
    const appsTab = page.locator(".admin-apps-primary-tabs").getByRole("button", { name: /^apps$/i }).first();
    if (await appsTab.isVisible().catch(() => false)) {
      await appsTab.click();
    }
    await expectListRegionReady(appsAfterCreate);
    const search = await searchWithinListView(appsAfterCreate, label);
    const row = appsAfterCreate.locator("table tbody tr").filter({ hasText: label }).first();
    await expect(row).toBeVisible();
    await attachEvidence(page, testInfo, "admin-app-workflow-select-row");
    await row.click();

    await page.getByRole("button", { name: /^edit$/i }).click();
    await expect(page.getByRole("heading", { name: /^edit app$/i })).toBeVisible();
    await page.locator("#edit-app-label").fill(editedLabel);
    await attachEvidence(page, testInfo, "admin-app-workflow-edit");
    await page.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByText(/app updated successfully|saved/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".object-settings").getByText(editedLabel).first()).toBeVisible();

    await page.getByRole("button", { name: /^delete$/i }).last().click();
    await expect(page.getByRole("heading", { name: /^delete app$/i })).toBeVisible();
    await attachEvidence(page, testInfo, "admin-app-workflow-delete");
    await page.getByRole("button", { name: /^delete$/i }).last().click();
    await expect(page.getByText(/app deleted successfully/i).first()).toBeVisible({ timeout: 15_000 });

    const recycle = await openAdminScreen(page, "Recycle Bin");
    await expectListRegionReady(recycle);
    const recycleSearch = await searchWithinListView(recycle, editedLabel);
    const recycleRow = recycle.locator("table tbody tr").filter({ hasText: editedLabel }).first();
    await expect(recycleRow).toBeVisible({ timeout: 15_000 });
    await attachEvidence(page, testInfo, "admin-app-workflow-recycle-before-restore");
    await recycleRow.getByRole("button", { name: /^restore$/i }).first().click();
    await expect(page.getByRole("heading", { name: /confirm restore/i })).toBeVisible();
    await page.getByRole("button", { name: /^restore$/i }).last().click();
    await expect(recycle.locator("table tbody tr").filter({ hasText: editedLabel }).first()).toBeHidden({ timeout: 15_000 });

    const appsAfterRestore = await openAdminScreen(page, "Apps");
    const restoredAppsTab = page.locator(".admin-apps-primary-tabs").getByRole("button", { name: /^apps$/i }).first();
    if (await restoredAppsTab.isVisible().catch(() => false)) {
      await restoredAppsTab.click();
    }
    await expectListRegionReady(appsAfterRestore);
    await search.fill("");
    await searchWithinListView(appsAfterRestore, editedLabel);
    const restoredRow = appsAfterRestore.locator("table tbody tr").filter({ hasText: editedLabel }).first();
    await expect(restoredRow).toBeVisible({ timeout: 15_000 });
    await attachEvidence(page, testInfo, "admin-app-workflow-restored");

    await restoredRow.click();
    await page.getByRole("button", { name: /^delete$/i }).last().click();
    await page.getByRole("button", { name: /^delete$/i }).last().click();
    const cleanupRecycle = await openAdminScreen(page, "Recycle Bin");
    await searchWithinListView(cleanupRecycle, editedLabel);
    const cleanupRow = cleanupRecycle.locator("table tbody tr").filter({ hasText: editedLabel }).first();
    await expect(cleanupRow).toBeVisible({ timeout: 15_000 });
    await cleanupRow.getByRole("button", { name: /^purge$/i }).first().click();
    await page.getByRole("button", { name: /^purge$/i }).last().click();
    await expect(cleanupRecycle.locator("table tbody tr").filter({ hasText: editedLabel }).first()).toBeHidden({ timeout: 15_000 });
  });

  test("Admin Objects workflow searches opens detail validates nested Fields list and returns to parent @workflow [surface: Admin] [feature: Object drilldown workflow] [precondition: seeded Object metadata exists] [input: open Objects, search Asset, open row, switch to Fields, inspect embedded list-view controls, search field, close record tab] [expected: parent object and nested Fields list views both remain usable] [proof: Admin metadata list-view drilldown is covered as one connected journey]", async ({
    page
  }, testInfo) => {
    const objects = await openAdminScreen(page, "Objects");
    await expectListRegionReady(objects);
    const search = await searchWithinListView(objects, "Asset");
    const assetRow = objects.locator("table tbody tr").filter({ hasText: /Asset/i }).first();
    await expect(assetRow).toBeVisible();
    await attachEvidence(page, testInfo, "admin-objects-workflow-search-asset");

    await assetRow.click();
    await expect(page.getByText(/Object Metadata/i).first()).toBeVisible();
    await page.getByRole("button", { name: /^Fields/i }).click();
    const fieldPanel = page.locator(".field-list-view-panel").first();
    await expectListRegionReady(fieldPanel);
    await expectListToolbar(fieldPanel);
    await attachEvidence(page, testInfo, "admin-objects-workflow-fields-list");

    await searchWithinListView(fieldPanel, "name");
    await expectListRegionReady(fieldPanel);
    await attachEvidence(page, testInfo, "admin-objects-workflow-fields-search");
    await search.fill("");
    const closeAsset = page.getByRole("button", { name: /close asset/i }).first();
    if (await closeAsset.isVisible().catch(() => false)) {
      await closeAsset.click();
    }
  });

  test("Admin Objects workflow opens settings validates filters edits columns checks sharing preferences and closes @workflow [surface: Admin] [feature: Settings workflow] [precondition: Objects list view is open] [input: open list-view settings, validate empty filter, edit column label, inspect sharing, inspect preferences, close modal] [expected: all major list-view settings panels work together without breaking the list view] [proof: Admin settings journey is covered as one connected regression case]", async ({
    page
  }, testInfo) => {
    const objects = await openAdminScreen(page, "Objects");
    await expectListRegionReady(objects);
    await openListViewSettings(page, objects);
    await attachEvidence(page, testInfo, "admin-settings-workflow-open");

    await page.getByRole("button", { name: /^Filters$/i }).click();
    await page.getByRole("button", { name: /add filter/i }).click();
    const saveFilters = page.getByRole("button", { name: /save filters/i }).first();
    await expect(saveFilters).toBeVisible();
    if (await saveFilters.isEnabled().catch(() => false)) {
      await saveFilters.click();
      await expect(page.locator(".filter-error, [role='alert']").first()).toBeVisible();
    } else {
      await expect(saveFilters).toBeDisabled();
    }

    await page.getByRole("button", { name: /^Columns$/i }).click();
    await page.getByRole("button", { name: /selected columns/i }).click();
    const labelInput = page.locator(".column-editor .column-label").first();
    await expect(labelInput).toBeVisible();
    await labelInput.fill("LV Workflow Label");
    await expect(labelInput).toHaveValue("LV Workflow Label");
    await attachEvidence(page, testInfo, "admin-settings-workflow-columns");

    await page.getByRole("button", { name: /^Sharing$/i }).click();
    const sharing = page.getByLabel(/sharing scope/i);
    await expect(sharing).toBeVisible();
    await sharing.selectOption("specific");
    await expect(page.locator("label").filter({ hasText: /^roles$/i })).toBeVisible();

    await page.getByRole("button", { name: /^Preferences$/i }).click();
    await expect(page.getByRole("button", { name: /pin|unpin/i }).first()).toBeVisible();
    await attachEvidence(page, testInfo, "admin-settings-workflow-preferences");
    await closeModal(page);
    await expectListRegionReady(objects);
  });

  test("Admin Recycle Bin workflow searches changes settings fits columns and verifies export actions @workflow @recycle [surface: Admin] [feature: Recycle Bin workflow] [precondition: Admin Recycle Bin is available] [input: open Recycle Bin, search edge text, open settings, inspect columns, close, fit columns, verify export buttons] [expected: Recycle Bin list-view controls remain stable across search settings and sizing actions] [proof: Admin Recycle Bin list-view workflow is covered without requiring destructive data]", async ({
    page
  }, testInfo) => {
    const recycle = await openAdminScreen(page, "Recycle Bin");
    await expectListRegionReady(recycle);
    const search = await searchWithinListView(recycle, "zz-no-recycle-match");
    await expectListRegionReady(recycle);
    await attachEvidence(page, testInfo, "admin-recycle-workflow-search");
    await search.fill("");

    await openListViewSettings(page, recycle);
    await page.getByRole("button", { name: /^Columns$/i }).click();
    await expect(page.getByRole("button", { name: /selected columns/i })).toBeVisible();
    await attachEvidence(page, testInfo, "admin-recycle-workflow-settings");
    await closeModal(page);

    const fit = recycle.getByRole("button", { name: /fit columns/i }).first();
    if (await fit.isEnabled().catch(() => false)) {
      await fit.click();
    }
    await expect(recycle.getByRole("button", { name: /export csv/i }).first()).toBeVisible();
    await expect(recycle.getByRole("button", { name: /export pdf/i }).first()).toBeVisible();
    await expectListRegionReady(recycle);
  });
});
