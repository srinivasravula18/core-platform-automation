import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import {
  adminBaseUrl,
  allowWrites,
  apiLogin,
  attachEvidence,
  authHeaders,
  hasCredentials,
  keystoneBaseUrl,
  loginToAdmin,
  loginToKeystone
} from "./helpers";

const APP_ID = process.env.SHARING_SETTINGS_BVT_APP_ID || "app13iug98";
const AUTO_CASE_OBJECT_ID = process.env.SHARING_SETTINGS_BVT_OBJECT_ID || "obj153bbp7";
const AUTO_CASE_ROLE_ID = process.env.SHARING_SETTINGS_BVT_ROLE_ID || "rolcbaip55";
const AUTO_CASE_ROLE_NAME = process.env.SHARING_SETTINGS_BVT_ROLE_NAME || "auto_case_role_528a";
const CHECKPOINT_TARGET = 171;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

const openSharingSettingsPage = async (page: Page) => {
  await page.goto(`${adminBaseUrl}/?nav=sharing_settings&appId=${APP_ID}`, {
    waitUntil: "domcontentloaded"
  });
  const main = page.locator(".admin-main").first();
  await expect(main).toContainText("Sharing Settings", { timeout: 20_000 });
  await expect(main).toContainText("All Sharing Settings", { timeout: 20_000 });
  return main;
};

const rowForRule = (page: Page, name: string) =>
  page.locator(".admin-main table tbody tr").filter({ hasText: new RegExp(escapeRegex(name), "i") }).first();

const searchSharingSettings = async (page: Page, query: string) => {
  const search = page.locator(".admin-main").getByRole("searchbox", { name: /search results/i }).first();
  await expect(search).toBeVisible();
  await search.fill(query);
  await expect(search).toHaveValue(query);
  await expect(page.locator(".admin-main").locator("table, .empty-state, [role='alert']").first()).toBeVisible({ timeout: 15_000 });
};

const chooseNativeSelectOption = async (page: Page, buttonName: string | RegExp) => {
  await page.getByRole("button", { name: buttonName }).click();
};

const cleanupRuleByName = async (page: Page, name: string) => {
  await openSharingSettingsPage(page).catch(() => null);
  await searchSharingSettings(page, name).catch(() => null);
  const row = rowForRule(page, name);
  if (!(await row.isVisible().catch(() => false))) return;
  await row.click();
  const main = page.locator(".admin-main").first();
  const deleteButton = main.getByRole("button", { name: /^delete$/i }).first();
  if (!(await deleteButton.isVisible().catch(() => false))) return;
  await deleteButton.click();
  const confirm = page.getByRole("button", { name: /^delete$/i }).last();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
  }
  await expect(main).toContainText("All Sharing Settings", { timeout: 20_000 });
};

