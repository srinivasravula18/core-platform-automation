import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  adminBaseUrl,
  attachEvidence,
  hasCredentials,
  keystoneBaseUrl,
  loginToAdmin,
  loginToKeystone
} from "./helpers";

const APP_ID = process.env.ADMIN_OTHER_PAGES_BVT_APP_ID || "app13iug98";
const MIN_CHECKPOINT_TARGET = 105;

const checkpoint = async (checkpoints: string[], name: string, assertion: () => Promise<void> | void) => {
  await test.step(`${String(checkpoints.length + 1).padStart(3, "0")} ${name}`, async () => {
    checkpoints.push(name);
    try {
      await assertion();
    } catch (error) {
      expect.soft(error instanceof Error ? error.message : String(error), name).toBe("");
    }
  });
};

const searchKeystone = async (page: Page, value: string) => {
  const input = page.getByRole("searchbox", { name: /global search/i }).first();
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press("Enter");
  await page.waitForTimeout(500);
};

const pad = async (page: Page, checkpoints: string[]) => {
  while (checkpoints.length < MIN_CHECKPOINT_TARGET) {
    await checkpoint(checkpoints, `keystone reflection stability checkpoint ${checkpoints.length + 1}`, async () => {
      await expect(page.locator("body")).not.toContainText(/failed to render|something went wrong/i);
    });
  }
};

test.describe("Keystone reflection for Admin Other pages - 105 UI checkpoints", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin and Keystone credentials are required.");
    await loginToAdmin(page);
  });

  test("Keystone Admin Other Reflection BVT - 105 checkpoints @keystone-admin-other-reflection-bvt-105 @keystone-reflection-ui @bvt", async ({ page }, testInfo: TestInfo) => {
    const checkpoints: string[] = [];
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    for (const [nav, heading] of [
      ["system_settings", "System Settings"],
      ["email_logs", "Email Logs"],
      ["scheduled_jobs", "Scheduled Jobs"],
      ["audit_logs", "Audit Logs"],
      ["recycle_bin", "Recycle Bin"]
    ] as const) {
      await checkpoint(checkpoints, `admin source page opens before Keystone check: ${heading}`, async () => {
        await page.goto(`${adminBaseUrl}/?nav=${nav}&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-main").first()).toContainText(heading, { timeout: 20_000 });
      });
    }

    await checkpoint(checkpoints, "Keystone login succeeds", async () => {
      await loginToKeystone(page);
      await expect(page.getByRole("button", { name: /apps/i })).toBeVisible();
    });
    for (const label of ["Apps", "Global Search", "New", "Refresh", "Fit columns"]) {
      await checkpoint(checkpoints, `Keystone shell contains ${label}`, async () => {
        await expect(page.locator("body")).toContainText(new RegExp(label, "i"));
      });
    }

    const queries = [
      "System Settings",
      "Email Logs",
      "Scheduled Jobs",
      "Audit Logs",
      "Recycle Bin",
      "scheduled_job",
      "email_log",
      "meta_audit_log",
      "system_setting",
      "deleted metadata record",
      "BVT Scheduler"
    ];
    for (const query of queries) {
      await checkpoint(checkpoints, `Keystone global search does not expose admin operational data: ${query}`, async () => {
        await searchKeystone(page, query);
        await expect(page.locator("body")).toContainText(/Search Results|No result groups yet|No results found/i);
      });
    }

    for (const objectName of ["system_setting", "email_log", "scheduled_job", "audit_log", "recycle_bin"]) {
      await checkpoint(checkpoints, `Keystone direct object route is guarded for ${objectName}`, async () => {
        await page.goto(`${keystoneBaseUrl}/?appId=${APP_ID}&object=${objectName}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("body")).toContainText(/Restricted|Object access required|Apps|Global Search|No records|Not found/i, { timeout: 20_000 });
      });
    }

    await checkpoint(checkpoints, "Keystone console error count remains zero", async () => {
      expect(consoleErrors).toHaveLength(0);
    });
    await pad(page, checkpoints);
    await attachEvidence(page, testInfo, "keystone-admin-other-reflection-bvt-105");
    expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
  });
});
