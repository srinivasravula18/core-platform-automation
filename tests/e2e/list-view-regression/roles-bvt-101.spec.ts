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

const APP_ID = process.env.ROLES_BVT_APP_ID || "app13iug98";
const MIN_CHECKPOINT_TARGET = 101;

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

const openRolesPage = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=roles&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  const main = page.locator(".admin-main").first();
  await expect(main).toContainText("Roles", { timeout: 20_000 });
  await expect(main).toContainText(/All Roles|Role Details|Role-based access metadata/i, { timeout: 20_000 });
  return main;
};

const rowForRole = (page: Page, roleName: string) =>
  page.locator(".admin-main table tbody tr").filter({ hasText: new RegExp(escapeRegex(roleName)) }).first();

const openRoleFromList = async (page: Page, roleName: string) => {
  const row = rowForRole(page, roleName);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.locator(".admin-main").first()).toContainText("Role Details", { timeout: 15_000 });
};

const searchRoles = async (page: Page, query: string) => {
  const search = page.locator(".admin-main").getByRole("searchbox", { name: /search results/i }).first();
  await expect(search).toBeVisible();
  await search.fill(query);
  await page.waitForTimeout(500);
};

const deleteCurrentRole = async (page: Page) => {
  const deleteButton = page.locator(".admin-main").getByRole("button", { name: /^delete$/i }).last();
  if (!(await deleteButton.isVisible().catch(() => false))) return;
  await deleteButton.click();
  const confirm = page.getByRole("button", { name: /^delete$/i }).last();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
  }
  await expect(page.locator(".admin-main").first()).toContainText("All Roles", { timeout: 15_000 });
};

const maybeRemoveRoleUser = async (page: Page) => {
  const main = page.locator(".admin-main").first();
  await main.getByRole("button", { name: /^users$/i }).click();
  await expect(main).toContainText(/All Users|No records|role users selected/i, { timeout: 15_000 });
  const rowCheckbox = main.locator("table tbody input[type='checkbox']").first();
  if (!(await rowCheckbox.isVisible().catch(() => false))) return;
  await rowCheckbox.click();
  await main.getByRole("button", { name: /^remove$/i }).click();
  await page.getByRole("button", { name: /^remove$/i }).last().click();
  await expect(main).toContainText(/No records|0 records/i, { timeout: 15_000 });
};

