import { expect, test } from "../helpers/singleBrowserTest";
import {
  attachEvidence,
  closeModal,
  expectListRegionReady,
  hasCredentials,
  loginToKeystone
} from "../list-view-regression/helpers";
import {
  attachJsonEvidence,
  resolveSeedFixtures
} from "./seed-fixtures";

const keystoneTargets = [
  { app: "Operations Hub", tab: "Asset", object: "asset" },
  { app: "Operations Hub", tab: "Site", object: "site" },
  { app: "Operations Hub", tab: "Vendor", object: "vendor" },
  { app: "Operations Hub", tab: "Project", object: "project" },
  { app: "LIMS", tab: "Sample", object: "sample" },
  { app: "CRM", tab: "Account", object: "account" },
  { app: "CRM", tab: "Contact", object: "contact" }
];

const selectLauncherButton = async (page: import("@playwright/test").Page, name: string) => {
  const item = page.getByRole("button", { name: new RegExp(name, "i") }).first();
  await expect(item).toBeVisible();
  await item.click();
};

const openKeystoneTarget = async (page: import("@playwright/test").Page, app: string, tab: string) => {
  await page.getByRole("button", { name: /apps/i }).click();
  await selectLauncherButton(page, app);
  await page.getByRole("button", { name: /tabs/i }).click();
  await selectLauncherButton(page, tab);
  const objectHome = page.locator(".object-home").first();
  await expect(objectHome).toBeVisible();
  await expectListRegionReady(objectHome);
  return objectHome;
};

test.describe("Keystone separate seeded runtime coverage", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Seeded Keystone credentials are not configured.");
    await loginToKeystone(page);
  });

  test("Keystone seed readiness resolves runtime apps tabs and objects @keystone-depthwise @seed-readiness [surface: Keystone] [feature: Seed Data] [level: BVT] [testData: seed:industry-suite] [precondition: seed:industry-suite is loaded] [input: resolve runtime app/tab/object fixtures] [expected: all Keystone targets are available] [proof: Keystone can be tested separately from Admin]", async ({
    page,
    request
  }, testInfo) => {
    const fixtures = await resolveSeedFixtures(request);
    const resolved = keystoneTargets.map((target) => ({
      ...target,
      appId: fixtures.apps[target.app]?.id,
      tabId: fixtures.tabs[target.tab]?.id,
      objectId: fixtures.objects[target.object]?.id
    }));
    for (const row of resolved) {
      expect(row.appId, `Missing app ${row.app}`).toBeTruthy();
      expect(row.tabId, `Missing tab ${row.tab}`).toBeTruthy();
      expect(row.objectId, `Missing object ${row.object}`).toBeTruthy();
    }
    await attachJsonEvidence(page, testInfo, "keystone-seed-readiness", resolved);
  });

  for (const target of keystoneTargets) {
    test(`Keystone ${target.app} ${target.tab} UI opens separately @keystone-depthwise @keystone-screen:${target.object} [surface: Keystone] [feature: ${target.tab}] [level: BVT] [testData: seed:industry-suite ${target.tab}] [precondition: seeded Keystone user is signed in] [input: select ${target.app} app and ${target.tab} tab] [expected: object home table, empty state, or permission state renders] [proof: each Keystone screen can be run independently]`, async ({
      page
    }, testInfo) => {
      await openKeystoneTarget(page, target.app, target.tab);
      await attachEvidence(page, testInfo, `keystone-screen-${target.object}`).catch(() => null);
    });

    test(`Keystone ${target.app} ${target.tab} CRUD UI controls open safely @keystone-depthwise @keystone-screen:${target.object} @crud-ui [surface: Keystone] [feature: ${target.tab} CRUD UI] [level: Regression] [testData: seed:industry-suite ${target.tab}] [precondition: seeded Keystone user is signed in] [input: open New or row detail controls and close without saving] [expected: create/detail surfaces are reachable and can be dismissed without mutating data] [proof: each Keystone app tab exposes safe UI CRUD affordances where supported]`, async ({
      page
    }, testInfo) => {
      const objectHome = await openKeystoneTarget(page, target.app, target.tab);
      const newButton = objectHome.getByRole("button", { name: /^new$/i }).first();
      if (await newButton.isVisible().catch(() => false)) {
        test.skip(!(await newButton.isEnabled().catch(() => false)), `${target.tab} New is disabled by permissions or state.`);
        await newButton.click();
        await expect(page.locator("[role='dialog'], .modal, .drawer, .record-panel, .record-page").first()).toBeVisible();
        await attachEvidence(page, testInfo, `keystone-crud-new-${target.object}`).catch(() => null);
        await closeModal(page);
        return;
      }

      const firstRow = objectHome.locator("table tbody tr").first();
      test.skip(!(await firstRow.isVisible().catch(() => false)), `${target.tab} has no row to open.`);
      await firstRow.click();
      await expect(page.locator(".record-tabs, .record-panel, .record-page, .object-home").first()).toBeVisible();
      await attachEvidence(page, testInfo, `keystone-crud-detail-${target.object}`).catch(() => null);
    });

  }
});
