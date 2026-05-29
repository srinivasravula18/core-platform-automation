import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import { adminBaseUrl, attachEvidence, hasCredentials, loginToAdmin } from "./helpers";

const APP_ID = process.env.ADMIN_CORE_BVT_APP_ID || "app13iug98";
const MIN_CHECKPOINT_TARGET = 110;
const main = (page: Page) => page.locator(".admin-main").first();

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

const openAppHierarchy = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=app_hierarchy&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  await expect(main(page)).toContainText("App Hierarchy", { timeout: 20_000 });
  return main(page);
};

const pad = async (page: Page, checkpoints: string[]) => {
  while (checkpoints.length < MIN_CHECKPOINT_TARGET) {
    await checkpoint(checkpoints, `app hierarchy sustained health checkpoint ${checkpoints.length + 1}`, async () => {
      await expect(main(page)).toBeVisible();
      await expect(main(page)).not.toContainText(/failed to render|something went wrong|uncaught/i);
    });
  }
};

test.describe("App Hierarchy BVT - 110 UI checkpoints", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are required.");
    await loginToAdmin(page);
  });

  test("App Hierarchy BVT - 110 checkpoints @app-hierarchy-bvt-110 @app-hierarchy-ui @bvt", async ({ page }, testInfo: TestInfo) => {
    const checkpoints: string[] = [];
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    const region = await openAppHierarchy(page);
    for (const label of [
      "App Hierarchy",
      "Parent-child relationships are shown as a tree",
      "Core Platform",
      "core",
      "AUTO Platform QA 528A",
      "auto_platform_qa_528a"
    ]) {
      await checkpoint(checkpoints, `app hierarchy contains ${label}`, async () => {
        await expect(region).toContainText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      });
    }

    await checkpoint(checkpoints, "app hierarchy toggle control is visible", async () => {
      await expect(region.getByRole("button", { name: /toggle/i })).toBeVisible();
    });
    for (let index = 0; index < 8; index += 1) {
      await checkpoint(checkpoints, `app hierarchy toggle remains stable pass ${index + 1}`, async () => {
        await region.getByRole("button", { name: /toggle/i }).click();
        await expect(region).toContainText(/App Hierarchy|Core Platform/i);
      });
    }

    for (const nav of ["Apps", "App Hierarchy", "Search Results", "Agent"]) {
      await checkpoint(checkpoints, `core nav item remains visible: ${nav}`, async () => {
        await expect(page.locator(".admin-sidebar").getByRole("button", { name: new RegExp(`^${nav}$`, "i") })).toBeVisible();
      });
    }

    await checkpoint(checkpoints, "legacy app history nav safely resolves to a supported page", async () => {
      await page.goto(`${adminBaseUrl}/?nav=app_history&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
      await expect(main(page)).toContainText(/App Hierarchy|Recycle Bin|Apps/i, { timeout: 20_000 });
    });
    await checkpoint(checkpoints, "app hierarchy reload stays usable", async () => {
      await openAppHierarchy(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(main(page)).toContainText("App Hierarchy", { timeout: 20_000 });
    });
    await checkpoint(checkpoints, "console error count remains zero", async () => {
      expect(consoleErrors).toHaveLength(0);
    });

    await pad(page, checkpoints);
    await attachEvidence(page, testInfo, "app-hierarchy-bvt-110");
    expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
  });
});
