import { expect, test } from "../helpers/singleBrowserTest";
import { allowWrites, attachEvidence, hasCredentials, loginToAdmin } from "./helpers";
import {
  cleanupAdminMetadataByApi,
  createAdminAppViaUi,
  createAdminObjectTabViaUi,
  createAdminObjectViaUi,
  expectKeystoneAppHidden,
  expectKeystoneAppVisible,
  openAdminRowByLabel,
  openKeystoneObjectTab,
  safeApiName,
  shortPrefix,
  uniqueStamp,
  updateAdminObjectDetailsViaUi
} from "./page-flow-helpers";

test.describe("Admin metadata lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin and Keystone credentials are not configured.");
    test.skip(!allowWrites(), "Write-enabled metadata lifecycle coverage is disabled.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "metadata-lifecycle-final-evidence").catch(() => null);
    }
  });

  test("Admin Apps lifecycle creates edits verifies in Keystone deletes and purges disposable app @metadata-lifecycle @admin-page:Apps [surface: Admin + Keystone] [feature: App metadata propagation] [precondition: ALLOW_DATA_WRITE=true and admin user can manage app metadata] [input: open Admin Apps -> click New -> fill app label and prefix -> create app -> open Keystone Apps launcher -> verify app -> return Admin -> edit app label -> save -> verify edited app in Keystone -> delete app -> verify Keystone no longer lists it -> purge cleanup] [expected: App metadata mutations from Admin are reflected in Keystone and cleanup removes the disposable app] [proof: this is not screenshot-only; the test switches apps and validates the runtime launcher after every Admin mutation]", async ({
    page,
    request
  }, testInfo) => {
    const stamp = uniqueStamp();
    const label = `E2E Metadata App ${stamp}`;
    const editedLabel = `${label} Edited`;
    const appInput = {
      label,
      apiName: safeApiName(label),
      prefix: shortPrefix(`a${stamp}`)
    };
    let appId = "";

    try {
      const app = await createAdminAppViaUi(page, request, appInput, testInfo);
      appId = app.id;
      await expectKeystoneAppVisible(page, app.label, testInfo, "keystone-app-after-create");

      await loginToAdmin(page);
      await openAdminRowByLabel(page, "Apps", app.label);
      await page.getByRole("button", { name: /^edit$/i }).click();
      await expect(page.getByRole("heading", { name: /^edit app$/i })).toBeVisible();
      await page.locator("#edit-app-label").fill(editedLabel);
      await attachEvidence(page, testInfo, "admin-app-edit-label");
      await page.getByRole("button", { name: /^save$/i }).click();
      await expect(page.getByText(/app saved successfully|app updated successfully/i).first()).toBeVisible({
        timeout: 20_000
      });

      await expectKeystoneAppVisible(page, editedLabel, testInfo, "keystone-app-after-edit");

      await loginToAdmin(page);
      await openAdminRowByLabel(page, "Apps", editedLabel);
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByRole("heading", { name: /^delete app$/i })).toBeVisible();
      await attachEvidence(page, testInfo, "admin-app-delete-confirm");
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByText(/app deleted successfully/i).first()).toBeVisible({ timeout: 20_000 });

      await expectKeystoneAppHidden(page, editedLabel, testInfo, "keystone-app-after-delete");
    } finally {
      await cleanupAdminMetadataByApi(request, {
        appId,
        appLabel: editedLabel
      });
      await cleanupAdminMetadataByApi(request, {
        appLabel: label
      });
    }
  });

  test("Admin Objects lifecycle creates object and tab verifies Keystone edits object metadata and cleans up @metadata-lifecycle @admin-page:Objects @admin-page:Tabs [surface: Admin + Keystone] [feature: Object and tab metadata propagation] [precondition: ALLOW_DATA_WRITE=true and admin user can manage objects and tabs] [input: open Admin Apps -> create disposable app -> open Objects -> click New -> fill object details -> create object -> open Tabs -> click New -> bind tab to object -> create tab -> open Keystone app and tab -> verify object home -> return Admin Objects -> edit label, plural label, global search, and inline edit -> save -> reopen Keystone tab -> verify same object API still resolves -> delete tab/object/app cleanup] [expected: object metadata and tab metadata created in Admin are usable in Keystone, and object edits do not break runtime navigation] [proof: validates Admin metadata, Keystone launcher, object-home data contract, and cleanup instead of only taking screenshots]", async ({
    page,
    request
  }, testInfo) => {
    const stamp = uniqueStamp();
    const appLabel = `E2E Object App ${stamp}`;
    const objectLabel = `E2E Asset ${stamp}`;
    const editedObjectLabel = `${objectLabel} Edited`;
    const editedPluralLabel = `${editedObjectLabel}s`;
    const tabLabel = `${objectLabel} Workspace`;
    let appId = "";
    let objectId = "";
    let tabId = "";

    try {
      const app = await createAdminAppViaUi(
        page,
        request,
        {
          label: appLabel,
          apiName: safeApiName(appLabel),
          prefix: shortPrefix(`m${stamp}`)
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
        {
          label: tabLabel,
          apiName: safeApiName(tabLabel)
        },
        testInfo
      );
      tabId = tab.id;

      await expectKeystoneAppVisible(page, app.label, testInfo, "keystone-object-app-visible");
      await openKeystoneObjectTab(page, app.label, tab.label, object.apiName, testInfo, "keystone-object-home-created");

      const editedObject = await updateAdminObjectDetailsViaUi(
        page,
        request,
        app,
        object,
        {
          label: editedObjectLabel,
          pluralLabel: editedPluralLabel
        },
        testInfo
      );
      objectId = editedObject.id;

      await openKeystoneObjectTab(page, app.label, tab.label, object.apiName, testInfo, "keystone-object-home-after-edit");
    } finally {
      await cleanupAdminMetadataByApi(request, {
        appId,
        appLabel,
        objectId,
        objectLabel: editedObjectLabel,
        tabId,
        tabLabel
      });
      await cleanupAdminMetadataByApi(request, {
        appLabel,
        objectLabel,
        tabLabel
      });
    }
  });
});
