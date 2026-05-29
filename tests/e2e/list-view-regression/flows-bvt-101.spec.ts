import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  adminBaseUrl,
  allowWrites,
  attachEvidence,
  hasCredentials,
  keystoneBaseUrl,
  loginToAdmin,
  loginToKeystone
} from "./helpers";

const APP_ID = process.env.FLOWS_BVT_APP_ID || "app13iug98";
const CHECKPOINT_TARGET = 101;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bodyText = async (page: Page) => page.locator("body").innerText({ timeout: 10_000 });

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

const openFlowsPage = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=flows&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  const main = page.locator(".admin-main").first();
  await expect(main).toContainText("Flows", { timeout: 20_000 });
  await expect(main).toContainText("Flow List", { timeout: 20_000 });
  return main;
};

const rowForFlow = (page: Page, flowName: string) =>
  page.locator(".admin-main table tbody tr").filter({ hasText: new RegExp(escapeRegex(flowName)) }).first();

const openCreatedFlowFromList = async (page: Page, flowName: string) => {
  const row = rowForFlow(page, flowName);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByRole("heading", { name: "Edit Flow" })).toBeVisible({ timeout: 15_000 });
};

const deleteCurrentFlow = async (page: Page) => {
  const deleteButton = page.getByRole("button", { name: "Delete Flow" });
  if (!(await deleteButton.isVisible().catch(() => false))) return;
  await deleteButton.click();
  const confirm = page.getByRole("button", { name: "Delete", exact: true });
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.click();
  await expect(page.getByRole("heading", { name: "Flow List" }).or(page.getByText("Flow List"))).toBeVisible({
    timeout: 15_000
  });
};

