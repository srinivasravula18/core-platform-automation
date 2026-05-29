import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import { adminBaseUrl, attachEvidence, hasCredentials, loginToAdmin, loginToKeystone } from "./helpers";

const CHECKPOINT_TARGET = 206;
const ADMIN_APP_ID = process.env.ADMIN_KEYSTONE_NAV_BVT_APP_ID || "app13iug98";

const adminSections = [
  { label: "Apps", nav: "apps", expected: /Apps|Applications|All Apps/i },
  { label: "App Hierarchy", nav: "app_hierarchy", expected: /App Hierarchy|Hierarchy/i },
  { label: "Search Results", nav: "search_results", expected: /Search Results|Search/i },
  { label: "Agent", nav: "agent", expected: /Agent/i },
  { label: "Objects", nav: "objects", expected: /Objects|All Objects/i },
  { label: "Tabs", nav: "tabs", expected: /Tabs|All Tabs/i },
  { label: "Flows", nav: "flows", expected: /Flows|Flow List/i },
  { label: "Roles", nav: "roles", expected: /Roles|All Roles/i },
  { label: "Groups", nav: "groups", expected: /Groups|All Groups/i },
  { label: "Users", nav: "users", expected: /Users|All Users/i },
  { label: "Permissions", nav: "permissions", expected: /Permissions|All Permissions/i },
  { label: "Access Records", nav: "access_records", expected: /Access Records|Access Controls|Permissions/i },
  { label: "Sharing Settings", nav: "sharing_settings", expected: /Sharing Settings|Sharing/i },
  { label: "System Settings", nav: "system_settings", expected: /System Settings|Settings/i },
  { label: "Email Logs", nav: "email_logs", expected: /Email Logs|Email/i },
  { label: "Scheduled Jobs", nav: "scheduled_jobs", expected: /Scheduled Jobs|Jobs/i },
  { label: "Audit Logs", nav: "audit_logs", expected: /Audit Logs|Audit/i },
  { label: "Recycle Bin", nav: "recycle_bin", expected: /Recycle Bin|Deleted|Recycle/i }
];

const keystoneApps = [
  {
    name: "AUTO Platform QA 528A",
    tabs: ["Data Import Wizard", "Agent", "Flows", "Asset"]
  },
  {
    name: "Core Platform",
    tabs: ["Data Import Wizard", "Agent", "Asset", "Auto Object 34mwu3 Updated Workspace"]
  },
  {
    name: "Operations Hub",
    tabs: ["Data Import Wizard", "Agent", "Asset", "Auto Object 34mwu3 Updated Workspace"]
  },
  {
    name: "Revenue Hub",
    tabs: ["Data Import Wizard", "Agent", "Asset", "Auto Object 34mwu3 Updated Workspace"]
  },
  {
    name: "CRM",
    tabs: ["Data Import Wizard", "Agent", "Flows", "Account"]
  },
  {
    name: "LIMS",
    tabs: ["Data Import Wizard", "Agent", "Asset", "Auto Object 34mwu3 Updated Workspace"]
  },
  {
    name: "HR",
    tabs: ["Data Import Wizard", "Agent", "Asset", "Auto Object 34mwu3 Updated Workspace"]
  },
  {
    name: "ELIMS",
    tabs: ["Data Import Wizard", "Agent", "Flows", "Aliquots"]
  }
];

const bodyText = async (page: Page) => page.locator("body").innerText({ timeout: 15_000 });
const safeEvidenceName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const checkpoint = async (
  checkpoints: string[],
  name: string,
  assertion: () => Promise<void> | void
) => {
  await test.step(`${String(checkpoints.length + 1).padStart(3, "0")} ${name}`, async () => {
    checkpoints.push(name);
    try {
      await assertion();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect.soft(message, name).toBe("");
    }
  });
};