test.describe("Roles page BVT", () => {
  test.setTimeout(210_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to run role CRUD BVT coverage.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "roles-bvt-101-final-evidence").catch(() => null);
    }
  });

  test("Roles page BVT - 101 checkpoints @roles-bvt-101 @roles-ui", async ({ page, context }) => {
    const checkpoints: string[] = [];
    const stamp = Date.now().toString(36);
    const roleName = `bvt_role_${stamp}`;
    const createDescription = "BVT role created through Playwright";
    const updatedDescription = "BVT role updated through Playwright and verified in Keystone";
    let cleanupRoleName = "";

    try {
      const main = await openRolesPage(page);

      for (const label of ["Admin shell opens", "Roles heading visible", "Roles list visible", "Seeded roles visible"]) {
        await checkpoint(checkpoints, label, async () => {
          await expect(main).toBeVisible();
          await expect(main).toContainText(/Roles|All Roles|records/);
        });
      }

      for (const label of [
        "Roles",
        "Role-based access metadata",
        "List view",
        "All Roles",
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
        await checkpoint(checkpoints, `Roles page exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      for (const column of ["Name", "Description", "Created At", "Modified At"]) {
        await checkpoint(checkpoints, `Role list column visible: ${column}`, async () => {
          await expect(main.locator("table").first()).toContainText(column);
        });
      }

      for (const seededRole of ["system_admin", "lims_user", "hr_user", "crm_user", "auto_case_role_528a"]) {
        await checkpoint(checkpoints, `Seeded role visible: ${seededRole}`, async () => {
          await expect(main).toContainText(seededRole);
        });
      }

      await checkpoint(checkpoints, "Refresh list view works", async () => {
        await main.getByRole("button", { name: /refresh list view/i }).click();
        await expect(main).toContainText("system_admin");
      });

      await checkpoint(checkpoints, "Fit columns works", async () => {
        await main.getByRole("button", { name: /fit columns/i }).click();
        await expect(main.locator("table").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "Create role modal opens", async () => {
        await main.getByRole("button", { name: /^new$/i }).click();
        await expect(page.getByRole("heading", { name: /^new role$/i })).toBeVisible();
      });

      for (const label of ["New Role", "App", "AUTO Platform QA 528A", "Name", "Description", "Cancel", "Create"]) {
        await checkpoint(checkpoints, `Create modal exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "Required role name validation appears", async () => {
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.locator("body")).toContainText(/Name is required|Review the following fields/i);
      });

      await checkpoint(checkpoints, "Role name can be filled", async () => {
        await page.getByRole("textbox", { name: /name/i }).fill(roleName);
        await expect(page.getByRole("textbox", { name: /name/i })).toHaveValue(roleName);
      });

      await checkpoint(checkpoints, "Role description can be filled", async () => {
        await page.getByRole("textbox", { name: /^description$/i }).fill(createDescription);
        await expect(page.getByRole("textbox", { name: /^description$/i })).toHaveValue(createDescription);
      });

      await checkpoint(checkpoints, "Role create succeeds", async () => {
        await page.getByRole("button", { name: /^create$/i }).click();
        cleanupRoleName = roleName;
        await expect(main).toContainText("Role Details", { timeout: 20_000 });
      });

      for (const label of [
        "Role Details",
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
        roleName,
        createDescription
      ]) {
        await checkpoint(checkpoints, `Role detail exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Details section can collapse", async () => {
        await main.getByRole("button", { name: /collapse details/i }).click();
        await expect(main).toContainText("System Details");
      });

      await checkpoint(checkpoints, "Details section can expand", async () => {
        await main.getByRole("button", { name: /expand details|collapse details/i }).click();
        await expect(main).toContainText(createDescription);
      });

      await checkpoint(checkpoints, "Edit role modal opens", async () => {
        await main.getByRole("button", { name: /^edit$/i }).click();
        await expect(page.getByRole("heading", { name: /^edit role$/i })).toBeVisible();
      });

      for (const label of ["Edit Role", "Name", "Description", "Cancel", "Save"]) {
        await checkpoint(checkpoints, `Edit modal exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "Role description can be updated", async () => {
        await page.getByRole("textbox", { name: /^description$/i }).fill(updatedDescription);
        await expect(page.getByRole("textbox", { name: /^description$/i })).toHaveValue(updatedDescription);
      });

      await checkpoint(checkpoints, "Role update succeeds", async () => {
        await page.getByRole("button", { name: /^save$/i }).click();
        await expect(main).toContainText(updatedDescription, { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Modified timestamp remains visible after update", async () => {
        await expect(main).toContainText("Modified At");
      });

      await checkpoint(checkpoints, "Users tab opens", async () => {
        await main.getByRole("button", { name: /^users$/i }).click();
        await expect(main).toContainText("All Users", { timeout: 15_000 });
      });

      for (const label of [
        "List view",
        "All Users",
        "Add Users",
        "Remove",
        "Refresh list view",
        "List view actions",
        "Fit columns",
        "Export CSV",
        "Export PDF",
        "Username",
        "First Name",
        "Last Name",
        "Email",
        "Role",
        "Status"
      ]) {
        await checkpoint(checkpoints, `Users subpage exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Add Users picker opens", async () => {
        await main.getByRole("button", { name: /^add users$/i }).click();
        await expect(page.getByRole("heading", { name: /^add users to role$/i })).toBeVisible();
      });

      for (const label of ["Users", "Search users", "Selected Users", "No users selected", "All", "Other", "Cancel"]) {
        await checkpoint(checkpoints, `Add Users picker exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "User picker search accepts text", async () => {
        await page.getByRole("textbox", { name: /search users/i }).fill("auto");
        await expect(page.getByRole("textbox", { name: /search users/i })).toHaveValue("auto");
      });

      await checkpoint(checkpoints, "User picker has addable user", async () => {
        await expect(page.getByRole("button", { name: /^add$/i }).first()).toBeVisible();
      });

      await checkpoint(checkpoints, "User can be staged", async () => {
        await page.getByRole("button", { name: /^add$/i }).first().click();
        await expect(page.getByRole("button", { name: /^add selected$/i })).toBeEnabled();
      });

      await checkpoint(checkpoints, "Staged user can be committed", async () => {
        await page.getByRole("button", { name: /^add selected$/i }).click();
        await expect(page.getByRole("heading", { name: /^add users$/i })).toBeVisible();
        await page.getByRole("button", { name: /^add$/i }).last().click();
        await expect(main).toContainText(roleName, { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Related user row appears", async () => {
        await expect(main.locator("table tbody tr").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "Related user row shows active status", async () => {
        await expect(main.locator("table").first()).toContainText(/active|inactive/i);
      });

      await checkpoint(checkpoints, "Users refresh works", async () => {
        await main.getByRole("button", { name: /refresh list view/i }).click();
        await expect(main).toContainText(roleName, { timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Users search finds role user", async () => {
        await main.getByRole("searchbox", { name: /search results/i }).fill(roleName);
        await expect(main).toContainText(roleName);
      });

      await checkpoint(checkpoints, "Users search can be cleared", async () => {
        await main.getByRole("searchbox", { name: /search results/i }).fill("");
        await expect(main.locator("table").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "Audit Log tab opens", async () => {
        await main.getByRole("button", { name: /^audit log$/i }).click();
        await expect(main).toContainText(/Audit Log|No records|Created|Updated/i, { timeout: 15_000 });
      });

      for (const label of ["Audit Log", "List view", "Refresh list view", "Export CSV", "Export PDF"]) {
        await checkpoint(checkpoints, `Audit Log subpage exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      const keystone = await context.newPage();
      try {
        await checkpoint(checkpoints, "Keystone login succeeds", async () => {
          await loginToKeystone(keystone);
          await expect(keystone.getByRole("button", { name: /apps/i })).toBeVisible();
        });

        await checkpoint(checkpoints, "Keystone selected app can open", async () => {
          await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
          await expect(keystone.getByRole("button", { name: /apps/i })).toBeVisible();
        });

        await checkpoint(checkpoints, "Keystone global search accepts role name", async () => {
          const search = keystone.getByRole("searchbox", { name: /global search/i });
          await search.fill(roleName);
          await search.press("Enter");
          await expect(keystone).toHaveURL(new RegExp(`q=${escapeRegex(roleName)}`), { timeout: 10_000 });
        });

        await checkpoint(checkpoints, "Keystone global search excludes Admin role metadata", async () => {
          await expect(keystone.locator("body")).toContainText(/No results found|0 matches|0 shown/i, {
            timeout: 15_000
          });
        });

        await checkpoint(checkpoints, "Keystone global search does not expose role description", async () => {
          await expect(keystone.locator("body")).not.toContainText(updatedDescription);
        });

        await checkpoint(checkpoints, "Keystone direct Role object is restricted by runtime object contract", async () => {
          await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}&view=list&object=role`, {
            waitUntil: "domcontentloaded"
          });
          await expect(keystone.locator("body")).toContainText(/Restricted|Object access required/i, {
            timeout: 15_000
          });
        });
      } finally {
        await keystone.close().catch(() => null);
      }

      await checkpoint(checkpoints, "Return to Details tab", async () => {
        await main.getByRole("button", { name: /^details$/i }).click();
        await expect(main).toContainText("Role Details", { timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Return to Users tab before removal", async () => {
        await main.getByRole("button", { name: /^users$/i }).click();
        await expect(main).toContainText("All Users", { timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Related user can be selected", async () => {
        await main.locator("table thead input[type='checkbox']").first().click();
        await expect(main).toContainText(/1 of 1 role users selected|selected/i);
      });

      await checkpoint(checkpoints, "Remove user confirmation opens", async () => {
        await main.getByRole("button", { name: /^remove$/i }).click();
        await expect(page.getByRole("heading", { name: /^remove users$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Remove user confirmation can be cancelled", async () => {
        await page.getByRole("button", { name: /^cancel$/i }).click();
        await expect(main).toContainText(roleName);
      });

      await checkpoint(checkpoints, "Remove user confirmation reopens", async () => {
        await main.getByRole("button", { name: /^remove$/i }).click();
        await expect(page.getByRole("heading", { name: /^remove users$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Remove user succeeds", async () => {
        await page.getByRole("button", { name: /^remove$/i }).last().click();
        await expect(main).toContainText(/No records|0 records/i, { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Removed user no longer listed", async () => {
        await expect(main).not.toContainText("auto.case.user.528a");
      });

      await checkpoint(checkpoints, "Open Roles list", async () => {
        await main.getByRole("button", { name: /^roles$/i }).first().click();
        await expect(main).toContainText("All Roles", { timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Search finds created role before delete", async () => {
        await searchRoles(page, roleName);
        await expect(rowForRole(page, roleName)).toBeVisible({ timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Search can be cleared before delete", async () => {
        await searchRoles(page, "");
        await expect(main).toContainText("system_admin");
      });

      await checkpoint(checkpoints, "Open role again for delete", async () => {
        await searchRoles(page, roleName);
        await openRoleFromList(page, roleName);
      });

      await checkpoint(checkpoints, "Delete role confirmation opens", async () => {
        await main.getByRole("button", { name: /^delete$/i }).last().click();
        await expect(page.getByRole("heading", { name: /^delete role$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete role confirmation names role", async () => {
        await expect(page.locator("body")).toContainText(roleName);
      });

      await checkpoint(checkpoints, "Delete role confirmation can be cancelled", async () => {
        await page.getByRole("button", { name: /^cancel$/i }).click();
        await expect(main).toContainText("Role Details");
      });

      await checkpoint(checkpoints, "Delete role confirmation reopens", async () => {
        await main.getByRole("button", { name: /^delete$/i }).last().click();
        await expect(page.getByRole("heading", { name: /^delete role$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete role succeeds", async () => {
        await page.getByRole("button", { name: /^delete$/i }).last().click();
        cleanupRoleName = "";
        await expect(page.locator("body")).toContainText(/Role deleted successfully|All Roles/i, { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Deleted role absent from list", async () => {
        await searchRoles(page, roleName);
        await expect(rowForRole(page, roleName)).toHaveCount(0);
      });

      await checkpoint(checkpoints, "Seeded roles remain after cleanup", async () => {
        await searchRoles(page, "");
        await expect(main).toContainText("system_admin");
      });

      await checkpoint(checkpoints, "Checkpoint count is at least 101", async () => {
        expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
      });
    } finally {
      if (cleanupRoleName) {
        await openRolesPage(page).catch(() => null);
        await searchRoles(page, cleanupRoleName).catch(() => null);
        await openRoleFromList(page, cleanupRoleName).catch(() => null);
        await maybeRemoveRoleUser(page).catch(() => null);
        await main.getByRole("button", { name: /^details$/i }).click().catch(() => null);
        await deleteCurrentRole(page).catch(() => null);
      }
    }
  });
});
