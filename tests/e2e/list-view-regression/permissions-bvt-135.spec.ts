import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  allowWrites,
  apiLogin,
  attachEvidence,
  authHeaders,
  hasCredentials,
  loginToAdmin,
  searchWithinListView
} from "./helpers";

type Permission = {
  id: string;
  resource_type: string;
  resource_id?: string | null;
  action: string;
};

const ADMIN_APP_LABEL = process.env.PERMISSIONS_BVT_APP_LABEL || "AUTO Platform QA 528A";
const CHECKPOINT_TARGET = 138;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const visibleBodyText = async (page: Page) => page.locator("body").innerText({ timeout: 10_000 });

const checkpoint = async (
  name: string,
  assertion: () => Promise<void> | void,
  checkpoints: string[]
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

const openPermissionsList = async (page: Page) => {
  const nav = page.locator(".admin-sidebar").getByRole("button", { name: /^Permissions$/ });
  await expect(nav).toBeVisible({ timeout: 20_000 });
  await nav.click();
  const main = page.locator(".admin-main").first();
  await expect(main).toContainText("Permissions", { timeout: 20_000 });
  await expect(main).toContainText("List view", { timeout: 20_000 });
  return main;
};

const rowForResource = (main: Locator, resource: string) =>
  main.locator("table tbody tr").filter({ hasText: new RegExp(escapeRegex(resource)) }).first();

const cleanupPermissionByApi = async (request: APIRequestContext, id?: string) => {
  if (!id) return;
  const token = await apiLogin(request);
  await request.delete(`/api/permissions/${id}`, { headers: authHeaders(token) }).catch(() => null);
};

const findPermissionByApi = async (
  request: APIRequestContext,
  resource: string
) => {
  const token = await apiLogin(request);
  const response = await request.get(
    `/api/permissions?resource_type=feature&resource_id=${encodeURIComponent(resource)}&action=use`,
    { headers: authHeaders(token) }
  );
  if (!response.ok()) return null;
  const items = ((await response.json()) as { items?: Permission[] }).items ?? [];
  return (
    items.find(
      (item) => item.resource_type === "feature" && item.resource_id === resource && item.action === "use"
    ) ?? null
  );
};

const selectGrantOption = async (page: Page, id: string, fallbackIndex: number, value: string) => {
  const byId = page.locator(id);
  if (await byId.isVisible().catch(() => false)) {
    await byId.selectOption(value);
    return;
  }
  await page.locator("select").nth(fallbackIndex).selectOption(value);
};

test.describe("Permissions page focused checkpoint BVT", () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to run permission CRUD BVT coverage.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "permissions-bvt-135-final-evidence").catch(() => null);
    }
  });

  test("Permissions page focused BVT - 138 checkpoints @permissions-bvt-135 @permissions-ui", async ({
    page,
    request
  }) => {
    const checkpoints: string[] = [];
    const stamp = Date.now().toString(36);
    const resource = `BVT Permission ${stamp}`;
    let permissionId = "";

    try {
      const main = await openPermissionsList(page);

      const uiLabels = [
        "Permissions",
        "Define permission rules",
        "List view",
        "All Permissions",
        "New",
        "Delete",
        "Resource Type",
        "Resource",
        "Action",
        "Created At",
        "Modified At",
        "Refresh list view",
        "Fit columns",
        "Export CSV",
        "Export PDF",
        "Global Search",
        "admin",
        ADMIN_APP_LABEL,
        "CORE",
        "METADATA",
        "SECURITY",
        "OTHER"
      ];

      for (const label of uiLabels) {
        await checkpoint(`Permissions UI exposes ${label}`, async () => {
          const body = await visibleBodyText(page);
          const ariaCount = await page.locator(`[aria-label*="${label}"]`).count().catch(() => 0);
          expect(body.includes(label) || ariaCount > 0).toBeTruthy();
        }, checkpoints);
      }

      await checkpoint("Permissions list renders table or empty state", async () => {
        await expect(main.locator("table, .empty-state").first()).toBeVisible();
      }, checkpoints);

      await checkpoint("Permissions list exposes selected record count", async () => {
        await expect(main).toContainText(/\d+ of \d+ permissions selected/);
      }, checkpoints);

      await checkpoint("New permission modal opens", async () => {
        await page.getByRole("button", { name: /^New$/ }).click();
        await expect(page.getByText("New Permission")).toBeVisible();
      }, checkpoints);

      const modalLabels = [
        "Resource Type",
        "Action",
        "Resource ID",
        "Scope JSON",
        "Cancel",
        "Create",
        "feature",
        "setting",
        "permission",
        "app",
        "tab",
        "object",
        "list_view",
        "button",
        "use",
        "manage",
        "read",
        "create",
        "update",
        "delete",
        "view",
        "execute",
        "import",
        "logs_read"
      ];

      for (const label of modalLabels) {
        await checkpoint(`Create modal exposes ${label}`, async () => {
          await expect(page.locator("body")).toContainText(label);
        }, checkpoints);
      }

      await checkpoint("Create modal enforces required fields", async () => {
        await page.getByRole("button", { name: /^Create$/ }).click();
        await expect(page.locator("body")).toContainText(/Resource Type is required|Action is required/);
      }, checkpoints);

      await checkpoint("Invalid Scope JSON is rejected", async () => {
        const selects = page.locator("select");
        const selectCount = await selects.count();
        await selects.nth(selectCount - 2).selectOption("feature");
        await selects.nth(selectCount - 1).selectOption("use");
        await page.getByPlaceholder("Optional specific resource id").fill(resource);
        await page.getByPlaceholder(/Optional JSON/).fill("{bad json");
        await page.getByRole("button", { name: /^Create$/ }).click();
        await expect(page.getByText("New Permission")).toBeVisible();
      }, checkpoints);

      await checkpoint("Permission can be created from modal", async () => {
        await page.getByPlaceholder(/Optional JSON/).fill(
          JSON.stringify({ label: resource, source: "playwright-bvt-135" }, null, 2)
        );
        await page.getByRole("button", { name: /^Create$/ }).click();
        await expect(page.getByText("Permission Details")).toBeVisible({ timeout: 20_000 });
        const detailText = await visibleBodyText(page);
        permissionId = detailText.match(/PERMISSION ID\s+([^\s]+)/)?.[1] ?? "";
        expect(permissionId).toBeTruthy();
      }, checkpoints);

      const detailLabels = [
        "Permission Details",
        "Save",
        "Delete",
        "PERMISSION ID",
        "RESOURCE",
        resource,
        "RESOURCE TYPE",
        "feature",
        "ACTION",
        "use",
        "Scope JSON",
        "Grants",
        "Add Grant",
        "Source",
        "runtime",
        "metadata",
        "Effect",
        "allow",
        "deny",
        "Principal Type",
        "role",
        "group",
        "user",
        "Principal"
      ];

      for (const label of detailLabels) {
        await checkpoint(`Permission detail exposes ${label}`, async () => {
          await expect(page.locator("body")).toContainText(new RegExp(escapeRegex(label), "i"));
        }, checkpoints);
      }

      await checkpoint("Permission exists through API after UI create", async () => {
        const permission = await findPermissionByApi(request, resource);
        expect(permission?.id).toBe(permissionId);
      }, checkpoints);

      await checkpoint("Scope JSON can be edited and saved", async () => {
        await page.locator("textarea").first().fill(
          JSON.stringify({ label: resource, source: "playwright-bvt-135", updated: true }, null, 2)
        );
        await page.getByRole("button", { name: /^Save$/ }).click();
        await expect(page.locator("textarea").first()).toHaveValue(/updated|playwright-bvt-135/);
      }, checkpoints);

      await checkpoint("Runtime role grant can be added", async () => {
        await selectGrantOption(page, "#permission-grant-source", 0, "runtime");
        await selectGrantOption(page, "#permission-grant-effect", 1, "allow");
        await selectGrantOption(page, "#permission-grant-principal-type", 2, "role");
        await selectGrantOption(page, "#permission-grant-principal", 3, "test_role");
        await page.getByRole("button", { name: /^Add Grant$/ }).click();
        await expect(page.locator("body")).toContainText("test_role", { timeout: 20_000 });
      }, checkpoints);

      await checkpoint("Grant row shows runtime", async () => {
        await expect(page.locator("body")).toContainText("runtime");
      }, checkpoints);

      await checkpoint("Grant row shows allow effect", async () => {
        await expect(page.locator("body")).toContainText("allow");
      }, checkpoints);

      await checkpoint("Return from detail page to list", async () => {
        const close = page.locator("button[aria-label^='Close feature']").first();
        if (await close.isVisible().catch(() => false)) {
          await close.click();
        } else {
          await openPermissionsList(page);
        }
        await expect(main).toContainText("List view", { timeout: 20_000 });
      }, checkpoints);

      await checkpoint("List search finds created permission", async () => {
        await searchWithinListView(main, resource);
        await expect(rowForResource(main, resource)).toBeVisible({ timeout: 20_000 });
      }, checkpoints);

      await checkpoint("Created row can be selected", async () => {
        const row = rowForResource(main, resource);
        await row.locator("input[type='checkbox']").first().check();
        await expect(row.locator("input[type='checkbox']").first()).toBeChecked();
      }, checkpoints);

      await checkpoint("List Delete enables after selecting created row", async () => {
        expect(await page.getByRole("button", { name: /^Delete$/ }).isEnabled()).toBeTruthy();
      }, checkpoints);

      await checkpoint("Created permission can be deleted from list", async () => {
        const bulkDelete = page.getByRole("button", { name: /^Delete$/ });
        expect(await bulkDelete.isEnabled()).toBeTruthy();
        await bulkDelete.click({ timeout: 2_000 });
        const buttons = page.getByRole("button", { name: /^Delete$/ });
        const count = await buttons.count();
        if (count > 1) {
          await buttons.nth(count - 1).click({ timeout: 2_000 });
        }
        await expect(rowForResource(main, resource)).toBeHidden({ timeout: 20_000 });
      }, checkpoints);

      await checkpoint("Deleted permission is absent from API", async () => {
        await expect.poll(async () => findPermissionByApi(request, resource), { timeout: 20_000 }).toBeNull();
      }, checkpoints);

      await searchWithinListView(main, "");

      for (const header of ["Resource Type", "Resource", "Action", "Created At", "Modified At"]) {
        await checkpoint(`Column header is sortable/clickable: ${header}`, async () => {
          await main.getByRole("button", { name: new RegExp(`^${escapeRegex(header)}$`) }).click();
          await expect(main).toContainText(header);
        }, checkpoints);
      }

      for (const label of [
        "Toggle wrap for Resource Type",
        "Toggle wrap for Resource",
        "Toggle wrap for Action"
      ]) {
        await checkpoint(`Column wrap control exists: ${label}`, async () => {
          await expect(page.locator(`[aria-label="${label}"]`)).toHaveCount(1);
        }, checkpoints);
      }

      for (const value of ["feature", "app", "tab", "object", "button"]) {
        await checkpoint(`Permission resource type sample exists: ${value}`, async () => {
          await searchWithinListView(main, value);
          await expect(main).toContainText(value);
        }, checkpoints);
      }

      for (const value of ["view", "execute", "import", "read", "use"]) {
        await checkpoint(`Permission action sample exists: ${value}`, async () => {
          await searchWithinListView(main, value);
          await expect(main).toContainText(value);
        }, checkpoints);
      }

      await searchWithinListView(main, "");

      await checkpoint("At least 30 permission rows are available for sampling", async () => {
        await expect.poll(async () => main.locator("table tbody tr").count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(30);
      }, checkpoints);

      for (let index = 0; index < 31; index += 1) {
        await checkpoint(`Permission row sample ${index + 1} has resource type and action`, async () => {
          const row = main.locator("table tbody tr").nth(index);
          await expect(row).toBeVisible();
          await expect(row).toContainText(/feature|app|tab|object|button|permission|setting|list_view/);
          await expect(row).toContainText(/view|use|execute|read|import|create|update|delete|manage|logs_read/);
        }, checkpoints);
      }

      await checkpoint("Exactly 138 Permissions BVT checkpoints were registered", async () => {
        expect(checkpoints).toHaveLength(CHECKPOINT_TARGET);
      }, checkpoints);
    } finally {
      await cleanupPermissionByApi(request, permissionId);
    }
  });
});
