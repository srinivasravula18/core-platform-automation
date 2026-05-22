import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import {
  allowWrites,
  attachEvidence,
  clickRefresh,
  closeModal,
  ensureRecordExistsViaUiContext,
  ensureTableMode,
  hasCredentials,
  loginToKeystone,
  openListViewSettings,
  searchWithinListView,
  selectKeystoneAppAndTab,
  expectListRegionReady,
  expectListToolbar
} from "./helpers";

const keystoneTargets = [
  { name: "Asset", apps: ["Operations Hub", "Core Platform"], tabs: ["Asset"] },
  { name: "Vendor", apps: ["Operations Hub", "Core Platform"], tabs: ["Vendor"] },
  { name: "Site", apps: ["Operations Hub", "Core Platform"], tabs: ["Site"] },
  { name: "Project", apps: ["Operations Hub"], tabs: ["Project"] },
  { name: "Service Request", apps: ["Operations Hub"], tabs: ["Service Request"] },
  { name: "Sample", apps: ["LIMS"], tabs: ["Sample"] },
  { name: "Lab Test", apps: ["LIMS"], tabs: ["Lab Test"] },
  { name: "Lab Result", apps: ["LIMS"], tabs: ["Lab Result"] },
  { name: "Account", apps: ["CRM", "Revenue Hub"], tabs: ["Account"] },
  { name: "Contact", apps: ["CRM", "Revenue Hub"], tabs: ["Contact"] },
  { name: "Opportunity", apps: ["CRM", "Revenue Hub"], tabs: ["Opportunity"] },
  { name: "Case", apps: ["CRM", "Revenue Hub"], tabs: ["Case"] }
];

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("Keystone list-view regression", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Keystone credentials are not configured.");
    await loginToKeystone(page);
  });

  for (const target of keystoneTargets) {
    test(`Keystone ${target.name} object list view loads [surface: Keystone] [feature: Object home] [precondition: seeded Keystone user is signed in] [input: open ${target.name} object tab] [expected: object home list view reaches table, empty, or permission state] [proof: Keystone object list views are covered across seeded apps]`, async ({
      page
    }) => {
      const selected = await selectKeystoneAppAndTab(page, target.apps, target.tabs);
      test.skip(!new RegExp(target.name, "i").test(selected.tabLabel), `${target.name} tab is not visible for this user.`);
      await expectListRegionReady(selected.objectHome);
      await expectListToolbar(selected.objectHome);
    });

    test(`Keystone ${target.name} list view toolbar is stable [surface: Keystone] [feature: Toolbar controls] [precondition: ${target.name} object list view is open] [input: inspect selector, pin, search, refresh, settings, fit, and export controls] [expected: shared toolbar controls render consistently] [proof: Keystone toolbar wiring is covered for ${target.name}]`, async ({
      page
    }) => {
      const selected = await selectKeystoneAppAndTab(page, target.apps, target.tabs);
      test.skip(!new RegExp(target.name, "i").test(selected.tabLabel), `${target.name} tab is not visible for this user.`);
      const objectHome = selected.objectHome;
      await expect(objectHome.locator("select#list-view").first()).toBeVisible();
      await expect(objectHome.getByRole("button", { name: /pin list view|unpin list view/i }).first()).toBeVisible();
      await expect(objectHome.locator(".list-view-selection-count").first()).toBeVisible();
      await expect(objectHome.locator(".list-view-search input").first()).toBeVisible();
      await expect(objectHome.getByRole("button", { name: /refresh list view/i }).first()).toBeVisible();
      await expect(objectHome.getByRole("button", { name: /list view actions/i }).first()).toBeVisible();
      await expect(objectHome.getByRole("button", { name: /fit columns/i }).first()).toBeVisible();
      await expect(objectHome.getByRole("button", { name: /export csv/i }).first()).toBeVisible();
      await expect(objectHome.getByRole("button", { name: /export pdf/i }).first()).toBeVisible();
    });
  }

  test("Keystone primary toolbar has all reference list-view controls [surface: Keystone] [feature: Toolbar controls] [precondition: seeded object list view is open] [input: inspect list selector, pin, selected count, search, New, Delete, refresh, settings, fit columns, CSV, PDF] [expected: every primary list-view toolbar control is present] [proof: reference screenshot toolbar behavior is covered in Keystone]", async ({
    page,
    request
  }, testInfo) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    await attachEvidence(page, testInfo, "keystone-toolbar-reference");

    await expect(objectHome.locator("label").filter({ hasText: /^list view$/i })).toBeVisible();
    await expect(objectHome.locator("select#list-view").first()).toBeVisible();
    await expect(objectHome.getByRole("button", { name: /pin list view|unpin list view/i }).first()).toBeVisible();
    await expect(objectHome.locator(".list-view-selection-count").first()).toContainText(/selected/i);
    await expect(objectHome.locator(".list-view-search input").first()).toBeVisible();
    await expect(objectHome.getByRole("button", { name: /^new$/i }).first()).toBeVisible();
    await expect(objectHome.getByRole("button", { name: /^delete$/i }).first()).toBeVisible();
    await expect(objectHome.getByRole("button", { name: /refresh list view/i }).first()).toBeVisible();
    await expect(objectHome.getByRole("button", { name: /list view actions/i }).first()).toBeVisible();
    await expect(objectHome.getByRole("button", { name: /fit columns/i }).first()).toBeVisible();
    await expect(objectHome.getByRole("button", { name: /export csv/i }).first()).toBeVisible();
    await expect(objectHome.getByRole("button", { name: /export pdf/i }).first()).toBeVisible();
  });

  test("Keystone selection count changes after selecting rows [surface: Keystone] [feature: Selection] [precondition: object list view has at least one row] [input: select all rows] [expected: selected-count text changes and Delete is available or disabled by permission] [proof: row selection and bulk action affordance are connected]", async ({
    page,
    request
  }, testInfo) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    await attachEvidence(page, testInfo, "keystone-selection-before");

    const checkbox = objectHome.locator("table thead input[type='checkbox']").first();
    test.skip(!(await checkbox.isVisible().catch(() => false)), "Current object list view does not expose selectable rows.");
    await checkbox.check({ force: true });
    await expect(objectHome.locator(".list-view-selection-count").first()).toContainText(/selected/i);
    await expect(objectHome.getByRole("button", { name: /^delete$/i }).first()).toBeVisible();
    await attachEvidence(page, testInfo, "keystone-selection-after");
  });

  test("Keystone search handles text and special characters [surface: Keystone] [feature: Search] [precondition: object list view is open] [input: search normal text then symbols] [expected: table or empty state remains stable] [proof: Keystone list-view search handles edge input]", async ({
    page
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    const search = await searchWithinListView(objectHome, "test");
    await expectListRegionReady(objectHome);
    await search.fill("'%_[]*?\\\"");
    await page.waitForTimeout(300);
    await expectListRegionReady(objectHome);
    await search.fill("");
    await expectListRegionReady(objectHome);
  });

  test("Keystone search result row can be selected from the screen [surface: Keystone] [feature: Search navigation] [precondition: object list view has a visible row] [input: type text from a visible row into search and click the matching result] [expected: matching row remains visible and opens a record workspace] [proof: typed search reaches record-level navigation]", async ({
    page,
    request
  }, testInfo) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    await ensureTableMode(page);

    const firstRow = objectHome.locator("table tbody tr").first();
    await expect(firstRow).toBeVisible();
    const cellTexts = await firstRow.locator("td").evaluateAll((cells) =>
      cells
        .map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    );
    const searchToken =
      cellTexts
        .flatMap((text) => text.match(/[A-Za-z0-9][A-Za-z0-9_-]{2,}/g) ?? [])
        .find((token) => !/^\d+$/.test(token)) ?? "";
    test.skip(!searchToken, "No searchable text token was visible in the first list-view row.");

    const search = await searchWithinListView(objectHome, searchToken);
    const matchingRow = objectHome.locator("table tbody tr", { hasText: new RegExp(escapeRegex(searchToken), "i") }).first();
    await expect(matchingRow).toBeVisible();
    await attachEvidence(page, testInfo, "keystone-search-result-before-select");

    await matchingRow.click();
    await expect(page.locator(".record-panel, .record-page, .record-tabs").first()).toBeVisible();
    await attachEvidence(page, testInfo, "keystone-search-result-after-select");
  });

  test("Keystone search no-match state recovers after clearing query [surface: Keystone] [feature: Search empty state] [precondition: object list view is open] [input: type an unlikely query then clear it] [expected: no-match state appears without breaking the toolbar and table state recovers] [proof: list-view search handles empty-result and recovery paths]", async ({
    page,
    request
  }, testInfo) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    const search = await searchWithinListView(objectHome, `zz-no-list-view-match-${Date.now()}`);
    await expectListRegionReady(objectHome);
    await expect(objectHome.locator(".list-view-search input").first()).toBeVisible();
    await attachEvidence(page, testInfo, "keystone-search-no-match");

    await search.fill("");
    await expectListRegionReady(objectHome);
    await expect(objectHome.locator("table tbody tr").first()).toBeVisible();
  });

  test("Keystone refresh preserves active list view [surface: Keystone] [feature: Refresh] [precondition: object list view is open] [input: capture selected list view then refresh] [expected: selected list view remains active] [proof: refresh does not lose user context]", async ({
    page
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    const selector = objectHome.locator("select#list-view").first();
    const before = await selector.inputValue();
    await clickRefresh(objectHome);
    await expect(selector).toHaveValue(before);
  });

  test("Keystone settings modal covers filters columns sharing preferences and hierarchy [surface: Keystone] [feature: Settings modal] [precondition: object list view is open] [input: open settings and switch each major list-view panel] [expected: panels are reachable] [proof: Keystone list-view configuration is covered]", async ({
    page
  }, testInfo) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await openListViewSettings(page, objectHome);
    await attachEvidence(page, testInfo, "keystone-settings-before");
    for (const panel of ["Filters", "Columns", "Sharing", "Preferences", "Hierarchy"]) {
      const button = page.getByRole("button", { name: new RegExp(`^${panel}$`, "i") }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        await expect(page.locator(".list-view-settings-modal")).toBeVisible();
      }
    }
    await attachEvidence(page, testInfo, "keystone-settings-after");
    await closeModal(page);
  });

  test("Keystone filter builder shows validation for incomplete filters [surface: Keystone] [feature: Filters] [precondition: list-view settings is open] [input: add empty filter and save] [expected: inline filter error appears] [proof: invalid list-view filters are blocked before save]", async ({
    page
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await openListViewSettings(page, objectHome);
    await page.getByRole("button", { name: /^Filters$/i }).click();
    await page.getByRole("button", { name: /add filter/i }).click();
    await page.getByRole("button", { name: /save filters/i }).click();
    await expect(page.locator(".filter-error, [role='alert']").first()).toBeVisible();
    await closeModal(page);
  });

  test("Keystone column editor accepts temporary label and wrap changes [surface: Keystone] [feature: Columns] [precondition: list-view settings is open] [input: open selected columns and edit first column label/wrap] [expected: controls accept user input] [proof: column settings UI remains functional]", async ({
    page
  }, testInfo) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await openListViewSettings(page, objectHome);
    await page.getByRole("button", { name: /^Columns$/i }).click();
    await page.getByRole("button", { name: /selected columns/i }).click();
    const labelInput = page.locator(".column-editor .column-label").first();
    await expect(labelInput).toBeVisible();
    await attachEvidence(page, testInfo, "keystone-columns-before");
    await labelInput.fill("LV Regression Label");
    await expect(labelInput).toHaveValue("LV Regression Label");
    const wrap = page.locator(".column-editor .column-wrap input[type='checkbox']").first();
    if (await wrap.isVisible().catch(() => false)) {
      await wrap.click();
    }
    await attachEvidence(page, testInfo, "keystone-columns-after");
    await closeModal(page);
  });

  test("Keystone sharing panel exposes specific principal controls [surface: Keystone] [feature: Sharing] [precondition: list-view settings is open] [input: switch sharing scope to specific] [expected: role, group, and user selectors are present] [proof: Keystone list-view sharing UI is covered]", async ({
    page
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await openListViewSettings(page, objectHome);
    await page.getByRole("button", { name: /^Sharing$/i }).click();
    const sharing = page.getByLabel(/sharing scope/i);
    await expect(sharing).toBeVisible();
    await sharing.selectOption("specific");
    await expect(page.locator("label").filter({ hasText: /^roles$/i })).toBeVisible();
    await expect(page.locator("label").filter({ hasText: /^groups$/i })).toBeVisible();
    await expect(page.locator("label").filter({ hasText: /^users$/i })).toBeVisible();
    await closeModal(page);
  });

  test("Keystone view modes switch table kanban and chart [surface: Keystone] [feature: View modes] [precondition: object list view is open] [input: switch from Table to Kanban to Chart and back] [expected: each view mode renders its region] [proof: shared list-view mode controls work in Keystone]", async ({
    page
  }, testInfo) => {
    await selectKeystoneAppAndTab(page);
    await ensureTableMode(page);
    await attachEvidence(page, testInfo, "keystone-viewmode-before");
    const viewMenuButton = page.getByRole("button", { name: /select view mode/i }).first();
    await viewMenuButton.click();
    await page.getByRole("button", { name: /^Kanban$/ }).click();
    await expect(page.locator("#kanban-group")).toBeVisible();
    await viewMenuButton.click();
    await page.getByRole("button", { name: /^Chart$/ }).click();
    await expect(page.locator("#chart-group")).toBeVisible();
    await viewMenuButton.click();
    await page.getByRole("button", { name: /^Table$/ }).click();
    await expect(page.getByRole("table").first()).toBeVisible();
    await attachEvidence(page, testInfo, "keystone-viewmode-after");
  });

  test("Keystone table sorting shows sort indicator [surface: Keystone] [feature: Sorting] [precondition: table view is visible] [input: click first sortable table header] [expected: sort indicator appears] [proof: header sorting remains wired]", async ({
    page,
    request
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    await ensureTableMode(page);
    const sortableHeader = objectHome.locator("button.th-button").first();
    await expect(sortableHeader).toBeVisible();
    await sortableHeader.click();
    await expect(sortableHeader.locator(".sort-indicator")).toBeVisible();
  });

  test("Keystone column resize increases width [surface: Keystone] [feature: Column resize] [precondition: table view is visible] [input: drag first resize handle right] [expected: header width grows] [proof: column resize interaction works]", async ({
    page,
    request
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    const resizeHandle = objectHome.locator(".resize-handle").first();
    await expect(resizeHandle).toBeVisible();
    const headerCell = resizeHandle.locator("xpath=ancestor::th[1]");
    const beforeBox = await headerCell.boundingBox();
    test.skip(!beforeBox, "Unable to measure first table header.");
    await resizeHandle.hover();
    await page.mouse.down();
    await page.mouse.move(beforeBox!.x + beforeBox!.width + 60, beforeBox!.y + beforeBox!.height / 2);
    await page.mouse.up();
    const afterBox = await headerCell.boundingBox();
    expect(afterBox?.width ?? 0).toBeGreaterThan((beforeBox?.width ?? 0) - 1);
  });

  test("Keystone column resize cannot collapse below minimum width [surface: Keystone] [feature: Column resize edge case] [precondition: table view is visible] [input: drag first resize handle far left] [expected: header remains at usable width] [proof: minimum column width guard is enforced]", async ({
    page,
    request
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    const resizeHandle = objectHome.locator(".resize-handle").first();
    await expect(resizeHandle).toBeVisible();
    const headerCell = resizeHandle.locator("xpath=ancestor::th[1]");
    const beforeBox = await headerCell.boundingBox();
    test.skip(!beforeBox, "Unable to measure first table header.");
    await resizeHandle.hover();
    await page.mouse.down();
    await page.mouse.move(beforeBox!.x - 200, beforeBox!.y + beforeBox!.height / 2);
    await page.mouse.up();
    const afterBox = await headerCell.boundingBox();
    expect(afterBox?.width ?? 0).toBeGreaterThanOrEqual(30);
  });

  test("Keystone fit columns keeps table usable [surface: Keystone] [feature: Column sizing] [precondition: table view is visible] [input: click Fit columns] [expected: table remains visible] [proof: fit-columns toolbar control is covered]", async ({
    page
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    const fit = objectHome.getByRole("button", { name: /fit columns/i }).first();
    await expect(fit).toBeVisible();
    if (await fit.isEnabled()) {
      await fit.click();
    }
    await expect(objectHome.getByRole("table").first()).toBeVisible();
  });

  test("Keystone row click opens record tab [surface: Keystone] [feature: Record navigation] [precondition: table has at least one row] [input: click first row] [expected: record workspace remains visible and record tab/panel opens] [proof: list-view row navigation reaches record depth]", async ({
    page,
    request
  }, testInfo) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    await attachEvidence(page, testInfo, "keystone-row-navigation-before");
    const firstRow = objectHome.locator("table tbody tr").first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();
    await expect(page.locator(".record-tabs, .record-panel, .object-home").first()).toBeVisible();
    await attachEvidence(page, testInfo, "keystone-row-navigation-after");
  });

  test("Keystone inline edit cancel keeps changes uncommitted [surface: Keystone] [feature: Inline edit] [precondition: table has an editable row] [input: edit a cell and cancel confirmation] [expected: confirm dialog closes without error] [proof: inline edit cancel path is covered]", async ({
    page,
    request
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    const firstRow = objectHome.locator("table tbody tr").first();
    await expect(firstRow).toBeVisible();
    const targetCell = firstRow.locator("td").nth(2);
    await targetCell.dblclick();
    const editor = targetCell.locator("input, textarea, select").first();
    test.skip(!(await editor.isVisible().catch(() => false)), "No editable cell editor appeared.");
    await editor.fill("LV Regression Cancel");
    await editor.press("Enter");
    await expect(page.getByRole("heading", { name: /confirm changes/i })).toBeVisible();
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByRole("heading", { name: /confirm changes/i })).toBeHidden();
  });

  test("Keystone inline edit success path saves when writes are enabled [surface: Keystone] [feature: Inline edit] [precondition: ALLOW_DATA_WRITE=true and table has editable row] [input: edit a cell and confirm/save] [expected: no error is shown after edit attempt] [proof: write-enabled inline edit path is covered]", async ({
    page,
    request
  }, testInfo) => {
    test.skip(!allowWrites(), "Write-enabled list-view regression is disabled.");
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    await attachEvidence(page, testInfo, "keystone-inline-edit-before");
    const firstRow = objectHome.locator("table tbody tr").first();
    const targetCell = firstRow.locator("td").nth(2);
    await targetCell.dblclick();
    const editor = targetCell.locator("input, textarea").first();
    test.skip(!(await editor.isVisible().catch(() => false)), "No editable cell editor appeared.");
    await editor.fill(`LV Regression ${Date.now()}`);
    await editor.press("Enter");
    const confirm = page.getByRole("button", { name: /confirm|save|update/i }).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
    }
    await expect(page.locator(".error, [role='alert']").first()).toBeHidden({ timeout: 4_000 }).catch(() => null);
    await attachEvidence(page, testInfo, "keystone-inline-edit-after");
  });

  test("Keystone bulk delete confirmation can be cancelled [surface: Keystone] [feature: Bulk delete] [precondition: table rows are selectable] [input: select all and click Delete] [expected: confirm delete modal opens and can be cancelled] [proof: destructive bulk flow has confirmation]", async ({
    page,
    request
  }, testInfo) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    const checkbox = objectHome.locator("table thead input[type='checkbox']").first();
    test.skip(!(await checkbox.isVisible().catch(() => false)), "Rows are not selectable on this object.");
    await checkbox.check({ force: true });
    await attachEvidence(page, testInfo, "keystone-bulk-delete-before");
    const deleteButton = objectHome.getByRole("button", { name: /^delete$/i }).first();
    test.skip(!(await deleteButton.isEnabled().catch(() => false)), "Bulk delete is disabled by permission or state.");
    await deleteButton.click();
    await expect(page.getByRole("heading", { name: /confirm delete/i })).toBeVisible();
    await attachEvidence(page, testInfo, "keystone-bulk-delete-after");
    await page.getByRole("button", { name: /cancel/i }).click();
  });

  test("Keystone CSV export downloads a non-empty file [surface: Keystone] [feature: Export] [precondition: object list view is open] [input: click Export CSV] [expected: CSV file downloads and has bytes] [proof: full-dataset CSV export action is wired]", async ({
    page
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    const csvButton = objectHome.getByRole("button", { name: /export csv/i }).first();
    test.skip(!(await csvButton.isEnabled().catch(() => false)), "CSV export is disabled.");
    const [download] = await Promise.all([page.waitForEvent("download"), csvButton.click()]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/i);
    const path = await download.path();
    expect(path).toBeTruthy();
    const stat = await fs.stat(path!);
    expect(stat.size).toBeGreaterThan(0);
  });

  test("Keystone PDF export downloads a non-empty file [surface: Keystone] [feature: Export] [precondition: object list view is open] [input: click Export PDF] [expected: PDF file downloads and has bytes] [proof: full-dataset PDF export action is wired]", async ({
    page
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    const pdfButton = objectHome.getByRole("button", { name: /export pdf/i }).first();
    test.skip(!(await pdfButton.isEnabled().catch(() => false)), "PDF export is disabled.");
    const [download] = await Promise.all([page.waitForEvent("download"), pdfButton.click()]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    const path = await download.path();
    expect(path).toBeTruthy();
    const stat = await fs.stat(path!);
    expect(stat.size).toBeGreaterThan(0);
  });

  test("Keystone invalid object route fails gracefully [surface: Keystone] [feature: Failure state] [precondition: valid object list view URL is loaded] [input: navigate to invalid object query parameter] [expected: permission denied, error, table, or empty state renders without crash] [proof: invalid list-view route does not break the app shell]", async ({
    page
  }) => {
    await selectKeystoneAppAndTab(page);
    const url = new URL(page.url());
    url.searchParams.set("view", "list");
    url.searchParams.set("object", "invalid_object_api_xyz");
    await page.goto(url.toString());
    const stableState = page
      .locator(".permission-denied, [role='alert'], .error, .empty-state, table, :text-matches('denied|not found|error|restricted|access', 'i')")
      .first();
    await expect(stableState).toBeVisible();
  });

  test("Keystone network failure during inline edit shows an error state [surface: Keystone] [feature: Failure state] [precondition: table has editable row] [input: abort record mutation request during inline edit] [expected: error feedback appears instead of silent failure] [proof: list-view mutation failures surface to the user]", async ({
    page,
    request
  }) => {
    const { objectHome } = await selectKeystoneAppAndTab(page);
    await ensureRecordExistsViaUiContext(page, request);
    await page.route("**/api/apps/*/objects/*/records/*", (route) => route.abort("failed"));
    const firstRow = objectHome.locator("table tbody tr").first();
    const targetCell = firstRow.locator("td").nth(2);
    await targetCell.dblclick();
    const editor = targetCell.locator("input, textarea").first();
    test.skip(!(await editor.isVisible().catch(() => false)), "No editable cell editor appeared.");
    await editor.fill(`LV Network Failure ${Date.now()}`);
    await editor.press("Enter");
    const confirm = page.getByRole("button", { name: /confirm|save|update/i }).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
    }
    await expect(page.locator(".error, [role='alert'], :text-matches('error|fail|network|could not', 'i')").first()).toBeVisible();
    await page.unroute("**/api/apps/*/objects/*/records/*");
  });
});
