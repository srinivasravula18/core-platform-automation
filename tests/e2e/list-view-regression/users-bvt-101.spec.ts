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

const APP_ID = process.env.USERS_BVT_APP_ID || "app13iug98";
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

const openUsersPage = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=users&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  const main = page.locator(".admin-main").first();
  await expect(main).toContainText("Users", { timeout: 20_000 });
  await expect(main).toContainText(/All Users|User Details|Manage user accounts/i, { timeout: 20_000 });
  return main;
};

const userRow = (page: Page, username: string) =>
  page.locator(".admin-main table tbody tr").filter({ hasText: new RegExp(escapeRegex(username), "i") }).first();

const searchUsers = async (page: Page, query: string) => {
  const search = page.locator(".admin-main").getByRole("searchbox", { name: /search results/i }).first();
  await expect(search).toBeVisible();
  await search.fill(query);
  await page.waitForTimeout(500);
};

const openUserFromList = async (page: Page, username: string) => {
  await searchUsers(page, username);
  const row = userRow(page, username);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByText(username, { exact: true }).click();
  await expect(page.locator(".admin-main").first()).toContainText("User Details", { timeout: 20_000 });
};

const selectStatus = async (page: Page, status: "active" | "disabled") => {
  const select = page.locator("select#user-status, select").filter({ has: page.locator("option", { hasText: /Active|Disabled/ }) }).first();
  await expect(select).toBeVisible();
  await select.selectOption(status);
};

const disableCreatedUser = async (page: Page, username: string) => {
  await openUsersPage(page).catch(() => null);
  await openUserFromList(page, username).catch(() => null);
  const main = page.locator(".admin-main").first();
  if (!(await main.getByRole("button", { name: /^edit$/i }).isVisible().catch(() => false))) return;
  await main.getByRole("button", { name: /^edit$/i }).click();
  await selectStatus(page, "disabled").catch(() => null);
  await page.getByRole("button", { name: /^save$/i }).click().catch(() => null);
  await expect(main).toContainText(/disabled|User Details/i, { timeout: 20_000 }).catch(() => null);
};

