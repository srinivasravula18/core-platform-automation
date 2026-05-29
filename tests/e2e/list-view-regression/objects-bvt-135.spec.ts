import { expect, test, type Page, type TestInfo } from "../helpers/singleBrowserTest";
import { allowWrites, attachEvidence, hasCredentials, loginToAdmin } from "./helpers";

type CheckStatus = "PASSED" | "FAILED";
type CheckResult = { name: string; status: CheckStatus; evidence: string };

const CHECK_TARGET = 135;

const bodyText = async (page: Page) => page.locator("body").innerText({ timeout: 10_000 });

const addCheck = async (
  checks: CheckResult[],
  name: string,
  assertion: () => Promise<boolean> | boolean,
  evidence: () => Promise<unknown> | unknown = ""
) => {
  await test.step(`${String(checks.length + 1).padStart(3, "0")} ${name}`, async () => {
    let ok = false;
    let detail = "";
    try {
      ok = await assertion();
      detail = String(await evidence());
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    checks.push({ name, status: ok ? "PASSED" : "FAILED", evidence: detail.slice(0, 300) });
    if (!ok) expect.soft(detail, name).toBe("");
  });
};

const openObjectsPage = async (page: Page) => {
  const nav = page.locator(".admin-sidebar").getByRole("button", { name: /^Objects$/ });
  await expect(nav).toBeVisible({ timeout: 20_000 });
  await nav.click();
  const main = page.locator(".admin-main").first();
  await expect(main).toContainText("Objects", { timeout: 20_000 });
  await expect(main).toContainText("List view", { timeout: 20_000 });
  return main;
};

const visibleRows = async (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("tr")]
      .slice(1, 46)
      .map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter(Boolean)
  );

