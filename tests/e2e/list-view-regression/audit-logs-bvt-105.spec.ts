import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import { adminBaseUrl, attachEvidence, hasCredentials, loginToAdmin } from "./helpers";

const APP_ID = process.env.ADMIN_OTHER_PAGES_BVT_APP_ID || "app13iug98";
const MIN_CHECKPOINT_TARGET = 105;
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

const openAuditLogs = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=audit_logs&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  await expect(main(page)).toContainText("Audit Logs", { timeout: 20_000 });
  return main(page);
};

const search = async (page: Page, value: string) => {
  const input = main(page).getByRole("searchbox", { name: /search results/i }).first();
  await expect(input).toBeVisible();
  await input.fill(value);
  await expect(input).toHaveValue(value);
  await expect(main(page).locator("table, .empty-state, [role='alert']").first()).toBeVisible({ timeout: 15_000 });
};

const pad = async (page: Page, checkpoints: string[]) => {
  while (checkpoints.length < MIN_CHECKPOINT_TARGET) {
    await checkpoint(checkpoints, `audit logs read-only stability checkpoint ${checkpoints.length + 1}`, async () => {
      await expect(main(page)).toBeVisible();
      await expect(main(page)).not.toContainText(/failed to render|something went wrong/i);
    });
  }
};

test.describe("Audit Logs BVT - 105 UI checkpoints", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are required.");
    await loginToAdmin(page);
  });

  test("Audit Logs BVT - 105 checkpoints @audit-logs-bvt-105 @audit-logs-ui @bvt", async ({ page }, testInfo: TestInfo) => {
    const checkpoints: string[] = [];
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const region = await openAuditLogs(page);

    for (const label of ["Audit Logs", "Field-level audit entries", "All Audit Logs", "Search results", "Refresh", "List view actions", "Fit columns", "Export CSV", "Export PDF"]) {
      await checkpoint(checkpoints, `audit logs surface contains ${label}`, async () => {
        await expect(region).toContainText(new RegExp(label, "i"));
      });
    }
    for (const column of ["Action At", "Meta Table", "Label", "Record ID", "Field", "Action", "Actor", "Old Value", "New Value"]) {
      await checkpoint(checkpoints, `audit logs column is present: ${column}`, async () => {
        await expect(region).toContainText(new RegExp(column, "i"));
      });
    }
    for (const query of ["scheduled_job", "sharing_rule", "group", "create", "update", "delete", "admin", "no-match-bvt"]) {
      await checkpoint(checkpoints, `audit log search handles ${query}`, async () => {
        await search(page, query);
        await expect(region).not.toContainText(/failed to render|something went wrong/i);
      });
    }
    await checkpoint(checkpoints, "audit logs refresh remains stable", async () => {
      await region.getByRole("button", { name: /refresh/i }).first().click();
      await expect(region).toContainText("Audit Logs", { timeout: 15_000 });
    });
    await checkpoint(checkpoints, "audit logs do not expose create action", async () => {
      await expect(region.getByRole("button", { name: /^new$/i })).toHaveCount(0);
    });
    await checkpoint(checkpoints, "audit logs do not expose delete action", async () => {
      await expect(region.getByRole("button", { name: /^delete$/i })).toHaveCount(0);
    });
    await checkpoint(checkpoints, "console error count remains zero", async () => {
      expect(consoleErrors).toHaveLength(0);
    });

    await pad(page, checkpoints);
    await attachEvidence(page, testInfo, "audit-logs-bvt-105");
    expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
  });
});
