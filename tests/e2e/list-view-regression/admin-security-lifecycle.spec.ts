import { expect, test, type APIRequestContext, type Page } from "../helpers/singleBrowserTest";
import { allowWrites, apiLogin, attachEvidence, authHeaders, hasCredentials, loginToAdmin } from "./helpers";
import {
  cleanupAdminMetadataByApi,
  createAdminAppViaUi,
  openAdminListScreen,
  openAdminRowByLabel,
  safeApiName,
  selectOptionContainingText,
  shortPrefix,
  uniqueStamp
} from "./page-flow-helpers";

type RoleOrGroup = { id: string; name?: string; app_id?: string };

const deleteRoleOrGroupByName = async (
  request: APIRequestContext,
  type: "roles" | "groups",
  appId: string,
  names: string[]
) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);
  const response = await request.get(`/admin/${type}?app_id=${encodeURIComponent(appId)}`, { headers });
  if (!response.ok()) return;
  const items = ((await response.json()) as { items?: RoleOrGroup[] }).items ?? [];
  for (const name of names) {
    const item = items.find((candidate) => String(candidate.name ?? "").trim() === name);
    if (item?.id) {
      await request.delete(`/admin/${type}/${item.id}`, { headers }).catch(() => null);
    }
  }
};

const createRoleViaUi = async (page: Page, appLabel: string, name: string, description: string) => {
  const roles = await openAdminListScreen(page, "Roles");
  await roles.getByRole("button", { name: /^new$/i }).click();
  await expect(page.getByRole("heading", { name: /^new role$/i })).toBeVisible();
  const appSelect = page.locator("#create-role-app");
  if (await appSelect.isVisible().catch(() => false)) {
    await selectOptionContainingText(appSelect, appLabel);
  }
  await page.locator("#create-role-name").fill(name);
  await page.locator("#create-role-desc").fill(description);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/role created successfully/i).first()).toBeVisible({ timeout: 20_000 });
};

const createGroupViaUi = async (page: Page, appLabel: string, name: string, description: string) => {
  const groups = await openAdminListScreen(page, "Groups");
  await groups.getByRole("button", { name: /^new$/i }).click();
  await expect(page.getByRole("heading", { name: /^new group$/i })).toBeVisible();
  const appSelect = page.locator("#create-group-app");
  if (await appSelect.isVisible().catch(() => false)) {
    await selectOptionContainingText(appSelect, appLabel);
  }
  await page.locator("#create-group-name").fill(name);
  await page.locator("#create-group-desc").fill(description);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/group created successfully/i).first()).toBeVisible({ timeout: 20_000 });
};

test.describe("Admin security lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Write-enabled security lifecycle coverage is disabled.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "security-lifecycle-final-evidence").catch(() => null);
    }
  });

  test("Admin Roles and Groups lifecycle creates edits verifies searches and deletes scoped security principals @security-lifecycle @permissions-ui @admin-page:Roles @admin-page:Groups [surface: Admin] [feature: Security principal lifecycle] [precondition: ALLOW_DATA_WRITE=true and admin user can manage roles and groups] [input: open Admin Apps -> create disposable app -> open Roles -> create app-scoped role -> search and open role -> edit role -> save -> open Groups -> create app-scoped group -> search and open group -> edit group -> save -> delete both principals -> delete/purge app cleanup] [expected: role and group security principals are created, editable, searchable, and removable without stale access records] [proof: security UI lifecycle is separated from list-view-only tests and validates the real Roles/Groups pages]", async ({
    page,
    request
  }, testInfo) => {
    const stamp = uniqueStamp();
    const appLabel = `E2E Security App ${stamp}`;
    const roleName = `E2E Role ${stamp}`;
    const editedRoleName = `${roleName} Edited`;
    const groupName = `E2E Group ${stamp}`;
    const editedGroupName = `${groupName} Edited`;
    let appId = "";

    try {
      const app = await createAdminAppViaUi(
        page,
        request,
        {
          label: appLabel,
          apiName: safeApiName(appLabel),
          prefix: shortPrefix(`s${stamp}`)
        },
        testInfo
      );
      appId = app.id;

      await createRoleViaUi(page, app.label, roleName, "Disposable role for security lifecycle testing.");
      await attachEvidence(page, testInfo, "admin-role-after-create");
      await openAdminRowByLabel(page, "Roles", roleName);
      await page.getByRole("button", { name: /^edit$/i }).click();
      await expect(page.getByRole("heading", { name: /^edit role$/i })).toBeVisible();
      await page.locator("#edit-role-name").fill(editedRoleName);
      await page.locator("#edit-role-desc").fill("Edited disposable role for security lifecycle testing.");
      await page.getByRole("button", { name: /^save$/i }).click();
      await expect(page.getByText(/role saved successfully/i).first()).toBeVisible({ timeout: 20_000 });

      await createGroupViaUi(page, app.label, groupName, "Disposable group for security lifecycle testing.");
      await attachEvidence(page, testInfo, "admin-group-after-create");
      await openAdminRowByLabel(page, "Groups", groupName);
      await page.getByRole("button", { name: /^edit$/i }).click();
      await expect(page.getByRole("heading", { name: /^edit group$/i })).toBeVisible();
      await page.locator("#edit-group-name").fill(editedGroupName);
      await page.locator("#edit-group-desc").fill("Edited disposable group for security lifecycle testing.");
      await page.getByRole("button", { name: /^save$/i }).click();
      await expect(page.getByText(/group saved successfully/i).first()).toBeVisible({ timeout: 20_000 });

      await openAdminRowByLabel(page, "Roles", editedRoleName);
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByRole("heading", { name: /^delete role$/i })).toBeVisible();
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByText(/role deleted successfully/i).first()).toBeVisible({ timeout: 20_000 });

      await openAdminRowByLabel(page, "Groups", editedGroupName);
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByRole("heading", { name: /^delete group$/i })).toBeVisible();
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(page.getByText(/group deleted successfully/i).first()).toBeVisible({ timeout: 20_000 });
    } finally {
      if (appId) {
        await deleteRoleOrGroupByName(request, "roles", appId, [roleName, editedRoleName]);
        await deleteRoleOrGroupByName(request, "groups", appId, [groupName, editedGroupName]);
      }
      await cleanupAdminMetadataByApi(request, {
        appId,
        appLabel
      });
    }
  });
});
