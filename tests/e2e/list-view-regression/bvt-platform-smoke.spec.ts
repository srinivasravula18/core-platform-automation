import { expect, test } from "@playwright/test";
import {
  apiLogin,
  attachEvidence,
  authHeaders,
  hasCredentials,
  loginToAdmin,
  loginToKeystone,
  openAdminScreen,
  selectKeystoneAppAndTab,
  expectListRegionReady,
  expectListToolbar
} from "./helpers";

test.describe("Build verification smoke coverage", () => {
  test("API health endpoint responds [surface: API] [feature: Platform health] [level: BVT] [precondition: local API service is running] [input: GET /health] [expected: health endpoint returns a successful response] [proof: backend service is alive before deeper UI regression]", async ({
    request
  }) => {
    const response = await request.get("/health");
    expect(response.ok(), await response.text()).toBeTruthy();
  });

  test("API login returns an access token [surface: API] [feature: Authentication] [level: BVT] [precondition: seeded credentials are configured] [input: POST /auth/login] [expected: access token is returned] [proof: authenticated API and UI setup can proceed]", async ({
    request
  }) => {
    test.skip(!hasCredentials(), "API credentials are not configured.");
    const token = await apiLogin(request);
    expect(token).toBeTruthy();
    const appsResponse = await request.get("/api/apps", { headers: authHeaders(token) });
    expect(appsResponse.ok(), await appsResponse.text()).toBeTruthy();
  });

  test("Admin authenticated shell is usable [surface: Admin] [feature: Authentication] [level: BVT] [precondition: seeded admin user is signed in] [input: open Admin root] [expected: sidebar and main content render without authentication or crash errors] [proof: Admin application shell is ready for smoke and regression testing]", async ({
    page
  }, testInfo) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    await loginToAdmin(page);
    await expect(page.locator(".admin-sidebar")).toBeVisible();
    await expect(page.locator(".admin-main")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/too many requests|unauthorized|something went wrong|failed to render/i);
    await attachEvidence(page, testInfo, "bvt-admin-shell").catch(() => null);
  });

  test("Admin Apps list view is ready for smoke navigation [surface: Admin] [feature: Navigation shell] [level: BVT] [precondition: seeded admin user is signed in] [input: open Apps from Admin navigation] [expected: Apps list view and toolbar render] [proof: Admin can reach a critical metadata list view after login]", async ({
    page
  }, testInfo) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    await loginToAdmin(page);
    const main = await openAdminScreen(page, "Apps");
    await expectListRegionReady(main);
    await expectListToolbar(main);
    await attachEvidence(page, testInfo, "bvt-admin-apps-list").catch(() => null);
  });

  test("Keystone authenticated shell is usable [surface: Keystone] [feature: Authentication] [level: BVT] [precondition: seeded Keystone user is signed in] [input: open Keystone root] [expected: app launcher and permission-loaded marker are reachable] [proof: Keystone application shell is ready for smoke and regression testing]", async ({
    page
  }, testInfo) => {
    test.skip(!hasCredentials(), "Keystone credentials are not configured.");
    await loginToKeystone(page);
    await expect(page.getByRole("button", { name: /apps/i })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/too many requests|unauthorized|something went wrong|failed to render/i);
    await attachEvidence(page, testInfo, "bvt-keystone-shell").catch(() => null);
  });

  test("Keystone object list view is ready for smoke navigation [surface: Keystone] [feature: Navigation shell] [level: BVT] [precondition: seeded Keystone user is signed in] [input: select an accessible app and object tab] [expected: object home list view and toolbar render] [proof: Keystone can reach a critical business object list view after login]", async ({
    page
  }, testInfo) => {
    test.skip(!hasCredentials(), "Keystone credentials are not configured.");
    await loginToKeystone(page);
    const selected = await selectKeystoneAppAndTab(page);
    await expectListRegionReady(selected.objectHome);
    await expectListToolbar(selected.objectHome);
    await attachEvidence(page, testInfo, "bvt-keystone-object-list").catch(() => null);
  });
});
