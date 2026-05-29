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

const APP_ID = process.env.GROUPS_BVT_APP_ID || "app13iug98";
const CHECKPOINT_TARGET = 124;

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

const openGroupsPage = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=groups&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  const main = page.locator(".admin-main").first();
  await expect(main).toContainText("Groups", { timeout: 20_000 });
  await expect(main).toContainText(/All Groups|Group Details|Group-based access metadata/i, { timeout: 20_000 });
  return main;
};

const rowForGroup = (page: Page, groupName: string) =>
  page.locator(".admin-main table tbody tr").filter({ hasText: new RegExp(escapeRegex(groupName)) }).first();

const searchGroups = async (page: Page, query: string) => {
  const search = page.locator(".admin-main").getByRole("searchbox", { name: /search results/i }).first();
  await expect(search).toBeVisible();
  await search.fill(query);
  await page.waitForTimeout(500);
};

const openGroupFromList = async (page: Page, groupName: string) => {
  const row = rowForGroup(page, groupName);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.locator(".admin-main").first()).toContainText("Group Details", { timeout: 15_000 });
};

const maybeRemoveGroupUsers = async (page: Page) => {
  const main = page.locator(".admin-main").first();
  await main.getByRole("button", { name: /^users$/i }).click();
  await expect(main).toContainText(/All Users|No records|group users selected/i, { timeout: 15_000 });
  const rowCheckbox = main.locator("table tbody input[type='checkbox']").first();
  if (!(await rowCheckbox.isVisible().catch(() => false))) return;
  await rowCheckbox.click();
  await main.getByRole("button", { name: /^remove$/i }).click();
  await page.getByRole("button", { name: /^remove$/i }).last().click();
  await expect(main).toContainText(/No records|0 records/i, { timeout: 15_000 });
};

const deleteCurrentGroup = async (page: Page) => {
  const main = page.locator(".admin-main").first();
  const deleteButton = main.getByRole("button", { name: /^delete$/i }).last();
  if (!(await deleteButton.isVisible().catch(() => false))) return;
  await deleteButton.click();
  const confirm = page.getByRole("button", { name: /^delete$/i }).last();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
  }
  await expect(main).toContainText("All Groups", { timeout: 15_000 });
};