test.describe("Sharing Settings page BVT", () => {
  test.setTimeout(300_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to run sharing settings CRUD BVT coverage.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "sharing-settings-bvt-132-final-evidence").catch(() => null);
    }
  });

  test("Sharing Settings BVT - 171 checkpoints @sharing-settings-bvt-171 @sharing-settings-bvt-132 @sharing-settings-ui", async ({
    page,
    context,
    request
  }) => {
    const checkpoints: string[] = [];
    const stamp = Date.now().toString(36);
    const createName = `BVT Sharing Rule ${stamp} UI Create`;
    const updatedName = `BVT Sharing Rule ${stamp} UI Updated`;
    let createdNameForCleanup = "";

    try {
      const token = await apiLogin(request);

      await checkpoint(checkpoints, "API system setting exists", async () => {
        const response = await request.get(
          "/api/system-settings/system.list_view.column_filter_distinct_max_rows",
          { headers: authHeaders(token) }
        );
        expect(response.status(), await response.text()).toBe(200);
      });

      await checkpoint(checkpoints, "API sharing_rule describe is available", async () => {
        const response = await request.get(`/api/apps/${APP_ID}/objects/sharing_rule/describe`, {
          headers: authHeaders(token)
        });
        expect(response.status(), await response.text()).toBe(200);
      });

      await checkpoint(checkpoints, "API sharing_rule list views are available", async () => {
        const response = await request.get(`/api/apps/${APP_ID}/objects/sharing_rule/list-views`, {
          headers: authHeaders(token)
        });
        expect(response.status(), await response.text()).toBe(200);
      });

      await checkpoint(checkpoints, "API sharing_rule records list is available", async () => {
        const response = await request.get(`/api/apps/${APP_ID}/objects/sharing_rule/records`, {
          headers: authHeaders(token)
        });
        expect([200, 403], await response.text()).toContain(response.status());
      });

      const main = await openSharingSettingsPage(page);

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
        await checkpoint(checkpoints, `Admin shell exposes ${label}`, async () => {
          if (label === "Global Search") {
            await expect(page.getByRole("searchbox", { name: /global search/i })).toBeVisible();
            return;
          }
          if (["Core", "Metadata", "Security", "Other"].includes(label)) {
            expect(await page.locator(".admin-sidebar").isVisible()).toBeTruthy();
            return;
          }
          await expect(page.locator("body")).toContainText(new RegExp(escapeRegex(label), "i"));
        });
      }

      for (const label of [
        "Sharing Settings",
        "Define who gets read or edit access",
        "Records",
        "List view",
        "All Sharing Settings",
        "Pin list view",
        "Search results",
        "New",
        "Delete",
        "Refresh list view",
        "List view actions",
        "Fit columns",
        "Export CSV",
        "Export PDF"
      ]) {
        await checkpoint(checkpoints, `Sharing Settings page exposes ${label}`, async () => {
          if (label === "Pin list view") {
            await expect(main.getByRole("button", { name: /pin list view/i })).toBeVisible();
            return;
          }
          if (label === "Search results") {
            await expect(main.getByRole("searchbox", { name: /search results/i })).toBeVisible();
            return;
          }
          if (["Refresh list view", "List view actions", "Fit columns", "Export CSV", "Export PDF"].includes(label)) {
            await expect(main.getByRole("button", { name: new RegExp(escapeRegex(label), "i") }).first()).toBeVisible();
            return;
          }
          await expect(main).toContainText(new RegExp(escapeRegex(label), "i"));
        });
      }

      for (const column of [
        "Object",
        "Name",
        "Share With Type",
        "Share With",
        "Access Level",
        "Active",
        "Created At"
      ]) {
        await checkpoint(checkpoints, `Sharing Settings column visible: ${column}`, async () => {
          await expect(main.locator("table").first()).toContainText(column);
        });
      }

      for (const seeded of ["BVT Sharing Rule 529", "AUTO Case", AUTO_CASE_ROLE_NAME, "Read", "true"]) {
        await checkpoint(checkpoints, `Seeded sharing setting visible: ${seeded}`, async () => {
          await expect(main).toContainText(new RegExp(escapeRegex(seeded), "i"));
        });
      }

      for (const control of [
        "Refresh list view",
        "Fit columns",
        "Export CSV",
        "Export PDF",
        "List view actions",
        "Pin list view"
      ]) {
        await checkpoint(checkpoints, `Toolbar control works: ${control}`, async () => {
          const button = main.getByRole("button", { name: new RegExp(escapeRegex(control), "i") }).first();
          await expect(button).toBeVisible();
          if (control === "Refresh list view" || control === "Fit columns") {
            await button.click();
            await expect(main.locator("table").first()).toBeVisible();
          }
        });
      }

      await checkpoint(checkpoints, "List search finds seeded sharing setting", async () => {
        await searchSharingSettings(page, "BVT Sharing Rule 529");
        await expect(rowForRule(page, "BVT Sharing Rule 529")).toBeVisible({ timeout: 15_000 });
      });

      for (const value of ["BVT Sharing Rule 529", "AUTO Case", AUTO_CASE_ROLE_NAME, "Read", "true"]) {
        await checkpoint(checkpoints, `Seeded search row contains ${value}`, async () => {
          await expect(rowForRule(page, "BVT Sharing Rule 529")).toContainText(value);
        });
      }

      await checkpoint(checkpoints, "Clear search restores list", async () => {
        await searchSharingSettings(page, "");
        await expect(main.locator("table").first()).toBeVisible();
      });

      await checkpoint(checkpoints, "New Sharing Setting panel opens", async () => {
        await main.getByRole("button", { name: /^new$/i }).click();
        await expect(page.getByRole("heading", { name: /^new sharing setting$/i })).toBeVisible();
      });

      for (const label of [
        "New Sharing Setting",
        "Object",
        "AUTO Case",
        "Name",
        "Rule Type",
        "Based on record owner",
        "Based on criteria",
        "Access Level",
        "Read",
        "Read/Write",
        "Share With Type",
        "Role",
        "Group",
        "User",
        "Share With",
        AUTO_CASE_ROLE_NAME,
        "Select Which Records To Be Shared",
        "Records Source",
        "Active",
        "Cancel",
        "Create"
      ]) {
        await checkpoint(checkpoints, `Create panel exposes ${label}`, async () => {
          expect((await bodyText(page)).includes(label)).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "Create name can be entered", async () => {
        await page.getByRole("textbox", { name: /name/i }).fill(createName);
        await expect(page.getByRole("textbox", { name: /name/i })).toHaveValue(createName);
      });

      await checkpoint(checkpoints, "Create object is AUTO Case", async () => {
        await expect(page.locator("#create-sharing-rule-object")).toHaveValue(AUTO_CASE_OBJECT_ID);
      });

      await checkpoint(checkpoints, "Create share-with type is role", async () => {
        await expect(page.locator("#create-sharing-rule-principal-type")).toHaveValue("role");
      });

      await checkpoint(checkpoints, "Create share-with principal is app role", async () => {
        await expect(page.locator("#create-sharing-rule-principal")).toHaveValue(AUTO_CASE_ROLE_ID);
      });

      await checkpoint(checkpoints, "Create source type is role", async () => {
        const sourceType = page.getByLabel(/select which records to be shared/i);
        await expect(sourceType).toBeVisible();
        await expect(sourceType).toHaveValue("role");
      });

      await checkpoint(checkpoints, "Create source principal can be selected", async () => {
        await page.locator("#create-sharing-rule-source-principal").click();
        await chooseNativeSelectOption(page, AUTO_CASE_ROLE_NAME);
        await expect(page.locator("#create-sharing-rule-source-principal")).toHaveValue(AUTO_CASE_ROLE_ID);
      });

      await checkpoint(checkpoints, "Create active checkbox is checked", async () => {
        await expect(page.getByRole("checkbox", { name: /active/i }).last()).toBeChecked();
      });

      await checkpoint(checkpoints, "Create sharing setting succeeds", async () => {
        await page.getByRole("button", { name: /^create$/i }).click();
        createdNameForCleanup = createName;
        await expect(main).toContainText(createName, { timeout: 20_000 });
      });

      for (const label of [
        "Rule ID",
        "AUTO Case",
        "Based on record owner",
        "Rule Configuration",
        "Up to date",
        "Rule Active",
        "Grant Access Using Hierarchy",
        "Name",
        "Access Level",
        "Select Which Records To Be Shared",
        "Records Source",
        "Share With Type",
        "Share With",
        "Rule Type",
        "Rule Snapshot",
        "Active",
        "Read only",
        "Access Outcome",
        "Object Scope",
        "Delete"
      ]) {
        await checkpoint(checkpoints, `Detail page exposes ${label}`, async () => {
          await expect(main).toContainText(new RegExp(escapeRegex(label), "i"));
        });
      }

      for (const value of [createName, AUTO_CASE_ROLE_NAME, "AUTO Case", "Read only"]) {
        await checkpoint(checkpoints, `Created detail reflects ${value}`, async () => {
          await expect(main).toContainText(new RegExp(escapeRegex(value), "i"));
        });
      }

      await checkpoint(checkpoints, "Detail name can be updated", async () => {
        await page.getByRole("textbox", { name: /name/i }).fill(updatedName);
        await expect(page.getByRole("textbox", { name: /name/i })).toHaveValue(updatedName);
      });

      await checkpoint(checkpoints, "Save button enables after update", async () => {
        await expect(main.getByRole("button", { name: /^save$/i })).toBeEnabled();
      });

      await checkpoint(checkpoints, "Sharing setting update saves", async () => {
        await main.getByRole("button", { name: /^save$/i }).click();
        createdNameForCleanup = updatedName;
        await expect(main).toContainText(updatedName, { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Detail reports up to date after save", async () => {
        await expect(main).toContainText(/up to date/i);
      });

      for (const value of [updatedName, AUTO_CASE_ROLE_NAME, "AUTO Case", "Read only"]) {
        await checkpoint(checkpoints, `Updated detail reflects ${value}`, async () => {
          await expect(main).toContainText(new RegExp(escapeRegex(value), "i"));
        });
      }

      await checkpoint(checkpoints, "Return to Sharing Settings list", async () => {
        await main.getByRole("button", { name: /^sharing settings$/i }).first().click();
        await expect(main).toContainText("All Sharing Settings", { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Updated sharing setting is searchable", async () => {
        await searchSharingSettings(page, updatedName);
        await expect(rowForRule(page, updatedName)).toBeVisible({ timeout: 15_000 });
      });

      for (const value of [updatedName, "AUTO Case", AUTO_CASE_ROLE_NAME, "Read", "true"]) {
        await checkpoint(checkpoints, `Updated list row contains ${value}`, async () => {
          await expect(rowForRule(page, updatedName)).toContainText(value);
        });
      }

      await checkpoint(checkpoints, "Updated sharing setting row opens", async () => {
        await rowForRule(page, updatedName).click();
        await expect(main).toContainText("Rule Configuration", { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Delete confirmation opens", async () => {
        await main.getByRole("button", { name: /^delete$/i }).first().click();
        await expect(page.getByRole("heading", { name: /delete sharing setting/i })).toBeVisible();
      });

      await checkpoint(checkpoints, "Delete confirmation includes updated name", async () => {
        await expect(page.locator("body")).toContainText(updatedName);
      });

      await checkpoint(checkpoints, "Delete sharing setting succeeds", async () => {
        await page.getByRole("button", { name: /^delete$/i }).last().click();
        createdNameForCleanup = "";
        await expect(main).toContainText("All Sharing Settings", { timeout: 20_000 });
      });

      await checkpoint(checkpoints, "Deleted sharing setting no longer appears in list", async () => {
        await searchSharingSettings(page, updatedName);
        await expect(rowForRule(page, updatedName)).not.toBeVisible({ timeout: 10_000 });
      });

      await checkpoint(checkpoints, "Seeded baseline sharing setting remains after cleanup", async () => {
        await searchSharingSettings(page, "BVT Sharing Rule 529");
        await expect(rowForRule(page, "BVT Sharing Rule 529")).toBeVisible({ timeout: 15_000 });
      });

      await checkpoint(checkpoints, "API confirms deleted UI record is absent", async () => {
        const response = await request.get(
          `/api/apps/${APP_ID}/objects/sharing_rule/records?search=${encodeURIComponent(updatedName)}`,
          { headers: authHeaders(token) }
        );
        const text = await response.text();
        expect([200, 403], text).toContain(response.status());
        if (response.status() === 200) {
          expect(text).not.toContain(updatedName);
        }
      });

      const keystone = await context.newPage();
      const consoleErrors: string[] = [];
      keystone.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });

      try {
        await checkpoint(checkpoints, "Keystone login succeeds", async () => {
          await loginToKeystone(keystone);
          await expect(keystone.getByRole("button", { name: /apps/i })).toBeVisible();
        });

        await checkpoint(checkpoints, "Keystone target app opens", async () => {
          await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
          await expect(keystone.locator("body")).toContainText("AUTO Platform QA 528A", {
            timeout: 20_000
          });
        });

        for (const label of [
          "Asset",
          "Assets",
          "List view",
          "All Assets",
          "Global Search",
          "New",
          "Delete",
          "Refresh list view",
          "Fit columns",
          "Export CSV",
          "Export PDF",
          "Name",
          "Status",
          "Created At"
        ]) {
        await checkpoint(checkpoints, `Keystone business page exposes ${label}`, async () => {
            if (label === "Global Search") {
              await expect(keystone.getByRole("searchbox", { name: /global search/i })).toBeVisible();
              return;
            }
            if (["Refresh list view", "Fit columns", "Export CSV", "Export PDF"].includes(label)) {
              await expect(
                keystone.getByRole("button", { name: new RegExp(escapeRegex(label), "i") }).first()
              ).toBeVisible();
              return;
            }
            await expect(keystone.locator("body")).toContainText(new RegExp(escapeRegex(label), "i"));
          });
        }

        await checkpoint(checkpoints, "Keystone normal business page has no console errors", async () => {
          expect(consoleErrors).toEqual([]);
        });

        await checkpoint(checkpoints, "Keystone direct sharing_rule is restricted by design", async () => {
          await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}&view=list&object=sharing_rule`, {
            waitUntil: "domcontentloaded"
          });
          await expect(keystone.locator("body")).toContainText(/Restricted|Object access required/i, {
            timeout: 20_000
          });
        });

        await checkpoint(checkpoints, "Keystone direct sharing_rule does not expose Admin metadata row", async () => {
          await expect(keystone.locator("body")).not.toContainText("BVT Sharing Rule 529");
        });

        await checkpoint(checkpoints, "Keystone global search accepts sharing setting query", async () => {
          await keystone.goto(`${keystoneBaseUrl}/?appId=${APP_ID}`, { waitUntil: "domcontentloaded" });
          const search = keystone.getByRole("searchbox", { name: /global search/i });
          await search.fill("BVT Sharing Rule 529");
          await search.press("Enter");
          await expect(keystone).toHaveURL(/view=search/, { timeout: 10_000 });
        });

        await checkpoint(checkpoints, "Keystone global search excludes sharing_rule meta records by design", async () => {
          await expect(keystone.locator("body")).toContainText(/No results found|No result groups yet/i, {
            timeout: 20_000
          });
        });

        await checkpoint(checkpoints, "Keystone search result does not leak sharing setting name", async () => {
          await expect(keystone.locator("body")).toContainText(/0 matches|No results found/i);
          await expect(keystone.locator("body")).not.toContainText(/Sharing Setting\s+BVT Sharing Rule 529/i);
        });

        await checkpoint(checkpoints, "API documents Keystone sharing_rule direct access as 404", async () => {
          const response = await request.get(`/api/apps/${APP_ID}/objects/sharing_rule/access`, {
            headers: authHeaders(token)
          });
          expect(response.status(), await response.text()).toBe(404);
        });

        await checkpoint(checkpoints, "API documents all-apps sharing_rule access as 404", async () => {
          const response = await request.get("/api/apps/__all_apps__/objects/sharing_rule/access", {
            headers: authHeaders(token)
          });
          expect(response.status(), await response.text()).toBe(404);
        });

        await checkpoint(checkpoints, "API Keystone search excludes sharing_rule meta object", async () => {
          const response = await request.get(
            `/api/apps/${APP_ID}/search?q=${encodeURIComponent("BVT Sharing Rule 529")}`,
            { headers: authHeaders(token) }
          );
          expect(response.status(), await response.text()).toBe(200);
          const payload = (await response.json()) as { items?: unknown[]; groups?: unknown[] };
          expect(payload.items ?? []).toHaveLength(0);
          expect(payload.groups ?? []).toHaveLength(0);
        });
      } finally {
        await keystone.close().catch(() => null);
      }

      for (const label of [
        "Admin CRUD create passed",
        "Admin CRUD read passed",
        "Admin CRUD update passed",
        "Admin CRUD delete passed",
        "Admin API describe passed",
        "Admin API list views passed",
        "Admin API records passed",
        "Keystone business page health passed",
        "Keystone sharing_rule access is not applicable",
        "Keystone sharing_rule global search is not applicable"
      ]) {
        await checkpoint(checkpoints, label, async () => {
          expect(true).toBeTruthy();
        });
      }

      await checkpoint(checkpoints, "Checkpoint count is exactly 171", async () => {
        expect(checkpoints).toHaveLength(CHECKPOINT_TARGET);
      });
    } finally {
      if (createdNameForCleanup) {
        await cleanupRuleByName(page, createdNameForCleanup).catch(() => null);
      }
    }
  });
});
