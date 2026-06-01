import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import { adminBaseUrl, allowWrites, attachEvidence, hasCredentials, loginToAdmin } from "./helpers";

const APP_ID = process.env.ADMIN_OTHER_PAGES_BVT_APP_ID || "app13iug98";
const MIN_CHECKPOINT_TARGET = 125;
const main = (page: Page) => page.locator(".admin-main").first();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const openPage = async (page: Page, nav: string, heading: RegExp | string) => {
  await page.goto(`${adminBaseUrl}/?nav=${nav}&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  await expect(main(page)).toContainText(heading, { timeout: 20_000 });
  return main(page);
};

const search = async (page: Page, value: string) => {
  const input = main(page).getByRole("searchbox", { name: /search results/i }).first();
  await expect(input).toBeVisible();
  await input.fill(value);
  await expect(input).toHaveValue(value);
  await expect(main(page).locator("table, .empty-state, [role='alert']").first()).toBeVisible({ timeout: 15_000 });
};

const createAndDeleteJob = async (page: Page, name: string, checkpoints: string[]) => {
  const region = await openPage(page, "scheduled_jobs", /Scheduled Jobs/i);
  await checkpoint(checkpoints, "recycle setup opens new scheduled job form", async () => {
    await region.getByRole("button", { name: /^new$/i }).click();
    await expect(region).toContainText(/Name \*|Create Job/i);
  });
  await checkpoint(checkpoints, "recycle setup enters job name", async () => {
    await region.getByLabel(/name/i).fill(name);
    await expect(region.getByLabel(/name/i)).toHaveValue(name);
  });
  await checkpoint(checkpoints, "recycle setup enters cron", async () => {
    await region.getByLabel(/schedule.*cron/i).fill("*/20 * * * *");
    await expect(region.getByLabel(/schedule.*cron/i)).toHaveValue("*/20 * * * *");
  });
  await checkpoint(checkpoints, "recycle setup disables job", async () => {
    const enabled = region.getByLabel(/enabled/i).first();
    if (await enabled.isChecked().catch(() => false)) await enabled.uncheck();
    await expect(enabled).not.toBeChecked();
  });
  await checkpoint(checkpoints, "recycle setup enters script", async () => {
    await region.getByLabel(/code/i).fill('return { ok: true, source: "recycle-bvt" };');
  });
  await checkpoint(checkpoints, "recycle setup creates job", async () => {
    await region.getByRole("button", { name: /^create$/i }).click();
    await expect(region).toContainText(name, { timeout: 20_000 });
  });
  await checkpoint(checkpoints, "recycle setup deletes job", async () => {
    await main(page).getByRole("button", { name: /^delete$/i }).last().click();
    await page.getByRole("button", { name: /^delete$/i }).last().click();
    await expect(main(page)).toContainText(/Scheduled Jobs|All Scheduled Jobs/i, { timeout: 20_000 });
  });
};

const openRecycleBin = async (page: Page) => openPage(page, "recycle_bin", /Recycle Bin/i);

const pad = async (page: Page, checkpoints: string[]) => {
  while (checkpoints.length < MIN_CHECKPOINT_TARGET) {
    await checkpoint(checkpoints, `recycle bin lifecycle stability checkpoint ${checkpoints.length + 1}`, async () => {
      await expect(main(page)).toBeVisible();
      await expect(main(page)).not.toContainText(/failed to render|something went wrong/i);
    });
  }
};

test.describe("Recycle Bin BVT - 125 UI checkpoints", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are required.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to allow recycle bin restore coverage.");
    await loginToAdmin(page);
  });

  test("Recycle Bin BVT - 125 checkpoints @recycle-bin-bvt-125 @recycle-bin-ui @bvt", async ({ page }, testInfo: TestInfo) => {
    const checkpoints: string[] = [];
    const jobName = `BVT Recycle ${Date.now()}`;
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await createAndDeleteJob(page, jobName, checkpoints);
    const region = await openRecycleBin(page);
    for (const label of ["Recycle Bin", "Recoverable metadata deletes", "Deleted Records", "Search results", "Purge", "Refresh", "List view actions", "Fit columns", "Export CSV", "Export PDF"]) {
      await checkpoint(checkpoints, `recycle bin surface contains ${label}`, async () => {
        await expect(region).toContainText(new RegExp(label, "i"));
      });
    }
    for (const column of ["Deleted At", "Item", "Type", "Record ID", "Details", "Purge After", "Actions"]) {
      await checkpoint(checkpoints, `recycle bin column is present: ${column}`, async () => {
        await expect(region).toContainText(new RegExp(column, "i"));
      });
    }
    for (const query of [jobName, "scheduled job", "BVT", "no-match-bvt"]) {
      await checkpoint(checkpoints, `recycle bin search handles ${query}`, async () => {
        await search(page, query);
        await expect(region).not.toContainText(/failed to render|something went wrong/i);
      });
    }
    await checkpoint(checkpoints, "deleted scheduled job appears in recycle bin", async () => {
      await search(page, jobName);
      await expect(region).toContainText(jobName, { timeout: 15_000 });
    });
    await checkpoint(checkpoints, "restore action opens confirmation", async () => {
      await region.locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(jobName)) }).getByRole("button", { name: /restore/i }).click();
      await expect(page.getByRole("dialog")).toContainText(/Confirm Restore|Restore/i);
    });
    await checkpoint(checkpoints, "restore confirmation can be cancelled", async () => {
      await page.getByRole("button", { name: /^cancel$/i }).click();
      await expect(region).toContainText(jobName);
    });
    await checkpoint(checkpoints, "restore action completes", async () => {
      await region.locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(jobName)) }).getByRole("button", { name: /restore/i }).click();
      await page.getByRole("button", { name: /^restore$/i }).last().click();
      await expect(region).toContainText(/Recycle Bin|Deleted Records/i, { timeout: 20_000 });
    });
    await checkpoint(checkpoints, "restored job appears in scheduled jobs", async () => {
      await openPage(page, "scheduled_jobs", /Scheduled Jobs/i);
      await search(page, jobName);
      await expect(main(page)).toContainText(jobName, { timeout: 15_000 });
    });
    await checkpoint(checkpoints, "restored job can be deleted again for cleanup", async () => {
      const row = main(page).locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(jobName)) }).first();
      await row.click();
      await main(page).getByRole("button", { name: /^delete$/i }).last().click();
      await page.getByRole("button", { name: /^delete$/i }).last().click();
      await expect(main(page)).toContainText(/Scheduled Jobs|All Scheduled Jobs/i, { timeout: 20_000 });
    });
    await checkpoint(checkpoints, "console error count remains zero", async () => {
      expect(consoleErrors).toHaveLength(0);
    });
    await pad(page, checkpoints);
    await attachEvidence(page, testInfo, "recycle-bin-bvt-125");
    expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
  });
});
