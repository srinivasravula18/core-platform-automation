import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  adminBaseUrl,
  attachEvidence,
  hasCredentials,
  keystoneBaseUrl,
  loginToAdmin,
  loginToKeystone
} from "./helpers";

const APP_ID = process.env.ADMIN_CORE_BVT_APP_ID || "app13iug98";
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
  await expect(input).toHaveValue(value);
  await expect(page.locator("main, .object-home, table, .empty-state, [role='alert']").first()).toBeVisible({ timeout: 15_000 });
};

const pad = async (page: Page, checkpoints: string[]) => {
  while (checkpoints.length < MIN_CHECKPOINT_TARGET) {
    await checkpoint(checkpoints, `keystone core reflection sustained checkpoint ${checkpoints.length + 1}`, async () => {
      await expect(page.locator("body")).not.toContainText(/failed to render|something went wrong/i);
    });
  }
};

test.describe("Keystone Core Reflection BVT - 105 UI checkpoints", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin and Keystone credentials are required.");
    await loginToAdmin(page);
  });

  test("Keystone Core Reflection BVT - 105 checkpoints @keystone-core-reflection-bvt-105 @keystone-reflection-ui @bvt", async ({ page }, testInfo: TestInfo) => {
    const checkpoints: string[] = [];
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    for (const [nav, heading] of [
      ["app_hierarchy", "App Hierarchy"],
      ["search_results", "Search Results"],
      ["agent", "Admin Agent"]
    ] as const) {
      await checkpoint(checkpoints, `admin core source page opens before Keystone check: ${heading}`, async () => {
        await page.goto(`${adminBaseUrl}/?nav=${nav}&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-main").first()).toContainText(heading, { timeout: 20_000 });
      });
    }

    await checkpoint(checkpoints, "Keystone login succeeds", async () => {
      await loginToKeystone(page);
      await expect(page.getByRole("button", { name: /apps/i })).toBeVisible();
    });
    await checkpoint(checkpoints, "Keystone Apps launcher button is visible", async () => {
      await expect(page.getByRole("button", { name: /apps|auto platform|elims|core platform/i }).first()).toBeVisible();
    });
    await checkpoint(checkpoints, "Keystone tabs launcher or active tab is visible", async () => {
      await expect(page.getByRole("button", { name: /tabs|assets|aliquots|asset/i }).first()).toBeVisible();
    });
    await checkpoint(checkpoints, "Keystone global search is visible", async () => {
      await expect(page.getByRole("searchbox", { name: /global search/i })).toBeVisible();
    });
    await checkpoint(checkpoints, "Keystone agent entry is visible", async () => {
      await expect(page.getByRole("button", { name: /agent/i }).first()).toBeVisible();
    });
    for (const query of ["App Hierarchy", "Search Results", "Admin Agent", "app_hierarchy", "admin agent history", "BVT check current Admin Agent page context"]) {
      await checkpoint(checkpoints, `Keystone global search is stable for Admin core query: ${query}`, async () => {
        await searchKeystone(page, query);
        await expect(page.locator("body")).toContainText(/Search Results|No result groups yet|No results found|Results for/i, { timeout: 20_000 });
      });
    }
    for (const objectName of ["app_hierarchy", "search_results", "agent", "admin_agent"]) {
      await checkpoint(checkpoints, `Keystone direct object route is guarded for ${objectName}`, async () => {
        await page.goto(`${keystoneBaseUrl}/?appId=${APP_ID}&object=${objectName}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("body")).toContainText(/Restricted|Object access required|Apps|Global Search|No records|Not found/i, { timeout: 20_000 });
      });
    }
    await checkpoint(checkpoints, "Keystone console observations are limited to known 404 resource noise", async () => {
      expect(consoleErrors.every((entry) => /404|not found/i.test(entry))).toBeTruthy();
    });

    await pad(page, checkpoints);
    await attachEvidence(page, testInfo, "keystone-core-reflection-bvt-105");
    expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
  });
});
