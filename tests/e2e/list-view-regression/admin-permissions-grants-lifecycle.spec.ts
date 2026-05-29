import { expect, test, type Locator, type Page } from "../helpers/singleBrowserTest";
import { allowWrites, attachEvidence, hasCredentials, loginToAdmin, searchWithinListView } from "./helpers";
import {
  cleanupAdminMetadataByApi,
  createAdminAppViaUi,
  createAdminRoleViaUi,
  deleteAdminRoleOrGroupByName,
  deletePermissionGrantById,
  expectKeystoneAppVisible,
  findGrantablePermission,
  listPermissionGrants,
  openAdminListScreen,
  safeApiName,
  selectOptionContainingText,
  shortPrefix,
  uniqueStamp
} from "./page-flow-helpers";

type GrantablePermission = NonNullable<Awaited<ReturnType<typeof findGrantablePermission>>>;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const openPermissionDetailsViaUi = async (page: Page, permission: GrantablePermission) => {
  const main = await openAdminListScreen(page, "Permissions");
  await searchWithinListView(main, `${permission.resource_type} ${permission.action}`).catch(() => null);
  let row: Locator = main
    .locator("table tbody tr")
    .filter({ hasText: new RegExp(escapeRegex(permission.resource_type), "i") })
    .filter({ hasText: new RegExp(escapeRegex(permission.action), "i") })
    .first();
  if (!(await row.isVisible().catch(() => false))) {
    await searchWithinListView(main, permission.action).catch(() => null);
    row = main.locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(permission.action), "i") }).first();
  }
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByText(/Permission Details/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".permission-layout, .object-settings").first()).toContainText(permission.id, {
    timeout: 20_000
  });
};

test.describe("Admin Permissions grant lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Write-enabled permission grant lifecycle coverage is disabled.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "permissions-grants-lifecycle-final-evidence").catch(() => null);
    }
  });

  test("Admin Permissions grant lifecycle adds verifies removes runtime role grant and checks Keystone still resolves the scoped app @security-lifecycle @permission-grants-lifecycle @permissions-ui @admin-page:Permissions [surface: Admin + Keystone] [feature: Permission grant lifecycle] [precondition: ALLOW_DATA_WRITE=true, permission metadata exists, and admin user can manage permission grants] [input: open Admin Apps -> create disposable app -> open Roles -> create scoped role -> open Permissions -> search the grantable permission -> open details -> choose runtime source, role principal, and allow effect -> click Add Grant -> verify the grant row and backend grant -> click Remove -> confirm -> verify backend cleanup -> open Keystone apps launcher and verify the scoped app is still reachable] [expected: permission grants can be created and removed from the Admin Permissions page without polluting permission metadata, and the connected Keystone runtime remains usable after the security change] [proof: validates the real Permissions page grant controls, API grant persistence, grant removal, and Keystone launcher connection instead of screenshot-only coverage]", async ({
    page,
    request
  }, testInfo) => {
    const permission = await findGrantablePermission(request);
    test.skip(!permission, "No grantable permission metadata exists in this environment.");
    const grantablePermission = permission as GrantablePermission;

    const stamp = uniqueStamp();
    const appLabel = `E2E Permission App ${stamp}`;
    const roleName = `E2E Permission Role ${stamp}`;
    let appId = "";
    let roleId = "";
    let grantId = "";

    try {
      const app = await createAdminAppViaUi(
        page,
        request,
        {
          label: appLabel,
          apiName: safeApiName(appLabel),
          prefix: shortPrefix(`p${stamp}`)
        },
        testInfo
      );
      appId = app.id;

      const role = await createAdminRoleViaUi(
        page,
        request,
        app,
        { name: roleName, description: "Disposable role for permission grant lifecycle testing." },
        testInfo
      );
      roleId = role.id;

      await openPermissionDetailsViaUi(page, grantablePermission);
      await page.locator("#permission-grant-source").selectOption("runtime");
      await page.locator("#permission-grant-effect").selectOption("allow");
      await page.locator("#permission-grant-principal-type").selectOption("role");
      await selectOptionContainingText(page.locator("#permission-grant-principal"), role.name);
      await attachEvidence(page, testInfo, "admin-permission-grant-before-add");
      await page.getByRole("button", { name: /^add grant$/i }).click();
      const grantRow = page.locator(".grant-row").filter({ hasText: role.name }).first();
      await expect(grantRow).toBeVisible({ timeout: 20_000 });
      const grant = await expect
        .poll(
          async () =>
            (await listPermissionGrants(request, grantablePermission.id)).find(
              (item) =>
                item.principal_type === "role" &&
                item.principal_id === roleId &&
                (item.effect ?? "allow") === "allow" &&
                (item.source ?? "metadata") === "runtime"
            ) ?? null,
          { timeout: 20_000 }
        )
        .not.toBeNull()
        .then(async () =>
          (await listPermissionGrants(request, grantablePermission.id)).find(
            (item) =>
              item.principal_type === "role" &&
              item.principal_id === roleId &&
              (item.effect ?? "allow") === "allow" &&
              (item.source ?? "metadata") === "runtime"
          )
        );
      expect(grant).toBeTruthy();
      grantId = grant?.id ?? "";

      await grantRow.getByRole("button", { name: /^remove$/i }).click();
      await expect(page.getByRole("heading", { name: /^remove grant$/i })).toBeVisible();
      await page.getByRole("button", { name: /^confirm$/i }).click();
      await expect(grantRow).toBeHidden({ timeout: 20_000 });
      await expect
        .poll(
          async () =>
            (await listPermissionGrants(request, grantablePermission.id)).some(
              (item) => item.id === grantId || (item.principal_type === "role" && item.principal_id === roleId)
            ),
          { timeout: 20_000 }
        )
        .toBe(false);
      grantId = "";

      await expectKeystoneAppVisible(page, app.label, testInfo, "keystone-app-after-permission-grant-lifecycle");
    } finally {
      await deletePermissionGrantById(request, grantablePermission.id, grantId, "runtime");
      if (appId) {
        await deleteAdminRoleOrGroupByName(request, "roles", appId, [roleName]);
      }
      await cleanupAdminMetadataByApi(request, {
        appId,
        appLabel
      });
    }
  });
});
