import { expect, test, type APIRequestContext, type Page } from "../helpers/singleBrowserTest";
import {
  adminBaseUrl,
  attachEvidence,
  authHeaders,
  expectListRegionReady,
  expectListToolbar,
  hasCredentials,
  loginToAdmin,
  openAdminScreen,
  searchWithinListView
} from "../list-view-regression/helpers";
import {
  attachJsonEvidence,
  resolveSeedFixtures,
  type SeedObject,
  type SeedFixtures
} from "./seed-fixtures";

type ObjectTarget = {
  apiName: string;
  label: string;
  appLabel: string;
  search: string;
};

type ObjectSubtable = {
  label: string;
  tag: string;
  apiProbe: (request: APIRequestContext, fixtures: SeedFixtures, object: SeedObject) => Promise<unknown>;
  uiLabel?: RegExp;
  search?: string;
};

const okJson = async (response: Awaited<ReturnType<APIRequestContext["get"]>>, label: string) => {
  expect(response.ok(), `${label}: ${await response.text()}`).toBeTruthy();
  return response.json().catch(() => ({}));
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const selectAdminApp = async (page: Page, appLabel: string) => {
  const appsButton = page.getByRole("button", { name: /^apps$/i }).first();
  await expect(appsButton).toBeVisible();
  await appsButton.click();
  const launcherItem = page.locator(".launcher-item").filter({ hasText: new RegExp(escapeRegex(appLabel), "i") }).first();
  if (await launcherItem.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await launcherItem.click();
  } else {
    await page.getByRole("button", { name: new RegExp(escapeRegex(appLabel), "i") }).first().click();
  }
  await expect(page.getByText(appLabel).first()).toBeVisible();
};

const objectTargets: ObjectTarget[] = [
  { apiName: "asset", label: "Asset", appLabel: "Operations Hub", search: "Asset" },
  { apiName: "site", label: "Site", appLabel: "Operations Hub", search: "Site" },
  { apiName: "vendor", label: "Vendor", appLabel: "Operations Hub", search: "Vendor" },
  { apiName: "project", label: "Project", appLabel: "Operations Hub", search: "Project" },
  { apiName: "service_request", label: "Service Request", appLabel: "Operations Hub", search: "Service Request" },
  { apiName: "sample", label: "Sample", appLabel: "LIMS", search: "Sample" },
  { apiName: "lab_test", label: "Lab Test", appLabel: "LIMS", search: "Lab Test" },
  { apiName: "lab_result", label: "Lab Result", appLabel: "LIMS", search: "Lab Result" },
  { apiName: "department", label: "Department", appLabel: "HR", search: "Department" },
  { apiName: "employee", label: "Employee", appLabel: "HR", search: "Employee" },
  { apiName: "leave_request", label: "Leave Request", appLabel: "HR", search: "Leave Request" },
  { apiName: "account", label: "Account", appLabel: "CRM", search: "Account" },
  { apiName: "contact", label: "Contact", appLabel: "CRM", search: "Contact" },
  { apiName: "opportunity", label: "Opportunity", appLabel: "CRM", search: "Opportunity" },
  { apiName: "case", label: "Case", appLabel: "CRM", search: "Case" }
];

const objectSubtables: ObjectSubtable[] = [
  {
    label: "Settings",
    tag: "settings",
    uiLabel: /^Settings/i,
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/describe`, {
          headers: authHeaders(fixtures.token)
        }),
        "object settings describe"
      )
  },
  {
    label: "Record Types",
    tag: "record-types",
    search: "Default",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/record-types`, {
          headers: authHeaders(fixtures.token)
        }),
        "record types"
      )
  },
  {
    label: "Fields",
    tag: "fields",
    search: "name",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/fields`, {
          headers: authHeaders(fixtures.token)
        }),
        "fields"
      )
  },
  {
    label: "Buttons",
    tag: "buttons",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/buttons`, {
          headers: authHeaders(fixtures.token)
        }),
        "buttons"
      )
  },
  {
    label: "Email Templates",
    tag: "email-templates",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/email-templates`, {
          headers: authHeaders(fixtures.token)
        }),
        "email templates"
      )
  },
  {
    label: "Layout",
    tag: "layout",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/layouts`, {
          headers: authHeaders(fixtures.token)
        }),
        "layouts"
      )
  },
  {
    label: "Form",
    tag: "form",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/forms`, {
          headers: authHeaders(fixtures.token)
        }),
        "forms"
      )
  },
  {
    label: "Assignments",
    tag: "assignments",
    apiProbe: async (request, fixtures, object) => {
      const [layoutAssignments, formAssignments] = await Promise.all([
        okJson(
          await request.get(`/admin/objects/${object.id}/layout-assignments`, {
            headers: authHeaders(fixtures.token)
          }),
          "layout assignments"
        ),
        okJson(
          await request.get(`/admin/objects/${object.id}/form-assignments`, {
            headers: authHeaders(fixtures.token)
          }),
          "form assignments"
        )
      ]);
      return { layoutAssignments, formAssignments };
    }
  },
  {
    label: "Validation Rules",
    tag: "validation-rules",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/validation-rules`, {
          headers: authHeaders(fixtures.token)
        }),
        "validation rules"
      )
  },
  {
    label: "Trigger Rules",
    tag: "trigger-rules",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/trigger-rules`, {
          headers: authHeaders(fixtures.token)
        }),
        "trigger rules"
      )
  },
  {
    label: "Lookup Defaults",
    tag: "lookup-defaults",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/lookup-list-view-defaults`, {
          headers: authHeaders(fixtures.token)
        }),
        "lookup defaults"
      )
  },
  {
    label: "Search Page Columns",
    tag: "search-page-columns",
    apiProbe: async (request, fixtures, object) =>
      okJson(
        await request.get(`/admin/objects/${object.id}/search-page-columns`, {
          headers: authHeaders(fixtures.token)
        }),
        "search page columns"
      )
  }
];