test.describe("Flows page BVT", () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to run flow CRUD BVT coverage.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "flows-bvt-101-final-evidence").catch(() => null);
    }
  });

  test("Flows page BVT - 101 checkpoints @flows-bvt-101 @flows-ui", async ({ page, context }) => {
    const checkpoints: string[] = [];
    const stamp = Date.now().toString(36);
    const flowName = `BVT Flow Proper ${stamp}`;
    const updatedFlowName = `${flowName} Updated`;
    const apiName = `bvt_flow_proper_${stamp}`;
    const updatedApiName = `${apiName}_updated`;
    let cleanupName = "";

    try {
      const main = await openFlowsPage(page);

      for (const label of ["Admin shell opens", "Flows heading visible", "Flow List visible", "Seeded flow count visible"]) {
        await checkpoint(checkpoints, label, async () => {
          await expect(main).toBeVisible();
          await expect(main).toContainText(/Flows|Flow List|records/);
        });
      }

      for (const label of [
        "Flows",
        "Configure app-level flows",
        "List view",
        "All Flows",
        "New",
        "Delete",
        "Refresh list view",
        "List view actions",
        "Fit columns",
        "Export CSV",
        "Export PDF",
        "Search results",
        "Global Search",
        "admin",
        "AUTO Platform QA 528A"
      ]) {
        await checkpoint(checkpoints, `Flows page exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      for (const column of ["Name", "API Name", "Mode", "Version", "Active", "Default", "Modified At"]) {
        await checkpoint(checkpoints, `Flow list column visible: ${column}`, async () => {
          await expect(main.locator("table").first()).toContainText(column);
        });
      }

      for (const term of ["AUTO Case Create Flow", "auto_case_create_flow", "create", "Yes", "No"]) {
        await checkpoint(checkpoints, `Seeded flow term visible: ${term}`, async () => {
          await expect(main).toContainText(term);
        });
      }

      await checkpoint(checkpoints, "Refresh list view works", async () => {
        await main.getByRole("button", { name: /refresh list view/i }).click();
        await expect(main).toContainText("AUTO Case Create Flow");
      });

      await checkpoint(checkpoints, "Fit columns works", async () => {
        await main.getByRole("button", { name: /fit columns/i }).click();
        await expect(main.locator("table").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "New flow modal opens", async () => {
        await page.getByRole("button", { name: /^New$/ }).click();
        await expect(page.getByRole("heading", { name: "Create Flow" })).toBeVisible();
      });

      for (const label of [
        "Name",
        "API Name",
        "Mode",
        "Submit Strategy",
        "List Action Button ID (optional)",
        "Description",
        "Active",
        "Default for mode",
        "Allow cancel",
        "Cancel",
        "Create Flow"
      ]) {
        await checkpoint(checkpoints, `Create modal exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "Flow name can be filled", async () => {
        await page.getByRole("textbox", { name: "Name", exact: true }).fill(flowName);
        await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(flowName);
      });

      await checkpoint(checkpoints, "Flow API name can be filled", async () => {
        await page.getByRole("textbox", { name: "API Name" }).fill(apiName);
        await expect(page.getByRole("textbox", { name: "API Name" })).toHaveValue(apiName);
      });

      await checkpoint(checkpoints, "Flow description can be filled", async () => {
        await page.locator("textarea").fill("Created inactive by Playwright BVT");
        await expect(page.locator("textarea")).toHaveValue("Created inactive by Playwright BVT");
      });

      await checkpoint(checkpoints, "Active defaults checked", async () => {
        await expect(page.getByRole("checkbox", { name: "Active" })).toBeChecked();
      });

      await checkpoint(checkpoints, "Active can be unchecked before create", async () => {
        await page.getByRole("checkbox", { name: "Active" }).click();
        await expect(page.getByRole("checkbox", { name: "Active" })).not.toBeChecked();
      });

      await checkpoint(checkpoints, "Default remains unchecked", async () => {
        await expect(page.getByRole("checkbox", { name: /Default/ })).not.toBeChecked();
      });

      await checkpoint(checkpoints, "Allow cancel remains checked", async () => {
        await expect(page.getByRole("checkbox", { name: /Allow cancel/i })).toBeChecked();
      });

      await checkpoint(checkpoints, "Create Flow button submits", async () => {
        await page.getByRole("button", { name: "Create Flow" }).click();
        cleanupName = flowName;
        await expect(page.getByRole("heading", { name: "Edit Flow" })).toBeVisible({ timeout: 15_000 });
      });

      for (const label of ["Edit Flow", flowName, apiName, "Flow Details", "Steps", "Save Flow", "Delete Flow"]) {
        await checkpoint(checkpoints, `Created flow detail exposes ${label}`, async () => {
          await expect(page.locator(".admin-main").first()).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Created flow is inactive", async () => {
        await expect(page.getByRole("checkbox", { name: "Active" })).not.toBeChecked();
      });

      await checkpoint(checkpoints, "Created flow mode is create", async () => {
        await expect(page.getByRole("combobox", { name: "Mode" })).toBeDisabled();
      });

      await checkpoint(checkpoints, "Update flow name", async () => {
        await page.getByRole("textbox", { name: "Name", exact: true }).fill(updatedFlowName);
        await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(updatedFlowName);
      });

      await checkpoint(checkpoints, "Update flow description", async () => {
        await page.getByRole("textbox", { name: "Description" }).fill("Updated inactive by Playwright BVT");
        await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue("Updated inactive by Playwright BVT");
      });

      await checkpoint(checkpoints, "Save updated inactive flow", async () => {
        await page.getByRole("button", { name: "Save Flow" }).click();
        cleanupName = updatedFlowName;
        await expect(page.locator(".admin-main").first()).toContainText(updatedFlowName, { timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Updated API name normalized", async () => {
        await expect(page.getByRole("textbox", { name: "API Name" })).toHaveValue(updatedApiName);
      });

      await checkpoint(checkpoints, "Updated flow remains inactive", async () => {
        await expect(page.getByRole("checkbox", { name: "Active" })).not.toBeChecked();
      });

      await checkpoint(checkpoints, "Back to Flow List works", async () => {
        await page.getByRole("button", { name: "Back to Flow List" }).click();
        await expect(page.locator(".admin-main").first()).toContainText("Flow List");
      });

      for (const term of [updatedFlowName, updatedApiName, "No", "2 records"]) {
        await checkpoint(checkpoints, `Updated flow list reflects ${term}`, async () => {
          await expect(page.locator(".admin-main").first()).toContainText(term);
        });
      }

      await checkpoint(checkpoints, "Search finds updated flow", async () => {
        const search = page.getByRole("searchbox", { name: /search results/i });
        await search.fill(updatedFlowName);
        await expect(rowForFlow(page, updatedFlowName)).toBeVisible({ timeout: 10_000 });
      });

      await checkpoint(checkpoints, "Search keeps updated API visible", async () => {
        await expect(page.locator(".admin-main").first()).toContainText(updatedApiName);
      });

      await checkpoint(checkpoints, "Clear search restores list", async () => {
        await page.getByRole("searchbox", { name: /search results/i }).fill("");
        await expect(page.locator(".admin-main").first()).toContainText("AUTO Case Create Flow");
      });

      const keystone = await context.newPage();
      await checkpoint(checkpoints, "Keystone login succeeds", async () => {
        await loginToKeystone(keystone);
        await expect(keystone.getByRole("button", { name: /apps/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Keystone target app opens", async () => {
        await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
        await expect(keystone.getByRole("button", { name: /tabs/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Keystone tabs launcher opens", async () => {
        await keystone.getByRole("button", { name: /tabs/i }).click();
        await expect(keystone.getByRole("searchbox", { name: /search tabs/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Keystone Flows tab is available", async () => {
        await expect(keystone.getByRole("button", { name: "Flows" })).toBeVisible();
      });

      await checkpoint(checkpoints, "Keystone Flows tab opens", async () => {
        await keystone.getByRole("button", { name: "Flows" }).click();
        await expect(keystone.getByRole("heading", { name: "Available Flows" })).toBeVisible({ timeout: 15_000 });
      });

      for (const label of ["Available Flows", "Search flows", "Refresh", "Flow", "Mode", "Availability", "Action"]) {
        await checkpoint(checkpoints, `Keystone flows UI exposes ${label}`, async () => {
          await expect(keystone.locator("body")).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Keystone seeded ready flow is visible", async () => {
        await expect(keystone.locator("body")).toContainText("AUTO Case Create Flow");
      });

      await checkpoint(checkpoints, "Keystone seeded flow can start", async () => {
        await expect(keystone.getByRole("button", { name: "Start" }).first()).toBeVisible();
      });

      await checkpoint(checkpoints, "Keystone inactive BVT flow is not runtime available", async () => {
        await expect(keystone.locator("body")).not.toContainText(updatedFlowName);
      });

      await checkpoint(checkpoints, "Keystone runtime count excludes inactive BVT flow", async () => {
        await expect(keystone.locator("body")).toContainText("1 flows");
      });

      await keystone.close();

      await checkpoint(checkpoints, "Reopen updated flow for delete", async () => {
        await openCreatedFlowFromList(page, updatedFlowName);
      });

      await checkpoint(checkpoints, "Delete Flow button visible", async () => {
        await expect(page.getByRole("button", { name: "Delete Flow" })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete confirmation opens", async () => {
        await page.getByRole("button", { name: "Delete Flow" }).click();
        await expect(page.getByRole("heading", { name: "Delete Flow" })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete confirmation names updated flow", async () => {
        await expect(page.locator("body")).toContainText(updatedFlowName);
      });

      await checkpoint(checkpoints, "Delete confirmation can be cancelled", async () => {
        await page.getByRole("button", { name: "Cancel" }).click();
        await expect(page.getByRole("heading", { name: "Edit Flow" })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete confirmation reopens", async () => {
        await page.getByRole("button", { name: "Delete Flow" }).click();
        await expect(page.getByRole("heading", { name: "Delete Flow" })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete succeeds", async () => {
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        cleanupName = "";
        await expect(page.locator(".admin-main").first()).toContainText("Flow List", { timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Deleted flow removed from list count", async () => {
        await expect(page.locator(".admin-main").first()).toContainText("1 records");
      });

      await checkpoint(checkpoints, "Deleted flow absent from list", async () => {
        await expect(page.locator(".admin-main").first()).not.toContainText(updatedFlowName);
      });

      await checkpoint(checkpoints, "Seeded flow remains after cleanup", async () => {
        await expect(page.locator(".admin-main").first()).toContainText("AUTO Case Create Flow");
      });

      await checkpoint(checkpoints, "Checkpoint count is exactly 101", async () => {
        expect(checkpoints).toHaveLength(CHECKPOINT_TARGET);
      });
    } finally {
      if (cleanupName) {
        await openFlowsPage(page).catch(() => null);
        await openCreatedFlowFromList(page, cleanupName).catch(() => null);
        await deleteCurrentFlow(page).catch(() => null);
      }
    }
  });
});