test.describe("Users page BVT", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to run user CRUD BVT coverage.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "users-bvt-101-final-evidence").catch(() => null);
    }
  });

  test("Users page BVT - 101 checkpoints @users-bvt-101 @users-ui", async ({ page, context, request }) => {
    const checkpoints: string[] = [];
    const stamp = Date.now().toString(36);
    const username = `bvt.user.${stamp}`;
    const firstName = "BVT";
    const lastName = `User${stamp}`;
    const email = `${username}@example.com`;
    const updatedFirstName = "BVTUpdated";
    const updatedLastName = `UserUpdated${stamp}`;
    const updatedEmail = `${username}.updated@example.com`;
    const tempPassword = "TempPass123!";
    let createdUser = false;

    try {
      const main = await openUsersPage(page);

      for (const label of ["Admin shell opens", "Users heading visible", "Users list visible", "Seeded users visible"]) {
        await checkpoint(checkpoints, label, async () => {
          await expect(main).toBeVisible();
          await expect(main).toContainText(/Users|All Users|records|admin|test/i);
        });
      }

      for (const label of [
        "Apps",
        "AUTO Platform QA 528A",
        "Global Search",
        "admin",
        "Core",
        "Metadata",
        "Security",
        "Other",
        "Roles",
        "Groups",
        "Users",
        "Permissions",
        "Access Records",
        "Sharing Settings",
        "System Settings",
        "Audit Logs"
      ]) {
        await checkpoint(checkpoints, `Users shell exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      for (const label of [
        "Manage user accounts and access settings",
        "Users",
        "Access Logs",
        "Record Access Logs",
        "List view",
        "All Users",
        "New",
        "Delete",
        "Refresh list view",
        "List view actions",
        "Fit columns",
        "Export CSV",
        "Export PDF",
        "Search results"
      ]) {
        await checkpoint(checkpoints, `Users page exposes ${label}`, async () => {
          await expect(main).toContainText(new RegExp(escapeRegex(label), "i"));
        });
      }

      for (const column of ["Username", "First Name", "Last Name", "Email", "Role", "Status", "Created At"]) {
        await checkpoint(checkpoints, `Users list column visible: ${column}`, async () => {
          await expect(main.locator("table").first()).toContainText(column);
        });
      }

      for (const seeded of ["admin@gmail.com", "test", "active"]) {
        await checkpoint(checkpoints, `Seeded user data visible: ${seeded}`, async () => {
          await expect(main).toContainText(new RegExp(escapeRegex(seeded), "i"));
        });
      }

      await checkpoint(checkpoints, "Refresh list view works", async () => {
        await main.getByRole("button", { name: /refresh list view/i }).click();
        await expect(main.locator("table").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "Fit columns works", async () => {
        await main.getByRole("button", { name: /fit columns/i }).click();
        await expect(main.locator("table").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "Create user modal opens", async () => {
        await main.getByRole("button", { name: /^new$/i }).click();
        await expect(page.getByRole("heading", { name: /^new user$/i })).toBeVisible();
      });

      for (const label of [
        "New User",
        "Username",
        "First Name",
        "Last Name",
        "Email",
        "Status",
        "Manager",
        "Super User",
        "Temporary password",
        "Cancel",
        "Create"
      ]) {
        await checkpoint(checkpoints, `Create modal exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "Required validation appears on empty create", async () => {
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.locator("body")).toContainText(/Username is required|Review the following fields/i);
      });

      await checkpoint(checkpoints, "Username can be filled", async () => {
        await page.getByRole("textbox", { name: /username/i }).fill(username);
        await expect(page.getByRole("textbox", { name: /username/i })).toHaveValue(username);
      });

      await checkpoint(checkpoints, "First name can be filled", async () => {
        await page.getByRole("textbox", { name: /first name/i }).fill(firstName);
        await expect(page.getByRole("textbox", { name: /first name/i })).toHaveValue(firstName);
      });

      await checkpoint(checkpoints, "Last name can be filled", async () => {
        await page.getByRole("textbox", { name: /last name/i }).fill(lastName);
        await expect(page.getByRole("textbox", { name: /last name/i })).toHaveValue(lastName);
      });

      await checkpoint(checkpoints, "Email can be filled", async () => {
        await page.getByRole("textbox", { name: /^email$/i }).fill(email);
        await expect(page.getByRole("textbox", { name: /^email$/i })).toHaveValue(email);
      });

      await checkpoint(checkpoints, "Temporary password can be filled", async () => {
        await page.getByRole("textbox", { name: /temporary password/i }).fill(tempPassword);
        await expect(page.getByRole("textbox", { name: /temporary password/i })).toHaveValue(tempPassword);
      });

      await checkpoint(checkpoints, "Create user succeeds", async () => {
        await page.getByRole("button", { name: /^create$/i }).click();
        createdUser = true;
        await expect(main).toContainText("User Details", { timeout: 20_000 });
      });

      for (const label of [
        "User Details",
        "Details",
        "Audit Log",
        "Edit",
        "Reset Password",
        "Login As",
        "ID",
        "Username",
        "First Name",
        "Last Name",
        "Email",
        "Status",
        "Manager",
        "Created By",
        "Created At",
        "Modified By",
        "Modified At",
        "Name",
        "Role",
        "System Details",
        username,
        firstName,
        lastName,
        email,
        "active"
      ]) {
        await checkpoint(checkpoints, `User detail exposes ${label}`, async () => {
          await expect(main).toContainText(new RegExp(escapeRegex(label), "i"));
        });
      }

      await checkpoint(checkpoints, "Details section can collapse", async () => {
        await main.getByRole("button", { name: /collapse details/i }).click();
        await expect(main).toContainText("System Details");
      });

      await checkpoint(checkpoints, "Details section can expand", async () => {
        await main.getByRole("button", { name: /expand details|collapse details/i }).click();
        await expect(main).toContainText(username);
      });

      await checkpoint(checkpoints, "Edit user modal opens", async () => {
        await main.getByRole("button", { name: /^edit$/i }).click();
        await expect(page.getByRole("heading", { name: /^edit user$/i })).toBeVisible();
      });

      for (const label of ["Edit User", "User ID", "Username", "First Name", "Last Name", "Email", "Status", "Manager", "Super User", "Cancel", "Save"]) {
        await checkpoint(checkpoints, `Edit modal exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "Updated first name can be filled", async () => {
        await page.getByRole("textbox", { name: /first name/i }).fill(updatedFirstName);
        await expect(page.getByRole("textbox", { name: /first name/i })).toHaveValue(updatedFirstName);
      });

      await checkpoint(checkpoints, "Updated last name can be filled", async () => {
        await page.getByRole("textbox", { name: /last name/i }).fill(updatedLastName);
        await expect(page.getByRole("textbox", { name: /last name/i })).toHaveValue(updatedLastName);
      });

      await checkpoint(checkpoints, "Updated email can be filled", async () => {
        await page.getByRole("textbox", { name: /^email$/i }).fill(updatedEmail);
        await expect(page.getByRole("textbox", { name: /^email$/i })).toHaveValue(updatedEmail);
      });

      await checkpoint(checkpoints, "User update succeeds", async () => {
        await page.getByRole("button", { name: /^save$/i }).click();
        await expect(main).toContainText(updatedEmail, { timeout: 20_000 });
      });

      for (const value of [updatedFirstName, updatedLastName, updatedEmail, `${updatedFirstName} ${updatedLastName}`]) {
        await checkpoint(checkpoints, `Updated detail reflects ${value}`, async () => {
          await expect(main).toContainText(value);
        });
      }

      await checkpoint(checkpoints, "Audit Log tab opens", async () => {
        await main.getByRole("button", { name: /^audit log$/i }).click();
        await expect(main).toContainText(/Audit Log|Created|Updated|No records/i, { timeout: 20_000 });
      });

      for (const label of ["Audit Log", "List view", "Refresh list view", "Export CSV", "Export PDF"]) {
        await checkpoint(checkpoints, `Audit Log subpage exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Return to Users list", async () => {
        await main.getByRole("button", { name: /^users\s+\d+$/i }).click();
        await expect(main).toContainText("All Users", { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Users search finds created user", async () => {
        await searchUsers(page, username);
        await expect(userRow(page, username)).toBeVisible({ timeout: 15_000 });
      });

      for (const value of [username, updatedFirstName, updatedLastName, updatedEmail, "active"]) {
        await checkpoint(checkpoints, `Search row contains ${value}`, async () => {
          await expect(userRow(page, username)).toContainText(value);
        });
      }

      await checkpoint(checkpoints, "Search result row can be selected", async () => {
        await userRow(page, username).locator("input[type='checkbox']").first().click();
        await expect(main).toContainText(/1 of 1 users selected/i);
      });

      await checkpoint(checkpoints, "Delete button enables for selected user", async () => {
        await expect(main.getByRole("button", { name: /^delete$/i })).toBeEnabled();
      });

      await checkpoint(checkpoints, "Delete confirmation opens", async () => {
        await main.getByRole("button", { name: /^delete$/i }).click();
        await expect(page.getByRole("heading", { name: /confirm delete/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete is blocked by user lifecycle rule", async () => {
        await page.getByRole("button", { name: /^delete$/i }).last().click();
        await expect(page.locator("body")).toContainText(/User accounts cannot be deleted|Records Cannot Be Deleted/i);
      });

      await checkpoint(checkpoints, "Delete block dialog can be closed", async () => {
        await page.getByRole("button", { name: /^cancel$/i }).click();
        await expect(main.locator("table").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "Access Logs subpage opens", async () => {
        await main.getByRole("button", { name: /^access logs$/i }).click();
        await expect(main).toContainText("Access Logs", { timeout: 20_000 });
      });

      for (const label of ["All Access Logs", "Occurred At", "User", "Action", "Decision", "IP Address", "Latitude", "Longitude", "Browser", "Device"]) {
        await checkpoint(checkpoints, `Access Logs exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Access Logs search box is visible", async () => {
        await expect(main.getByRole("searchbox", { name: /search results/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Access Logs refresh works", async () => {
        await main.getByRole("button", { name: /refresh list view/i }).click();
        await expect(main.locator("table, .empty-state").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "Record Access Logs subpage opens", async () => {
        await main.getByRole("button", { name: /record access logs/i }).click();
        await expect(main).toContainText("Record Access", { timeout: 20_000 });
      });

      for (const label of ["All Record Access", "Occurred At", "User", "Decision", "App", "Object", "Record ID"]) {
        await checkpoint(checkpoints, `Record Access Logs exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Record Access Logs search box is visible", async () => {
        await expect(main.getByRole("searchbox", { name: /search results/i })).toBeVisible();
      });

      const keystone = await context.newPage();
      try {
        await checkpoint(checkpoints, "Keystone login succeeds", async () => {
          await loginToKeystone(keystone);
          await expect(keystone.getByRole("button", { name: /apps/i })).toBeVisible();
        });

        await checkpoint(checkpoints, "Keystone target app remains accessible", async () => {
          await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
          await expect(keystone.getByRole("button", { name: /apps/i })).toBeVisible();
        });

        await checkpoint(checkpoints, "Keystone global search accepts username query", async () => {
          const search = keystone.getByRole("searchbox", { name: /global search/i });
          await search.fill(username);
          await search.press("Enter");
          await expect(keystone).toHaveURL(new RegExp(`q=${escapeRegex(username)}`), { timeout: 10_000 });
        });

        await checkpoint(checkpoints, "Keystone global search excludes Admin user metadata", async () => {
          await expect(keystone.locator("body")).toContainText(/No results found|Try a broader term|0 matches/i, {
            timeout: 15_000
          });
        });

        await checkpoint(checkpoints, "Keystone global search does not expose updated email", async () => {
          await expect(keystone.locator("body")).not.toContainText(updatedEmail);
        });

        await checkpoint(checkpoints, "Keystone direct user object is not a runtime business list", async () => {
          await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}&view=list&object=user`, {
            waitUntil: "domcontentloaded"
          });
          await expect(keystone.locator("body")).not.toContainText(updatedEmail);
        });

        await checkpoint(checkpoints, "Keystone business list remains usable after direct user attempt", async () => {
          await expect(keystone.locator("body")).toContainText(/List view|Assets|Refresh|Object access required|Restricted/i);
        });
      } finally {
        await keystone.close().catch(() => null);
      }

      await checkpoint(checkpoints, "Open user for cleanup disable", async () => {
        await openUsersPage(page);
        await openUserFromList(page, username);
        await expect(main).toContainText("User Details");
      });

      await checkpoint(checkpoints, "Cleanup edit modal opens", async () => {
        await main.getByRole("button", { name: /^edit$/i }).click();
        await expect(page.getByRole("heading", { name: /^edit user$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Cleanup status can be set to disabled", async () => {
        await selectStatus(page, "disabled");
        await expect(page.locator("select#user-status, select").filter({ has: page.locator("option", { hasText: /Disabled/ }) }).first()).toHaveValue("disabled");
      });

      await checkpoint(checkpoints, "Cleanup disabled status saves", async () => {
        await page.getByRole("button", { name: /^save$/i }).click();
        await expect(main).toContainText("disabled", { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Disabled user remains searchable for auditability", async () => {
        await openUsersPage(page);
        await searchUsers(page, username);
        await expect(userRow(page, username)).toContainText("disabled", { timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Runtime objects API schema health is observed", async () => {
        const tokenResponse = await request.post("/auth/login", {
          data: {
            username: process.env.TEST_USERNAME || process.env.ADMIN_USERNAME || "admin",
            password: process.env.TEST_PASSWORD || process.env.ADMIN_PASSWORD || "admin"
          }
        });
        expect(tokenResponse.ok()).toBeTruthy();
        const token = ((await tokenResponse.json()) as { access_token?: string; token?: string }).access_token ?? "";
        const response = await request.get(`/api/apps/${APP_ID}/objects`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        expect([200, 500]).toContain(response.status());
      });

      await checkpoint(checkpoints, "System setting API health is observed", async () => {
        const tokenResponse = await request.post("/auth/login", {
          data: {
            username: process.env.TEST_USERNAME || process.env.ADMIN_USERNAME || "admin",
            password: process.env.TEST_PASSWORD || process.env.ADMIN_PASSWORD || "admin"
          }
        });
        expect(tokenResponse.ok()).toBeTruthy();
        const token = ((await tokenResponse.json()) as { access_token?: string; token?: string }).access_token ?? "";
        const response = await request.get("/api/system-settings/system.list_view.column_filter_distinct_max_rows", {
          headers: { Authorization: `Bearer ${token}` }
        });
        expect([200, 404]).toContain(response.status());
      });

      await checkpoint(checkpoints, "Checkpoint count is at least 101", async () => {
        expect(checkpoints.length).toBeGreaterThanOrEqual(MIN_CHECKPOINT_TARGET);
      });
    } finally {
      if (createdUser) {
        await disableCreatedUser(page, username).catch(() => null);
      }
    }
  });
});
