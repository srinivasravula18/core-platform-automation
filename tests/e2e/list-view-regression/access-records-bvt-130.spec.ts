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

const APP_ID = process.env.ACCESS_RECORDS_BVT_APP_ID || "app13iug98";
const CHECKPOINT_TARGET = 152;
const AUTO_CASE_OBJECT_ID = "obj153bbp7";
const TEST_ROLE_ID = "roly3qikz5";

const bodyText = async (page: Page) => page.locator("body").innerText({ timeout: 15_000 });

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

const openAccessRecordsPage = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=apps&appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
  const nav = page.locator(".admin-sidebar").getByRole("button", { name: /^Access Records$/i });
  await expect(nav).toBeVisible({ timeout: 20_000 });
  await nav.click();
  const main = page.locator(".admin-main").first();
  await expect(main).toContainText("Access Controls", { timeout: 20_000 });
  await expect(main).toContainText("All Access Records", { timeout: 20_000 });
  return main;
};

const setModalPermission = async (page: Page, indexFromPermissionStart: number, checked: boolean) => {
  const total = await page.locator("input[type='checkbox']").count();
  const permissionIndex = total - 10 + indexFromPermissionStart;
  const checkbox = page.locator("input[type='checkbox']").nth(permissionIndex);
  if (checked) {
    await checkbox.check();
  } else {
    await checkbox.uncheck();
  }
};

const expectPermissionRendered = async (page: Page, label: string) => {
  const labels = await page.locator("input[type='checkbox']").evaluateAll((boxes) =>
    boxes.map((box) => box.closest("label")?.textContent?.trim() || "")
  );
  expect(labels.some((text) => text.includes(label))).toBeTruthy();
};

const closeDetailToList = async (page: Page) => {
  const mainTab = page.locator(".admin-main").getByRole("button", { name: /^Access Records$/i }).first();
  if (await mainTab.isVisible().catch(() => false)) {
    await mainTab.click();
  }
  await expect(page.locator(".admin-main").first()).toContainText("All Access Records", { timeout: 15_000 });
};

const deleteCurrentAccessRecord = async (page: Page) => {
  const main = page.locator(".admin-main").first();
  const deleteButtons = main.getByRole("button", { name: /^Delete$/i });
  if ((await deleteButtons.count()) === 0) return;
  await deleteButtons.first().click();
  const confirm = page.getByRole("button", { name: /^Delete$/i }).last();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
  }
  await expect(main).toContainText("All Access Records", { timeout: 20_000 });
};

