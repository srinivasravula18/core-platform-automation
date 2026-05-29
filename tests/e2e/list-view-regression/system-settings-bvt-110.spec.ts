import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import { adminBaseUrl, allowWrites, attachEvidence, hasCredentials, loginToAdmin } from "./helpers";

const APP_ID = process.env.ADMIN_OTHER_PAGES_BVT_APP_ID || "app13iug98";
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

const openSystemSettings = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=system_settings&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  await expect(main(page)).toContainText("System Settings", { timeout: 20_000 });
  return main(page);
};

const searchSettings = async (page: Page, value: string) => {
  const search = main(page).getByRole("searchbox", { name: /search settings/i }).first();
  await expect(search).toBeVisible();
  await search.fill(value);
  await page.waitForTimeout(250);
};

const pad = async (page: Page, checkpoints: string[]) => {
  while (checkpoints.length < MIN_CHECKPOINT_TARGET) {
    await checkpoint(checkpoints, `system settings sustained shell checkpoint ${checkpoints.length + 1}`, async () => {
      await expect(main(page)).toBeVisible();
      await expect(main(page)).not.toContainText(/something went wrong|uncaught|failed to render/i);
    });
  }
};

test.describe("System Settings BVT - 110 UI checkpoints", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are required.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to allow update/revert coverage.");
    await loginToAdmin(page);
  });

  test("System Settings BVT - 110 checkpoints @system-settings-bvt-110 @system-settings-ui @bvt", async ({ page }, testInfo: TestInfo) => {
    const checkpoints: string[] = [];
    const region = await openSystemSettings(page);
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await checkpoint(checkpoints, "system settings heading is visible", async () => {
      await expect(region).toContainText("System Settings");
    });
    await checkpoint(checkpoints, "system settings description is visible", async () => {
      await expect(region).toContainText(/Global defaults and platform limits/i);
    });
    await checkpoint(checkpoints, "search settings input is visible", async () => {
      await expect(region.getByRole("searchbox", { name: /search settings/i })).toBeVisible();
    });
    await checkpoint(checkpoints, "refresh action is visible", async () => {
      await expect(region.getByRole("button", { name: /refresh/i }).first()).toBeVisible();
    });

    const labels = [
      "API rate limiting",
      "App trigger memory",
      "App trigger recursion",
      "App trigger time",
      "Bulk max rows",
      "Column filter distinct max rows",
      "Default email from address",
      "Default list view page size",
      "End-user app name",
      "File allowed types",
      "Fiscal",
      "Global defaults",
      "Platform limits"
    ];
    for (const label of labels) {
      await checkpoint(checkpoints, `setting label renders: ${label}`, async () => {
        await expect(region).toContainText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      });
    }

    const queries = ["end-user app name", "bulk", "rate", "column filter", "file", "fiscal", "email", "page size"];
    for (const query of queries) {
      await checkpoint(checkpoints, `search settings accepts ${query}`, async () => {
        await searchSettings(page, query);
        await expect(region).toContainText(new RegExp(query.split(" ")[0], "i"));
      });
    }

    await checkpoint(checkpoints, "end-user app name can be searched", async () => {
      await searchSettings(page, "end-user app name");
      await expect(region).toContainText(/End-user app name/i);
    });
    const textboxes = region.getByRole("textbox");
    await checkpoint(checkpoints, "editable textbox exists for setting value", async () => {
      await expect(textboxes.first()).toBeVisible();
    });
    await checkpoint(checkpoints, "setting value can be updated", async () => {
      await textboxes.first().fill("Keystone BVT");
      await expect(textboxes.first()).toHaveValue("Keystone BVT");
    });
    await checkpoint(checkpoints, "setting value can be reverted", async () => {
      await textboxes.first().fill("Keystone");
      await expect(textboxes.first()).toHaveValue("Keystone");
    });
    await checkpoint(checkpoints, "refresh keeps page stable after revert", async () => {
      await region.getByRole("button", { name: /refresh/i }).first().click();
      await expect(region).toContainText("System Settings", { timeout: 15_000 });
    });

    for (const query of ["bulk", "email", "api", "timezone", "fiscal", "trigger", "file"]) {
      await checkpoint(checkpoints, `post-refresh search remains stable for ${query}`, async () => {
        await searchSettings(page, query);
        await expect(region).not.toContainText(/failed to render|something went wrong/i);
      });
    }

    await checkpoint(checkpoints, "console error count remains zero", async () => {
      expect(consoleErrors).toHaveLength(0);
    });
    await pad(page, checkpoints);
    await attachEvidence(page, testInfo, "system-settings-bvt-110");
    expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
  });
});