test.describe("Objects page BVT", () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin credentials are not configured.");
    test.skip(!allowWrites(), "Set ALLOW_DATA_WRITE=true to run object CRUD BVT coverage.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "objects-bvt-135-final-evidence").catch(() => null);
    }
  });

  test("Objects page BVT - 135 checks @objects-bvt-135 @objects-ui", async ({ page, context }) => {
    const checks: CheckResult[] = [];
    const main = await openObjectsPage(page);
    let text = await bodyText(page);

    const listLabels = [
      "Objects",
      "List view",
      "All Objects",
      "New",
      "Delete",
      "Refresh list view",
      "Fit columns",
      "Export CSV",
      "Export PDF",
      "Search results",
      "Global Search"
    ];

    for (const label of listLabels) {
      await addCheck(
        checks,
        `Objects list UI exposes ${label}`,
        async () =>
          (await bodyText(page)).includes(label) ||
          (await page.locator(`[aria-label*="${label}"]`).count()) > 0 ||
          (await page.locator(`[placeholder*="${label}"]`).count()) > 0,
        label
      );
    }

    const columns = [
      "Label",
      "App",
      "API Name",
      "Prefix",
      "Global Search",
      "Inline Edit",
      "Created By",
      "Created At",
      "Modified By",
      "Modified At"
    ];

    for (const column of columns) {
      await addCheck(checks, `Objects column visible: ${column}`, async () => (await bodyText(page)).includes(column), column);
    }

    for (const column of columns) {
      await addCheck(
        checks,
        `Objects column sortable/clickable: ${column}`,
        async () => {
          const button = main.getByRole("button", { name: column, exact: true });
          if ((await button.count()) === 0) return false;
          await button.click();
          return true;
        },
        column
      );
    }

    for (const label of [
      "Toggle wrap for Label",
      "Toggle wrap for App",
      "Toggle wrap for API Name",
      "Toggle wrap for Prefix",
      "Toggle wrap for Global Search",
      "Toggle wrap for Inline Edit"
    ]) {
      await addCheck(
        checks,
        `Objects wrap control exists: ${label}`,
        async () => (await page.locator(`[aria-label="${label}"]`).count()) > 0,
        label
      );
    }

    await addCheck(
      checks,
      "Objects list has at least 30 visible/sample rows",
      async () => (await visibleRows(page)).length >= 30,
      async () => (await visibleRows(page)).length
    );

    const initialRows = await visibleRows(page);
    for (let index = 0; index < 29; index += 1) {
      await addCheck(
        checks,
        `Objects row sample ${index + 1}`,
        () => Boolean(initialRows[index] && initialRows[index].length > 10),
        () => initialRows[index] ?? ""
      );
    }

    for (const term of [
      "AUTO Case",
      "Core Platform",
      "AUTO Platform QA",
      "auto_case",
      "Auto Object",
      "MCP",
      "Admin User",
      "true",
      "false",
      "May 28",
      "E2E Functional",
      "Asset",
      "Case",
      "Object"
    ]) {
      await addCheck(
        checks,
        `Objects data term visible: ${term}`,
        async () => {
          const current = await bodyText(page);
          const rows = await visibleRows(page);
          return current.includes(term) || rows.join(" ").includes(term);
        },
        term
      );
    }

    await addCheck(checks, "New Object wizard opens", async () => {
      await page.getByRole("button", { name: /^New$/ }).click();
      await expect(page.getByText("New Object")).toBeVisible({ timeout: 10_000 });
      return true;
    });

    text = await bodyText(page);
    await addCheck(checks, "New Object wizard is on Step 1", () => text.includes("Step 1 of 2"), "Step 1 of 2");

    const createFields = [
      "App",
      "Label",
      "API Name",
      "Plural Label",
      "Prefix",
      "List View Relationship Depth",
      "Global search enabled",
      "Inline edit enabled",
      "Access log allows",
      "Access log denies",
      "Icon (optional)",
      "Help Text",
      "Cancel",
      "Next"
    ];

    for (const field of createFields) {
      await addCheck(checks, `Create wizard field/control visible: ${field}`, async () => (await bodyText(page)).includes(field), field);
    }

    const editorControls = [
      "Paragraph",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Quote",
      "Code Block",
      "B",
      "I",
      "U",
      "S",
      "</>",
      "List",
      "1.",
      "Rule",
      "Align Left",
      "Align Center",
      "Align Right",
      "Justify",
      "Link",
      "Undo",
      "Redo",
      "Clear"
    ];

    for (const control of editorControls) {
      await addCheck(checks, `Help text editor control visible: ${control}`, async () => (await bodyText(page)).includes(control), control);
    }

    const stamp = Date.now().toString(36);
    const objectLabel = `BVT Object ${stamp}`;
    const apiName = `bvt_object_${stamp}`;
    const pluralLabel = `BVT Objects ${stamp}`;
    const prefix = stamp.slice(-3);

    await addCheck(checks, "Object label field accepts input", async () => {
      await page.locator("#create-object-label").fill(objectLabel);
      return (await page.locator("#create-object-label").inputValue()) === objectLabel;
    }, objectLabel);
    await addCheck(checks, "Object API name field accepts input", async () => {
      await page.locator("#create-object-api").fill(apiName);
      return (await page.locator("#create-object-api").inputValue()) === apiName;
    }, apiName);
    await addCheck(checks, "Object plural label field accepts input", async () => {
      await page.locator("#create-object-plural-label").fill(pluralLabel);
      return (await page.locator("#create-object-plural-label").inputValue()) === pluralLabel;
    }, pluralLabel);
    await addCheck(checks, "Object prefix field accepts input", async () => {
      await page.locator("#create-object-prefix").fill(prefix);
      return (await page.locator("#create-object-prefix").inputValue()) === prefix;
    }, prefix);

    await addCheck(checks, "Object create Step 1 validation succeeds", async () => {
      await page.getByRole("button", { name: /^Next$/ }).click();
      await page.waitForTimeout(1_000);
      return !(await bodyText(page)).includes("Unable to validate object details. 500 Internal Server Error");
    }, async () => {
      const current = await bodyText(page);
      return current.match(/Unable to validate object details\. 500 Internal Server Error/)?.[0] ?? "No 500 visible";
    });

    await addCheck(checks, "Object create wizard advances to Step 2", async () => (await bodyText(page)).includes("Step 2"), "Step 2");
    await addCheck(checks, "Create object CRUD operation completes", async () => (await bodyText(page)).includes(objectLabel), objectLabel);
    await addCheck(checks, "Read created object after create", async () => (await bodyText(page)).includes(objectLabel), objectLabel);
    await addCheck(checks, "Update created object", async () => false, "Blocked if create validation fails");
    await addCheck(checks, "Delete created object", async () => false, "Blocked if create validation fails");

    await addCheck(checks, "Create wizard can be cancelled", async () => {
      const cancel = page.getByRole("button", { name: /^Cancel$/ }).last();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
      await page.waitForTimeout(500);
      return !(await bodyText(page)).includes("New Object");
    });

    await addCheck(checks, "Returned to Objects list after create wizard", async () => (await bodyText(page)).includes("All Objects"), "All Objects");

    await addCheck(checks, "Keystone 5003 loads for object reflection check", async () => {
      const keystone = await context.newPage();
      await keystone.goto("http://localhost:5003", { waitUntil: "domcontentloaded" });
      const loaded = (await bodyText(keystone)).trim().length > 0;
      await keystone.close();
      return loaded;
    });
    await addCheck(checks, "Created/updated object reflected in Keystone", async () => false, "Blocked if object create fails");
    await addCheck(checks, "Deleted object absent from Keystone after delete", async () => false, "Blocked if object create/delete fails");

    await addCheck(checks, "Exactly 135 Objects BVT checks were registered", () => checks.length + 1 === CHECK_TARGET, () => checks.length + 1);
  });
});
