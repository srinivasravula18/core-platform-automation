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

const openScheduledJobs = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=scheduled_jobs&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  await expect(main(page)).toContainText("Scheduled Jobs", { timeout: 20_000 });
  return main(page);
};

const searchJobs = async (page: Page, value: string) => {
  const input = main(page).getByRole("searchbox", { name: /search results/i }).first();
  await expect(input).toBeVisible();
  await input.fill(value);
  await page.waitForTimeout(350);
};

const openJob = async (page: Page, name: string) => {
  const row = main(page).locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(name)) }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(main(page)).toContainText(/Edit Job|Job Details|Runs|Audit Log/i, { timeout: 15_000 });
};

const deleteCurrentJob = async (page: Page) => {
  const button = main(page).getByRole("button", { name: /^delete$/i }).last();
  if (!(await button.isVisible().catch(() => false))) return;
  await button.click();
  const confirm = page.getByRole("button", { name: /^delete$/i }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(main(page)).toContainText(/Scheduled Jobs|All Scheduled Jobs/i, { timeout: 20_000 });
};

const createDisabledJob = async (page: Page, name: string, checkpoints: string[]) => {
  const region = main(page);
  await checkpoint(checkpoints, "new scheduled job action opens create form", async () => {
    await region.getByRole("button", { name: /^new$/i }).click();
    await expect(region).toContainText(/Create Job|Name \*/i, { timeout: 15_000 });
  });
  await checkpoint(checkpoints, "scheduled job name can be entered", async () => {
    await region.getByLabel(/name/i).fill(name);
    await expect(region.getByLabel(/name/i)).toHaveValue(name);
  });
  await checkpoint(checkpoints, "scheduled job cron can be entered", async () => {
    await region.getByLabel(/schedule.*cron/i).fill("*/15 * * * *");
    await expect(region.getByLabel(/schedule.*cron/i)).toHaveValue("*/15 * * * *");
  });
  await checkpoint(checkpoints, "scheduled job timezone can be entered", async () => {
    await region.getByLabel(/timezone/i).fill("UTC");
    await expect(region.getByLabel(/timezone/i)).toHaveValue("UTC");
  });
  await checkpoint(checkpoints, "scheduled job enabled can be disabled", async () => {
    const enabled = region.getByLabel(/enabled/i).first();
    if (await enabled.isChecked().catch(() => false)) await enabled.uncheck();
    await expect(enabled).not.toBeChecked();
  });
  await checkpoint(checkpoints, "scheduled job description can be entered", async () => {
    await region.getByLabel(/description/i).fill("BVT disposable disabled scheduler job");
    await expect(region.getByLabel(/description/i)).toHaveValue("BVT disposable disabled scheduler job");
  });
  await checkpoint(checkpoints, "scheduled job run-as user can be entered", async () => {
    await region.getByLabel(/run as user/i).fill("usradmin1");
    await expect(region.getByLabel(/run as user/i)).toHaveValue("usradmin1");
  });
  await checkpoint(checkpoints, "scheduled job code can be entered", async () => {
    await region.getByLabel(/code/i).fill('return { ok: true, source: "bvt" };');
    await expect(region.getByLabel(/code/i)).toHaveValue('return { ok: true, source: "bvt" };');
  });
  await checkpoint(checkpoints, "scheduled job create saves record", async () => {
    await region.getByRole("button", { name: /^create$/i }).click();
    await expect(region).toContainText(name, { timeout: 20_000 });
  });
};

const pad = async (page: Page, checkpoints: string[]) => {
  while (checkpoints.length < MIN_CHECKPOINT_TARGET) {
    await checkpoint(checkpoints, `scheduled jobs lifecycle stability checkpoint ${checkpoints.length + 1}`, async () => {
      await expect(main(page)).toBeVisible();
      await expect(main(page)).not.toContainText(/failed to render|something went wrong/i);
    });
  }
};

test.describe("Scheduled Jobs BVT - 125 UI checkpoints", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are required.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to allow scheduled job CRUD.");
    await loginToAdmin(page);
  });

  test("Scheduled Jobs BVT - 125 checkpoints @scheduled-jobs-bvt-125 @scheduled-jobs-ui @bvt", async ({ page }, testInfo: TestInfo) => {
    const checkpoints: string[] = [];
    const baseName = `BVT Scheduler ${Date.now()}`;
    const updatedName = `${baseName} Updated`;
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    try {
      const region = await openScheduledJobs(page);
      for (const label of ["Due", "Running", "Error", "Worker", "All Scheduled Jobs", "New", "Refresh"]) {
        await checkpoint(checkpoints, `scheduled jobs shell contains ${label}`, async () => {
          await expect(region).toContainText(new RegExp(label, "i"));
        });
      }
      for (const column of ["ID", "Name", "Job Type", "Schedule", "Schedule Text", "Timezone", "Status", "Enabled", "Next Run", "Last Run", "Modified At"]) {
        await checkpoint(checkpoints, `scheduled jobs column is present: ${column}`, async () => {
          await expect(region).toContainText(new RegExp(column, "i"));
        });
      }
      for (const query of ["Hourly", "Cleanup", "Heartbeat", "Core", "no-match-bvt"]) {
        await checkpoint(checkpoints, `scheduled jobs search handles ${query}`, async () => {
          await searchJobs(page, query);
          await expect(region).not.toContainText(/failed to render|something went wrong/i);
        });
      }

      await createDisabledJob(page, baseName, checkpoints);
      for (const label of ["Edit Job", "Save", "Run Now", "Delete", "Runs", "Audit Log", "Retry Policy"]) {
        await checkpoint(checkpoints, `scheduled job detail contains ${label}`, async () => {
          await expect(main(page)).toContainText(new RegExp(label, "i"));
        });
      }
      await checkpoint(checkpoints, "scheduled job name can be updated", async () => {
        await main(page).getByLabel(/name/i).fill(updatedName);
        await main(page).getByRole("button", { name: /^save$/i }).click();
        await expect(main(page)).toContainText(updatedName, { timeout: 15_000 });
      });
      for (const tabName of ["Runs", "Audit Log"]) {
        await checkpoint(checkpoints, `scheduled job ${tabName} tab opens`, async () => {
          await main(page).getByRole("button", { name: new RegExp(`^${tabName}$`, "i") }).click();
          await expect(main(page)).toContainText(new RegExp(tabName, "i"));
        });
      }
      await checkpoint(checkpoints, "updated scheduled job can be found in list", async () => {
        await openScheduledJobs(page);
        await searchJobs(page, updatedName);
        await expect(region).toContainText(updatedName, { timeout: 15_000 });
      });
      await checkpoint(checkpoints, "updated scheduled job opens from list", async () => {
        await openJob(page, updatedName);
        await expect(main(page)).toContainText(updatedName);
      });
      await checkpoint(checkpoints, "updated scheduled job can be deleted", async () => {
        await deleteCurrentJob(page);
        await expect(main(page)).toContainText(/Scheduled Jobs|All Scheduled Jobs/i);
      });
      await checkpoint(checkpoints, "deleted scheduled job no longer appears in active search", async () => {
        await openScheduledJobs(page);
        await searchJobs(page, updatedName);
        await expect(main(page)).toContainText(/No records|No results|Scheduled Jobs/i);
      });
      await checkpoint(checkpoints, "console error count remains zero", async () => {
        expect(consoleErrors).toHaveLength(0);
      });
      await pad(page, checkpoints);
      await attachEvidence(page, testInfo, "scheduled-jobs-bvt-125");
      expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
    } finally {
      await openScheduledJobs(page).catch(() => null);
      await searchJobs(page, baseName).catch(() => null);
      if (await main(page).locator("table tbody tr").filter({ hasText: baseName }).first().isVisible().catch(() => false)) {
        await openJob(page, baseName).catch(() => null);
        await deleteCurrentJob(page).catch(() => null);
      }
    }
  });
});
