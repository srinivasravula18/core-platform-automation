import { expect, test, type Locator } from "../helpers/singleBrowserTest";
import { allowWrites, attachEvidence, hasCredentials, loginToAdmin } from "./helpers";
import {
  cleanupAdminMetadataByApi,
  createAdminAppViaUi,
  createAdminObjectTabViaUi,
  createAdminObjectViaUi,
  createAdminRoleViaUi,
  deleteAccessRecordById,
  deleteAdminRoleOrGroupByName,
  getAccessRecordById,
  openAdminListScreen,
  openAdminRowByLabel,
  openKeystoneObjectTab,
  safeApiName,
  selectOptionContainingText,
  shortPrefix,
  uniqueStamp,
  waitForAccessRecord
} from "./page-flow-helpers";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const checkObjectAccess = async (panel: Locator, label: string) => {
  await panel.getByRole("checkbox", { name: new RegExp(`^${escapeRegex(label)}\\b`, "i") }).check({ force: true });
};

test.describe("Admin Access Records lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Write-enabled access-record lifecycle coverage is disabled.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "access-records-lifecycle-final-evidence").catch(() => null);
    }
  });

  test("Admin Access Records lifecycle creates grants edits verifies Keystone object access and deletes disposable record @security-lifecycle @access-records-lifecycle @permissions-ui @admin-page:AccessRecords [surface: Admin + Keystone] [feature: Access Records lifecycle] [precondition: ALLOW_DATA_WRITE=true and admin user can manage metadata, roles, and access records] [input: open Admin Apps -> create disposable app -> open Objects -> create object -> open Tabs -> bind object tab -> open Roles -> create scoped role -> open Access Records -> click New -> select object and role -> grant read/create/update/view-all -> create -> open Keystone app and object tab -> return Admin Access Records -> edit object permissions -> save -> delete the access record -> cleanup metadata] [expected: access-record permissions created through Admin UI persist to the backend, the connected Keystone object tab remains reachable, updates are saved, and deleting the access record removes the disposable security record] [proof: validates Admin Access Records page, backend access-record contract, Keystone object runtime navigation, and cleanup in one UI-driven flow]", async ({
    page,
    request
  }, testInfo) => {
    const stamp = uniqueStamp();
    const appLabel = `E2E Access App ${stamp}`;
    const objectLabel = `E2E Access Object ${stamp}`;
    const tabLabel = `E2E Access Tab ${stamp}`;
    const roleName = `E2E Access Role ${stamp}`;
    let appId = "";
    let objectId = "";
    let tabId = "";
    let roleId = "";
    let accessRecordId = "";

    try {
      const app = await createAdminAppViaUi(
        page,
        request,
        {
          label: appLabel,
          apiName: safeApiName(appLabel),
          prefix: shortPrefix(`a${stamp}`)
        },
        testInfo
      );
      appId = app.id;

      const object = await createAdminObjectViaUi(
        page,
        request,
        app,
        {
          label: objectLabel,
          apiName: safeApiName(objectLabel),
          pluralLabel: `${objectLabel}s`,
          prefix: shortPrefix(`o${stamp}`)
        },
        testInfo
      );
      objectId = object.id;

      const tab = await createAdminObjectTabViaUi(
        page,
        request,
        app,
        object,
        { label: tabLabel, apiName: safeApiName(tabLabel) },
        testInfo
      );
      tabId = tab.id;

      const role = await createAdminRoleViaUi(
        page,
        request,
        app,
        { name: roleName, description: "Disposable access-record lifecycle role." },
        testInfo
      );
      roleId = role.id;

      const accessRecords = await openAdminListScreen(page, "Access Records");
      await accessRecords.getByRole("button", { name: /^new$/i }).click();
      await expect(page.getByRole("heading", { name: /^new access record$/i })).toBeVisible();
      const dialog = page.locator("[role='dialog'], .modal").filter({ hasText: /New Access Record/i }).first();
      await selectOptionContainingText(page.locator("#access-record-object"), object.label);
      await page.locator("#access-record-principal-type").selectOption("role");
      await selectOptionContainingText(page.locator("#access-record-principal-id"), role.name);
      const permissionsPanel = dialog.locator(".object-settings").filter({ hasText: /Object Access/i }).first();
      for (const label of ["Read", "Create", "Update", "View All"]) {
        await checkObjectAccess(permissionsPanel, label);
      }
      await attachEvidence(page, testInfo, "admin-access-record-create-form");
      await dialog.getByRole("button", { name: /^create$/i }).click();
      await expect(page.getByText(/Access Record Details/i).first()).toBeVisible({ timeout: 20_000 });
      const created = await waitForAccessRecord(request, {
        objectId,
        principalType: "role",
        principalId: roleId
      });
      accessRecordId = created.id;
      expect(created.permissions_json?.object?.read).toBe(true);
      expect(created.permissions_json?.object?.create).toBe(true);
      expect(created.permissions_json?.object?.update).toBe(true);
      expect(created.permissions_json?.object?.view_all).toBe(true);

      await openKeystoneObjectTab(
        page,
        app.label,
        tab.label,
        object.apiName,
        testInfo,
        "keystone-object-tab-after-access-record-create"
      );

      await loginToAdmin(page);
      await openAdminRowByLabel(page, "Access Records", role.name);
      await expect(page.getByText(/Access Record Details/i).first()).toBeVisible({ timeout: 20_000 });
      const detailsPanel = page.locator(".object-settings").filter({ hasText: /Object Access/i }).first();
      await checkObjectAccess(detailsPanel, "Delete");
      await checkObjectAccess(detailsPanel, "Modify All");
      await page.locator(".object-settings").filter({ hasText: /Access Record Details/i }).first().getByRole("button", { name: /^save$/i }).click();
      await expect
        .poll(async () => (await getAccessRecordById(request, accessRecordId))?.permissions_json?.object?.modify_all, {
          timeout: 20_000
        })
        .toBe(true);

      await page.locator(".object-settings").filter({ hasText: /Access Record Details/i }).first().getByRole("button", { name: /^delete$/i }).click();
      await expect(page.getByRole("heading", { name: /^delete access record$/i })).toBeVisible();
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect.poll(async () => getAccessRecordById(request, accessRecordId), { timeout: 20_000 }).toBeNull();
      accessRecordId = "";
    } finally {
      await deleteAccessRecordById(request, accessRecordId);
      if (appId) {
        await deleteAdminRoleOrGroupByName(request, "roles", appId, [roleName]);
      }
      await cleanupAdminMetadataByApi(request, {
        appId,
        appLabel,
        objectId,
        objectLabel,
        tabId,
        tabLabel
      });
    }
  });
});