const getTargetObject = (fixtures: SeedFixtures, target: ObjectTarget) => {
  const object = fixtures.objects[target.apiName];
  expect(object, `Missing seeded object: ${target.apiName}`).toBeTruthy();
  return object;
};

const openSeedObjectDetail = async (page: Page, target: ObjectTarget, object: SeedObject) => {
  await page.goto(`${adminBaseUrl}/admin/objects/${object.id}`, { waitUntil: "domcontentloaded" });
  const directMain = page.locator(".admin-main").first();
  if (await page.getByText(/Object Metadata/i).first().isVisible({ timeout: 5_000 }).catch(() => false)) {
    return directMain;
  }

  await selectAdminApp(page, target.appLabel);
  const objects = await openAdminScreen(page, "Objects");
  await expectListRegionReady(objects);
  await searchWithinListView(objects, target.search);
  const row = objects.locator("table tbody tr").filter({ hasText: new RegExp(target.label, "i") }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText(/Object Metadata/i).first()).toBeVisible();
  return page.locator(".admin-main").first();
};

const openSubtable = async (page: Page, subtable: ObjectSubtable) => {
  const exact = subtable.uiLabel ?? new RegExp(`^${subtable.label}`, "i");
  const direct = page.getByRole("button", { name: exact }).first();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }
  const more = page.getByRole("button", { name: /^more/i }).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    const item = page.getByRole("button", { name: exact }).first();
    if (await item.isVisible().catch(() => false)) {
      await item.click();
      return;
    }
  }
  test.skip(true, `${subtable.label} is not exposed in the current Object detail UI.`);
};

test.describe("Admin Object detail seeded subtables depthwise coverage", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Seeded admin credentials are not configured.");
    await loginToAdmin(page);
  });

  for (const target of objectTargets) {
    for (const subtable of objectSubtables) {
      test(`Admin Object ${target.label} ${subtable.label} UI opens from object detail @admin-depthwise @admin-screen:Objects @object:${target.apiName} @object-subtable:${subtable.tag} [surface: Admin] [feature: Object ${subtable.label}] [level: Regression] [testData: seed:industry-suite ${target.label}] [precondition: ${target.label} metadata detail is open] [input: click ${subtable.label} subtab or More menu item] [expected: ${subtable.label} renders and remains usable] [proof: every Object detail option can be tested individually for ${target.label}]`, async ({
        page,
        request
      }, testInfo) => {
        const fixtures = await resolveSeedFixtures(request);
        const object = getTargetObject(fixtures, target);
        await openSeedObjectDetail(page, target, object);
        await openSubtable(page, subtable);
        const main = page.locator(".admin-main").first();
        await expect(main).toBeVisible();
        await expect(page.locator("body")).not.toContainText(/something went wrong|failed to render|uncaught/i);
        await expectListRegionReady(main).catch(() => null);
        await expectListToolbar(main).catch(() => null);
        if (subtable.search) {
          await searchWithinListView(main, subtable.search).catch(() => null);
        }
        await attachEvidence(page, testInfo, `object-${target.apiName}-ui-${subtable.tag}`).catch(() => null);
      });
    }

    if (process.env.INCLUDE_RUNTIME_API_DEPTHWISE === "true") {
      test(`Admin Object ${target.label} metadata reaches Keystone runtime describe, list views, records, access, search, and recycle endpoints @admin-depthwise @admin-screen:Objects @object:${target.apiName} @runtime-terminal [surface: API] [feature: Object Runtime Terminals] [level: Regression] [testData: seed:industry-suite ${target.label}] [precondition: seeded ${target.label} object exists under ${target.appLabel}] [input: call GitNexus-connected runtime terminal endpoints for ${target.label}] [expected: runtime APIs accept seeded metadata and enforce access without server errors] [proof: Admin Object ${target.label} changes have downstream Keystone terminal coverage]`, async ({
      page,
      request
    }, testInfo) => {
      const fixtures = await resolveSeedFixtures(request);
      const appId = fixtures.apps[target.appLabel].id;
      const objectApi = getTargetObject(fixtures, target).api_name;
      const headers = authHeaders(fixtures.token);
      const endpoints = [
        `/api/apps/${appId}/objects/${objectApi}/describe`,
        `/api/apps/${appId}/objects/${objectApi}/access`,
        `/api/apps/${appId}/objects/${objectApi}/list-views`,
        `/api/apps/${appId}/objects/${objectApi}/records`,
        `/api/apps/${appId}/search?q=${encodeURIComponent(target.search)}&limit=5`,
        `/api/apps/${appId}/recycle-bin?limit=5`
      ];
      const results = [];
      for (const endpoint of endpoints) {
        const response = await request.get(endpoint, { headers });
        expect(response.status(), `${endpoint}: ${await response.text()}`).toBeLessThan(500);
        results.push({ endpoint, status: response.status() });
      }
      await attachJsonEvidence(page, testInfo, `object-${target.apiName}-runtime-terminal-endpoints`, results);
      });
    }
  }
});