const expectNoRuntimeError = async (page: Page) => {
  await expect(page.locator("body")).not.toContainText(
    /something went wrong|uncaught|failed to render|application error|runtime error/i
  );
};

const expectInteractiveContent = async (page: Page) => {
  const interactiveCount = await page.locator("button,a,input,select,textarea,[role='button'],[role='tab']").count();
  expect(interactiveCount).toBeGreaterThan(0);
};

const expectListOrContent = async (page: Page) => {
  const text = await bodyText(page);
  const structuralCount = await page
    .locator("main,.admin-main,section,article,table,tbody tr,.list-view,.list-view-table,.record-list,.admin-card,.settings-panel,.empty-state,[role='table']")
    .count();
  expect(structuralCount).toBeGreaterThan(0);
  expect(text.length).toBeGreaterThan(20);
};

const waitForAdminSurfaceReady = async (page: Page) => {
  const main = page.locator(".admin-main").first();
  await expect(main).toBeVisible({ timeout: 20_000 });
  await page
    .locator(".admin-main table, .admin-main tbody tr, .admin-main .list-view, .admin-main .empty-state, .admin-main [role='table']")
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(async () => {
      await expect(main).toContainText(/\S/, { timeout: 20_000 });
    });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => null);
  await page.waitForTimeout(750);
};

const waitForKeystoneSurfaceReady = async (page: Page) => {
  await expect(page.locator("body")).toContainText(/\S/, { timeout: 20_000 });
  await page
    .locator("table, tbody tr, .list-view, .record-list, .empty-state, [role='table'], main")
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => null);
  await page.waitForTimeout(750);
};

const openAdminSection = async (page: Page, section: (typeof adminSections)[number]) => {
  await page.goto(`${adminBaseUrl}/?nav=${section.nav}&appId=${ADMIN_APP_ID}`, { waitUntil: "domcontentloaded" });
  const main = page.locator(".admin-main").first();
  await expect(page.locator(".admin-sidebar")).toBeVisible({ timeout: 20_000 });
  await expect(main).toBeVisible({ timeout: 20_000 });
  await waitForAdminSurfaceReady(page);
  return main;
};

const openKeystoneApps = async (page: Page) => {
  const appsButton = page.getByRole("button", { name: /apps/i }).first();
  await expect(appsButton).toBeVisible({ timeout: 20_000 });
  await appsButton.click();
  const launcher = page.locator(".launcher, [role='dialog'], [role='menu']").filter({ hasText: /Platform|Hub|CRM|LIMS|HR|ELIMS/i }).first();
  await expect(launcher).toBeVisible({ timeout: 10_000 });
  return launcher;
};

const openKeystoneTabs = async (page: Page) => {
  const tabsButton = page
    .getByRole("button")
    .filter({ hasText: /tabs|objects|menu/i })
    .first();
  if (await tabsButton.isVisible().catch(() => false)) {
    await tabsButton.click();
  } else {
    await page.locator("button").nth(1).click();
  }
  const launcher = page.locator(".launcher, [role='dialog'], [role='menu']").filter({ hasText: /Data Import Wizard|Agent|Asset|Flows|Account|Aliquots/i }).first();
  await expect(launcher).toBeVisible({ timeout: 10_000 });
  return launcher;
};