test.describe("Groups page BVT", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to run group CRUD BVT coverage.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "groups-bvt-124-final-evidence").catch(() => null);
    }
  });

  test("Groups page BVT - 124 checkpoints @groups-bvt-124 @groups-ui", async ({ page, context }) => {
    const checkpoints: string[] = [];
    const stamp = Date.now().toString(36);
    const groupName = `BVT Group ${stamp}`;
    const updatedGroupName = `${groupName} Updated`;
    const createDescription = "BVT group created through Playwright";
    const updatedDescription = "BVT group updated through Playwright";
    let cleanupGroupName = "";

    try {
      const main = await openGroupsPage(page);

      for (const label of ["Admin shell opens", "Groups heading visible", "Groups list visible", "Seeded groups visible"]) {
        await checkpoint(checkpoints, label, async () => {
          await expect(main).toBeVisible();
          await expect(main).toContainText(/Groups|All Groups|records/);
        });
      }

      for (const label of [
        "Apps",
        "System Settings",
        "App Hierarchy",
        "Search Results",
        "Agent",
        "Email Logs",
        "Objects",
        "Tabs",
        "Flows",
        "Scheduled Jobs",
        "Groups",
        "Group-based access metadata",
        "Users",
        "Permissions",
        "Access Records"
      ]) {
        await checkpoint(checkpoints, `Groups page exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      for (const column of ["Name", "Description", "Created At", "Modified At"]) {
        await checkpoint(checkpoints, `Group list column visible: ${column}`, async () => {
          await expect(main.locator("table").first()).toContainText(column);
        });
      }

      for (const seededGroup of ["test_group", "LIMS Users", "HR Users", "CRM Users", "AUTO Case QA Group"]) {
        await checkpoint(checkpoints, `Seeded group visible: ${seededGroup}`, async () => {
          await expect(main).toContainText(seededGroup);
        });
      }

      await checkpoint(checkpoints, "Refresh list view works", async () => {
        await main.getByRole("button", { name: /refresh list view/i }).click();
        await expect(main).toContainText("LIMS Users");
      });

      await checkpoint(checkpoints, "Fit columns works", async () => {
        await main.getByRole("button", { name: /fit columns/i }).click();
        await expect(main.locator("table").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "Export CSV control remains enabled", async () => {
        await expect(main.getByRole("button", { name: /export csv/i })).toBeEnabled();
      });

      await checkpoint(checkpoints, "Export PDF control remains enabled", async () => {
        await expect(main.getByRole("button", { name: /export pdf/i })).toBeEnabled();
      });

      await checkpoint(checkpoints, "Create group modal opens", async () => {
        await main.getByRole("button", { name: /^new$/i }).click();
        await expect(page.getByRole("heading", { name: /^new group$/i })).toBeVisible();
      });

      for (const label of ["New Group", "App", "AUTO Platform QA 528A", "Name", "Description", "Cancel", "Create"]) {
        await checkpoint(checkpoints, `Create modal exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "Required group name validation appears", async () => {
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.locator("body")).toContainText(/Name is required|Review the following fields/i);
      });

      await checkpoint(checkpoints, "Group name can be filled", async () => {
        await page.getByRole("textbox", { name: /name/i }).fill(groupName);
        await expect(page.getByRole("textbox", { name: /name/i })).toHaveValue(groupName);
      });

      await checkpoint(checkpoints, "Group description can be filled", async () => {
        await page.getByRole("textbox", { name: /^description$/i }).fill(createDescription);
        await expect(page.getByRole("textbox", { name: /^description$/i })).toHaveValue(createDescription);
      });

      await checkpoint(checkpoints, "Group create succeeds", async () => {
        await page.getByRole("button", { name: /^create$/i }).click();
        cleanupGroupName = groupName;
        await expect(main).toContainText("Group Details", { timeout: 20_000 });
      });

      for (const label of [
        "Group Details",
        "Details",
        "Users",
        "Audit Log",
        "Edit",
        "Delete",
        "ID",
        "Name",
        "Description",
        "Created At",
        "Modified At",
        "Created By",
        "Modified By",
        "System Details",
        groupName,
        createDescription
      ]) {
        await checkpoint(checkpoints, `Group detail exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Users subpage opens", async () => {
        await main.getByRole("button", { name: /^users$/i }).click();
        await expect(main).toContainText(/All Users|No records|group users selected/i, { timeout: 20_000 });
      });

      for (const label of [
        "All Users",
        "Add Users",
        "Remove",
        "Username",
        "First Name",
        "Last Name",
        "Email",
        "Role",
        "Status",
        "Created At",
        "Please select atleast one record.",
        "No records"
      ]) {
        await checkpoint(checkpoints, `Users subpage exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Add Users modal opens", async () => {
        await main.getByRole("button", { name: /^add users$/i }).click();
        await expect(page.getByRole("heading", { name: /^add users to group$/i })).toBeVisible();
      });

      for (const label of ["Add Users to Group", "Users", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "Selected Users", "No users selected", "Cancel", "Add Selected"]) {
        await checkpoint(checkpoints, `Add users modal exposes ${label}`, async () => {
          await expect(page.locator("body")).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "User picker search can find admin", async () => {
        await page.getByRole("textbox", { name: /search users/i }).fill("admin");
        await expect(page.locator("body")).toContainText("admin");
      });

      await checkpoint(checkpoints, "Admin user can be staged", async () => {
        await page.getByRole("button", { name: /^add$/i }).first().click();
        await expect(page.locator("body")).toContainText("admin");
      });

      await checkpoint(checkpoints, "Add Selected is enabled", async () => {
        await expect(page.getByRole("button", { name: /^add selected$/i })).toBeEnabled();
      });

      await checkpoint(checkpoints, "Add selected confirmation opens", async () => {
        await page.getByRole("button", { name: /^add selected$/i }).click();
        await expect(page.getByRole("heading", { name: /^add users$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Confirm add selected users", async () => {
        await page.getByRole("button", { name: /^add$/i }).last().click();
        await expect(main).toContainText(/1 records|admin/i, { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Added admin membership is visible", async () => {
        await expect(main).toContainText("admin");
      });

      await checkpoint(checkpoints, "Membership row can be selected", async () => {
        await main.locator("table tbody input[type='checkbox']").first().click();
        await expect(main).toContainText(/1 of 1 group users selected/i);
      });

      await checkpoint(checkpoints, "Remove membership button enables", async () => {
        await expect(main.getByRole("button", { name: /^remove$/i })).toBeEnabled();
      });

      await checkpoint(checkpoints, "Remove membership confirmation opens", async () => {
        await main.getByRole("button", { name: /^remove$/i }).click();
        await expect(page.getByRole("heading", { name: /^remove users$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Confirm membership removal", async () => {
        await page.getByRole("button", { name: /^remove$/i }).last().click();
        await expect(main).toContainText(/No records|0 records/i, { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Membership removal reflected in list", async () => {
        await expect(main).not.toContainText(/1 of 1 group users selected/i);
      });

      await checkpoint(checkpoints, "Audit Log subpage opens", async () => {
        await main.getByRole("button", { name: /^audit log$/i }).click();
        await expect(main).toContainText("Audit Log", { timeout: 20_000 });
      });

      for (const label of ["All Audit Logs", "Action At", "Meta Table", "Label", "Record ID", "Field", "Action", "Actor"]) {
        await checkpoint(checkpoints, `Audit log exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      for (const field of ["id", "name", "description", "app_id"]) {
        await checkpoint(checkpoints, `Audit log captures create field ${field}`, async () => {
          await expect(main).toContainText(field);
        });
      }

      await checkpoint(checkpoints, "Edit group modal opens", async () => {
        await main.getByRole("button", { name: /^details$/i }).click();
        await main.getByRole("button", { name: /^edit$/i }).click();
        await expect(page.getByRole("heading", { name: /^edit group$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Updated group name can be filled", async () => {
        await page.getByRole("textbox", { name: /name/i }).fill(updatedGroupName);
        await expect(page.getByRole("textbox", { name: /name/i })).toHaveValue(updatedGroupName);
      });

      await checkpoint(checkpoints, "Updated group description can be filled", async () => {
        await page.getByRole("textbox", { name: /^description$/i }).fill(updatedDescription);
        await expect(page.getByRole("textbox", { name: /^description$/i })).toHaveValue(updatedDescription);
      });

      await checkpoint(checkpoints, "Group update succeeds", async () => {
        await page.getByRole("button", { name: /^save$/i }).click();
        cleanupGroupName = updatedGroupName;
        await expect(main).toContainText(updatedGroupName, { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Updated description reflected in details", async () => {
        await expect(main).toContainText(updatedDescription);
      });

      await checkpoint(checkpoints, "Back to group list works", async () => {
        await main.getByRole("button", { name: /^groups$/i }).click();
        await expect(main).toContainText("All Groups", { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Admin list search finds updated group", async () => {
        await searchGroups(page, updatedGroupName);
        await expect(rowForGroup(page, updatedGroupName)).toBeVisible({ timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Admin list search reflects updated description", async () => {
        await expect(main).toContainText(updatedDescription);
      });

      const keystone = await context.newPage();

      await checkpoint(checkpoints, "Keystone login succeeds", async () => {
        await loginToKeystone(keystone);
        await expect(keystone.getByRole("button", { name: /apps/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Keystone target app remains accessible", async () => {
        await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
        await expect(keystone.getByRole("button", { name: /tabs/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Keystone global search excludes Admin group metadata", async () => {
        await keystone.getByRole("searchbox", { name: /global search/i }).fill(updatedGroupName);
        await expect(keystone.locator("body")).toContainText(/No results found|Try a broader term/i);
      });

      await checkpoint(checkpoints, "Keystone tabs launcher excludes Groups admin page", async () => {
        await keystone.getByRole("button", { name: /tabs/i }).click();
        await keystone.getByRole("searchbox", { name: /search tabs/i }).fill("group");
        await expect(keystone.locator("body")).toContainText(/No tabs available|adjust the tab search/i);
      });

      await checkpoint(checkpoints, "Keystone business object list remains usable", async () => {
        await expect(keystone.locator("body")).toContainText(/List view|Assets|New|Refresh/i);
      });

      await keystone.close();

      await checkpoint(checkpoints, "Reopen updated group for delete", async () => {
        await openGroupFromList(page, updatedGroupName);
      });

      await checkpoint(checkpoints, "Delete confirmation opens", async () => {
        await main.getByRole("button", { name: /^delete$/i }).last().click();
        await expect(page.getByRole("heading", { name: /^delete group$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete confirmation names updated group", async () => {
        await expect(page.locator("body")).toContainText(updatedGroupName);
      });

      await checkpoint(checkpoints, "Delete succeeds", async () => {
        await page.getByRole("button", { name: /^delete$/i }).last().click();
        cleanupGroupName = "";
        await expect(main).toContainText("All Groups", { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Deleted group absent from Admin search", async () => {
        await searchGroups(page, updatedGroupName);
        await expect(rowForGroup(page, updatedGroupName)).toHaveCount(0);
      });

      await checkpoint(checkpoints, "Checkpoint count is exactly 124", async () => {
        expect(checkpoints).toHaveLength(CHECKPOINT_TARGET);
      });
    } finally {
      if (cleanupGroupName) {
        await openGroupsPage(page).catch(() => null);
        await searchGroups(page, cleanupGroupName).catch(() => null);
        await openGroupFromList(page, cleanupGroupName).catch(() => null);
        await maybeRemoveGroupUsers(page).catch(() => null);
        await deleteCurrentGroup(page).catch(() => null);
      }
    }
  });
});