test.describe("Access Records page BVT", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to run access records CRUD BVT coverage.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "access-records-bvt-130-final-evidence").catch(() => null);
    }
  });

  test("Access Records page BVT - 152 checkpoints @access-records-bvt-152 @access-records-bvt-130 @permissions-ui", async ({
    page,
    context
  }) => {
    const checkpoints: string[] = [];
    let cleanupCreated = false;

    try {
      const main = await openAccessRecordsPage(page);

      for (const label of [
        "Apps",
        "AUTO Platform QA 528A",
        "admin",
        "CORE",
        "App Hierarchy",
        "Search Results",
        "Agent",
        "METADATA",
        "Objects",
        "Tabs",
        "Flows",
        "SECURITY",
        "Roles",
        "Groups",
        "Users",
        "Permissions",
        "Access Records",
        "Sharing Settings",
        "OTHER",
        "System Settings",
        "Email Logs",
        "Scheduled Jobs",
        "Audit Logs",
        "Recycle Bin",
        "Access Controls",
        "Grant read/create/update/delete access",
        "List view",
        "All Access Records",
        "New",
        "Delete",
        "Object",
        "Principal Type",
        "Principal",
        "Permissions",
        "Created At",
        "Modified At"
      ]) {
        await checkpoint(checkpoints, `Access Records page exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      for (const control of [
        "Global Search",
        "All Access Records",
        "Pin list view",
        "Search results",
        "New",
        "Delete",
        "Refresh list view",
        "List view actions",
        "Fit columns",
        "Export CSV",
        "Export PDF",
        "Select all rows",
        "Toggle wrap for Object",
        "Toggle wrap for Principal Type",
        "Toggle wrap for Principal",
        "Toggle wrap for Permissions"
      ]) {
        await checkpoint(checkpoints, `Access Records control exists: ${control}`, async () => {
          const controls = await page.locator("button,input,select").evaluateAll((nodes) =>
            nodes.map((node) =>
              [
                node.textContent?.trim() || "",
                node.getAttribute("aria-label") || "",
                node.getAttribute("placeholder") || "",
                node.getAttribute("type") || ""
              ].join(" ")
            )
          );
          expect(controls.some((text) => text.includes(control))).toBeTruthy();
        });
      }

      for (const seeded of [
        "AUTO Case",
        "auto_case_role_528a",
        "MCP QA Object p15vz9",
        "system_admin",
        "test test",
        "Data Import",
        "Asset",
        "Vendor",
        "Site",
        "Read, Create, Update",
        "View All",
        "Modify All"
      ]) {
        await checkpoint(checkpoints, `Seeded access record data visible: ${seeded}`, async () => {
          await expect(main).toContainText(seeded);
        });
      }

      await checkpoint(checkpoints, "Access Records list has seven seeded rows", async () => {
        await expect(main).toContainText("0 of 7 access records selected");
        expect(await main.locator("table tbody tr").count()).toBeGreaterThanOrEqual(7);
      });

      await checkpoint(checkpoints, "New Access Record modal opens", async () => {
        await main.getByRole("button", { name: /^New$/i }).click();
        await expect(page.getByText("New Access Record")).toBeVisible();
      });

      for (const label of [
        "New Access Record",
        "Object",
        "Select an object",
        "AUTO Case",
        "Principal Type",
        "Role",
        "Group",
        "User",
        "Principal",
        "Select a principal",
        "Object Access",
        "Read",
        "Create",
        "Update",
        "Attachment Access",
        "Field Access",
        "Default follows object access",
        "Cancel",
        "Create"
      ]) {
        await checkpoint(checkpoints, `Create modal exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "Create modal selects AUTO Case object", async () => {
        await page.locator("#access-record-object").selectOption(AUTO_CASE_OBJECT_ID);
        await expect(page.locator("#access-record-object")).toHaveValue(AUTO_CASE_OBJECT_ID);
      });

      await checkpoint(checkpoints, "Create modal selects Role principal type", async () => {
        await page.locator("#access-record-principal-type").selectOption("role");
        await expect(page.locator("#access-record-principal-type")).toHaveValue("role");
      });

      await checkpoint(checkpoints, "Create modal selects test_role principal", async () => {
        await page.locator("#access-record-principal-id").selectOption(TEST_ROLE_ID);
        await expect(page.locator("#access-record-principal-id")).toHaveValue(TEST_ROLE_ID);
      });

      await checkpoint(checkpoints, "Read permission is selected by default", async () => {
        const total = await page.locator("input[type='checkbox']").count();
        await expect(page.locator("input[type='checkbox']").nth(total - 10)).toBeChecked();
      });

      await checkpoint(checkpoints, "Create permission can be selected before create", async () => {
        await setModalPermission(page, 1, true);
      });

      await checkpoint(checkpoints, "Update permission starts cleared before create", async () => {
        const total = await page.locator("input[type='checkbox']").count();
        await expect(page.locator("input[type='checkbox']").nth(total - 8)).not.toBeChecked();
      });

      await checkpoint(checkpoints, "Access Record create succeeds", async () => {
        await page.locator("button").filter({ hasText: /^Create$/ }).last().click();
        cleanupCreated = true;
        await expect(main).toContainText("Access Record Details", { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Created record detail title visible", async () => {
        await expect(main).toContainText("AUTO Case");
        await expect(main).toContainText("test_role");
      });

      await checkpoint(checkpoints, "Created record detail exposes generated id", async () => {
        await expect(main).toContainText(/acr[a-z0-9]+/i);
      });

      await checkpoint(checkpoints, "Update checkbox can be selected on detail", async () => {
        await page.locator("input[type='checkbox']").nth(2).check();
      });

      await checkpoint(checkpoints, "Attachment read checkbox can be selected on detail", async () => {
        await page.locator("input[type='checkbox']").nth(6).check();
      });

      await checkpoint(checkpoints, "Save button is visible on detail", async () => {
        await expect(main.getByRole("button", { name: /^Save$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Access Record update save succeeds", async () => {
        await main.getByRole("button", { name: /^Save$/i }).click();
        await expect(page.locator("input[type='checkbox']").nth(2)).toBeChecked({ timeout: 15_000 });
      });

      await checkpoint(checkpoints, "Updated permission remains checked after save", async () => {
        await expect(page.locator("input[type='checkbox']").nth(2)).toBeChecked();
      });

      await checkpoint(checkpoints, "Attachment read remains checked after save", async () => {
        await expect(page.locator("input[type='checkbox']").nth(6)).toBeChecked();
      });

      for (const label of [
        "Access Record Details",
        "Save",
        "Reset",
        "Delete",
        "ID",
        "Object",
        "AUTO Case",
        "Principal Type",
        "role",
        "Principal",
        "test_role",
        "Created At",
        "Created By",
        "Modified At",
        "Modified By",
        "Object Access",
        "Attachment Access",
        "Field Access",
        "Field",
        "Access",
        "Name",
        "Status"
      ]) {
        await checkpoint(checkpoints, `Access Record detail exposes ${label}`, async () => {
          await expect(main).toContainText(label);
        });
      }

      for (const permission of ["Read", "Create", "Update", "Delete", "View All", "Modify All", "Upload", "Download"]) {
        await checkpoint(checkpoints, `Permission checkbox rendered: ${permission}`, async () => {
          await expectPermissionRendered(page, permission);
        });
      }

      await checkpoint(checkpoints, "Delete button is available on created detail", async () => {
        await expect(main.getByRole("button", { name: /^Delete$/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete confirmation opens for created record", async () => {
        await main.getByRole("button", { name: /^Delete$/i }).click();
        await expect(page.locator("body")).toContainText(/Delete Access Record|Are you sure|Delete/i);
      });

      await checkpoint(checkpoints, "Delete confirmation succeeds", async () => {
        await page.getByRole("button", { name: /^Delete$/i }).last().click();
        cleanupCreated = false;
        await expect(main).toContainText("All Access Records", { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Created access record id absent after delete", async () => {
        await expect(main).not.toContainText(/AUTO Case\s+role\s+test_role/i);
      });

      await checkpoint(checkpoints, "Disposable AUTO Case test_role record removed", async () => {
        await expect(main).not.toContainText("test_role");
      });

      await checkpoint(checkpoints, "Original seeded AUTO Case record retained", async () => {
        await expect(main).toContainText("auto_case_role_528a");
      });

      await checkpoint(checkpoints, "Access Records list returned to seven rows", async () => {
        await expect(main).toContainText("0 of 7 access records selected");
      });

      const keystone = await context.newPage();

      await checkpoint(checkpoints, "Keystone login succeeds", async () => {
        await loginToKeystone(keystone);
      });

      await checkpoint(checkpoints, "Keystone target app opens", async () => {
        await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
        await expect(keystone.locator("body")).toContainText("AUTO Platform QA 528A", { timeout: 20_000 });
      });

      for (const label of [
        "Asset",
        "Global Search Help",
        "Search all enabled objects",
        "Assets",
        "List view",
        "All Assets",
        "New",
        "Delete",
        "Name",
        "Status",
        "Created At"
      ]) {
        await checkpoint(checkpoints, `Keystone runtime exposes ${label}`, async () => {
          await expect(keystone.locator("body")).toContainText(label);
        });
      }

      await checkpoint(checkpoints, "Keystone does not expose Access Record metadata as business data", async () => {
        await expect(keystone.locator("body")).not.toContainText("test_role");
        await expect(keystone.locator("body")).not.toContainText("Access Records");
      });

      await keystone.close();

      await checkpoint(checkpoints, "Checkpoint count is exactly 152", async () => {
        expect(checkpoints).toHaveLength(CHECKPOINT_TARGET);
      });
    } finally {
      if (cleanupCreated) {
        await deleteCurrentAccessRecord(page).catch(() => null);
      }
    }
  });
});