const chooseLauncherItem = async (launcher: ReturnType<Page["locator"]>, name: string) => {
  const item = launcher.getByText(name, { exact: true }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
};

test.describe("Admin and Keystone navigation BVT", () => {
  test.setTimeout(600_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin and Keystone credentials are not configured.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "admin-keystone-nav-bvt-206-final-evidence").catch(() => null);
    }
  });

  test("Admin side nav and Keystone app/tab BVT - 206 checkpoints @admin-keystone-nav-bvt-206 @navigation-ui @bvt", async ({
    page,
    context
  }) => {
    const testInfo = test.info();
    const checkpoints: string[] = [];

    for (const section of adminSections) {
      const main = await openAdminSection(page, section);

      await checkpoint(checkpoints, `Admin ${section.label} sidebar item visible`, async () => {
        await expect(page.locator(".admin-sidebar")).toContainText(section.label);
      });
      await checkpoint(checkpoints, `Admin ${section.label} opens after navigation`, async () => {
        await expect(main).toBeVisible();
        await expect(main).toContainText(section.expected);
      });
      await checkpoint(checkpoints, `Admin ${section.label} has no crash state`, async () => {
        await expectNoRuntimeError(page);
      });
      await checkpoint(checkpoints, `Admin ${section.label} expected content visible`, async () => {
        await expect(main).toContainText(section.expected);
      });
      await checkpoint(checkpoints, `Admin ${section.label} interactive controls present`, async () => {
        await expectInteractiveContent(page);
      });
      await checkpoint(checkpoints, `Admin ${section.label} list or page content present`, async () => {
        await expectListOrContent(page);
      });
      await attachEvidence(page, testInfo, `admin-section-${safeEvidenceName(section.label)}`).catch(() => null);
    }

    const keystone = await context.newPage();
    await loginToKeystone(keystone);
    await waitForKeystoneSurfaceReady(keystone);

    await checkpoint(checkpoints, "Keystone shell authenticates and apps button is visible", async () => {
      await expect(keystone.getByRole("button", { name: /apps/i }).first()).toBeVisible();
    });
    await checkpoint(checkpoints, "Keystone runtime content loads without crash", async () => {
      await expectNoRuntimeError(keystone);
      expect((await bodyText(keystone)).length).toBeGreaterThan(20);
    });

    for (const app of keystoneApps) {
      const appsLauncher = await openKeystoneApps(keystone);

      await checkpoint(checkpoints, `Keystone app launcher shows ${app.name}`, async () => {
        await expect(appsLauncher).toContainText(app.name);
      });
      await checkpoint(checkpoints, `Keystone app opens ${app.name}`, async () => {
        await chooseLauncherItem(appsLauncher, app.name);
        await expect(keystone.locator("body")).toContainText(new RegExp(app.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), {
          timeout: 20_000
        });
        await waitForKeystoneSurfaceReady(keystone);
      });
      await checkpoint(checkpoints, `Keystone app ${app.name} has no crash state`, async () => {
        await expectNoRuntimeError(keystone);
      });
      await checkpoint(checkpoints, `Keystone app ${app.name} tabs launcher opens`, async () => {
        const tabsLauncher = await openKeystoneTabs(keystone);
        await expect(tabsLauncher).toBeVisible();
        await keystone.keyboard.press("Escape").catch(() => null);
      });
      await attachEvidence(keystone, testInfo, `keystone-app-${safeEvidenceName(app.name)}`).catch(() => null);

      for (const tab of app.tabs) {
        const tabsLauncher = await openKeystoneTabs(keystone);

        await checkpoint(checkpoints, `Keystone ${app.name} tab opens ${tab}`, async () => {
          await chooseLauncherItem(tabsLauncher, tab);
          await expect(keystone.locator("body")).toContainText(new RegExp(tab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), {
            timeout: 20_000
          });
          await waitForKeystoneSurfaceReady(keystone);
        });
        await checkpoint(checkpoints, `Keystone ${app.name} tab ${tab} list or runtime content visible`, async () => {
          await expectNoRuntimeError(keystone);
          await expectInteractiveContent(keystone);
          expect((await bodyText(keystone)).length).toBeGreaterThan(20);
        });
        await attachEvidence(keystone, testInfo, `keystone-tab-${safeEvidenceName(app.name)}-${safeEvidenceName(tab)}`).catch(() => null);
      }
    }

    await attachEvidence(keystone, testInfo, "admin-keystone-nav-bvt-206-keystone-evidence").catch(() => null);
    expect(checkpoints).toHaveLength(CHECKPOINT_TARGET);
  });
});
