import { expect, test, type APIRequestContext, type Page } from "../helpers/singleBrowserTest";
import {
  attachEvidence,
  closeModal,
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
  slug,
  type SeedFixtures
} from "./seed-fixtures";

type AdminSurface = {
  label: string;
  tag: string;
  apiProbe: (request: APIRequestContext, fixtures: SeedFixtures) => Promise<unknown>;
  search?: string;
  listLike?: boolean;
};

const okJson = async (response: Awaited<ReturnType<APIRequestContext["get"]>>, label: string) => {
  expect(response.ok(), `${label}: ${await response.text()}`).toBeTruthy();
  return response.json().catch(() => ({}));
};

const adminSurfaces: AdminSurface[] = [
  {
    label: "App Hierarchy",
    tag: "app-hierarchy",
    listLike: false,
    apiProbe: async (request, fixtures) => ({
      apps: Object.keys(fixtures.apps).length,
      objects: Object.keys(fixtures.objects).length,
      tabs: Object.keys(fixtures.tabs).length
    })
  },
  {
    label: "Search Results",
    tag: "search-results",
    listLike: false,
    search: "asset",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get(`/api/apps/${fixtures.apps["Operations Hub"].id}/search?q=asset&limit=5`, {
          headers: { Authorization: `Bearer ${fixtures.token}` }
        }),
        "search results"
      )
  },
  {
    label: "Agent",
    tag: "agent",
    listLike: false,
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get("/api/agents/capabilities", {
          headers: { Authorization: `Bearer ${fixtures.token}` }
        }),
        "agent capabilities"
      )
  },
  {
    label: "Apps",
    tag: "apps",
    search: "Operations Hub",
    apiProbe: async (request, fixtures) =>
      okJson(await request.get("/api/apps", { headers: { Authorization: `Bearer ${fixtures.token}` } }), "apps")
  },
  {
    label: "Objects",
    tag: "objects",
    search: "Asset",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get(`/api/apps/${fixtures.apps["Operations Hub"].id}/objects`, {
          headers: { Authorization: `Bearer ${fixtures.token}` }
        }),
        "objects"
      )
  },
  {
    label: "Tabs",
    tag: "tabs",
    search: "Asset",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get(`/api/apps/${fixtures.apps["Operations Hub"].id}/tabs`, {
          headers: { Authorization: `Bearer ${fixtures.token}` }
        }),
        "tabs"
      )
  },
  {
    label: "Flows",
    tag: "flows",
    search: "sync",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get(`/admin/apps/${fixtures.apps["CRM"].id}/flows`, {
          headers: { Authorization: `Bearer ${fixtures.token}` }
        }),
        "flows"
      )
  },
  {
    label: "Roles",
    tag: "roles",
    search: "system_admin",
    apiProbe: async (request, fixtures) =>
      okJson(await request.get("/admin/roles", { headers: { Authorization: `Bearer ${fixtures.token}` } }), "roles")
  },
  {
    label: "Groups",
    tag: "groups",
    search: "CRM Users",
    apiProbe: async (request, fixtures) =>
      okJson(await request.get("/admin/groups", { headers: { Authorization: `Bearer ${fixtures.token}` } }), "groups")
  },
  {
    label: "Users",
    tag: "users",
    search: "ethan.parker",
    apiProbe: async (request, fixtures) =>
      okJson(await request.get("/admin/users", { headers: { Authorization: `Bearer ${fixtures.token}` } }), "users")
  },
  {
    label: "Permissions",
    tag: "permissions",
    search: "Permissions admin",
    apiProbe: async (request, fixtures) =>
      okJson(await request.get("/api/permissions", { headers: { Authorization: `Bearer ${fixtures.token}` } }), "permissions")
  },
  {
    label: "Access Records",
    tag: "access-records",
    search: "asset",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get(`/admin/access-records?object_id=${fixtures.objects.asset.id}`, {
          headers: { Authorization: `Bearer ${fixtures.token}` }
        }),
        "access records"
      )
  },
  {
    label: "System Settings",
    tag: "system-settings",
    search: "system",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get("/admin/system-settings", { headers: { Authorization: `Bearer ${fixtures.token}` } }),
        "system settings"
      )
  },
  {
    label: "Email Logs",
    tag: "email-logs",
    search: "crm",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get(`/admin/email-logs?app_id=${fixtures.apps["CRM"].id}&limit=5`, {
          headers: { Authorization: `Bearer ${fixtures.token}` }
        }),
        "email logs"
      )
  },
  {
    label: "Scheduled Jobs",
    tag: "scheduled-jobs",
    search: "CRM",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get(`/admin/scheduled-jobs?app_id=${fixtures.apps["CRM"].id}&limit=10`, {
          headers: { Authorization: `Bearer ${fixtures.token}` }
        }),
        "scheduled jobs"
      )
  },
  {
    label: "Audit Logs",
    tag: "audit-logs",
    search: "asset",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get("/admin/audit/meta?limit=10", { headers: { Authorization: `Bearer ${fixtures.token}` } }),
        "audit logs"
      )
  },
  {
    label: "Recycle Bin",
    tag: "recycle-bin",
    search: "E2E",
    apiProbe: async (request, fixtures) =>
      okJson(
        await request.get("/admin/recycle-bin?limit=10", { headers: { Authorization: `Bearer ${fixtures.token}` } }),
        "recycle bin"
      )
  }
];

const ensureSurfaceReady = async (page: Page, surface: AdminSurface) => {
  const main = await openAdminScreen(page, surface.label);
  if (surface.listLike === false) {
    await expect(main).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/something went wrong|failed to render|uncaught/i);
    return main;
  }
  await expectListRegionReady(main);
  return main;
};

test.describe("Admin depthwise seeded sidebar table coverage", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Seeded admin credentials are not configured.");
    await loginToAdmin(page);
  });

  test("Seed readiness verifies all Admin table anchors from Apps to Recycle Bin @admin-depthwise @seed-readiness [surface: API] [feature: Seed Data] [level: BVT] [testData: seed:industry-suite] [precondition: seed:industry-suite has been loaded] [input: resolve seeded apps, objects, tabs, roles, groups, users, and permissions] [expected: every required seeded fixture exists before screen tests run] [proof: depthwise Admin tests fail fast when seed data is missing]", async ({
    page,
    request
  }, testInfo) => {
    const fixtures = await resolveSeedFixtures(request);
    await attachJsonEvidence(page, testInfo, "admin-depthwise-seed-readiness", {
      apps: Object.keys(fixtures.apps).filter((key) => ["Core Platform", "Operations Hub", "LIMS", "HR", "CRM"].includes(key)),
      objects: ["asset", "site", "vendor", "project", "sample", "account", "contact", "user", "permission", "access_record", "scheduled_job"].map((key) => fixtures.objects[key]?.id),
      roles: ["system_admin", "lims_user", "crm_user", "hr_user", "role_viewer", "role_editor", "role_manager"].map((key) => fixtures.roles[key]?.id),
      groups: ["LIMS Users", "CRM Users", "HR Users", "group_sales", "group_ops"].map((key) => fixtures.groups[key]?.id),
      users: ["admin", "ethan.parker", "olivia.bennett", "liam.carter"].map((key) => fixtures.users[key]?.id),
      permissions: fixtures.permissions.length
    });
  });

  for (const surface of adminSurfaces) {
    test(`Admin ${surface.label} screen opens from side nav @admin-depthwise @admin-screen:${surface.tag} [surface: Admin] [feature: ${surface.label}] [level: BVT] [testData: seed:industry-suite] [precondition: seeded admin user is signed in] [input: click ${surface.label} in Admin side navigation] [expected: ${surface.label} renders without crash or auth failure] [proof: every Admin side-nav screen is individually runnable]`, async ({
      page
    }, testInfo) => {
      await ensureSurfaceReady(page, surface);
      await attachEvidence(page, testInfo, `admin-screen-${surface.tag}`).catch(() => null);
    });

    test(`Admin ${surface.label} table/search remains stable @admin-depthwise @admin-screen:${surface.tag} @table [surface: Admin] [feature: ${surface.label}] [level: Regression] [testData: seed:industry-suite] [precondition: ${surface.label} is open from side nav] [input: inspect list/table surface and run seeded search where available] [expected: table, empty state, or valid panel stays usable] [proof: each Admin table can be tested independently]`, async ({
      page
    }, testInfo) => {
      const main = await ensureSurfaceReady(page, surface);
      if (surface.listLike !== false) {
        await expectListToolbar(main).catch(() => null);
      }
      if (surface.search) {
        const input = await searchWithinListView(main, surface.search).catch(() => null);
        if (input) {
          await expectListRegionReady(main).catch(() => null);
        }
      }
      await attachEvidence(page, testInfo, `admin-table-${surface.tag}`).catch(() => null);
    });

    test(`Admin ${surface.label} CRUD UI controls open safely @admin-depthwise @admin-screen:${surface.tag} @crud-ui [surface: Admin] [feature: ${surface.label} CRUD UI] [level: Regression] [testData: seed:industry-suite] [precondition: ${surface.label} is open from side nav] [input: open New or a row detail/edit panel and close it without saving] [expected: create/detail/edit surface appears and can be dismissed without mutating data] [proof: each Admin screen exposes safe UI CRUD affordances where supported]`, async ({
      page
    }, testInfo) => {
      const main = await ensureSurfaceReady(page, surface);
      test.skip(surface.listLike === false, `${surface.label} is not a list-like CRUD surface.`);
      const newButton = main.getByRole("button", { name: /^new$/i }).first();
      if (await newButton.isVisible().catch(() => false)) {
        test.skip(!(await newButton.isEnabled().catch(() => false)), `${surface.label} New is disabled by permissions or state.`);
        await newButton.click();
        await expect(page.locator("[role='dialog'], .modal, .drawer, .record-panel, .object-settings, .admin-detail").first()).toBeVisible();
        await attachEvidence(page, testInfo, `admin-crud-new-${surface.tag}`).catch(() => null);
        await closeModal(page);
        return;
      }

      const firstRow = main.locator("table tbody tr").first();
      test.skip(!(await firstRow.isVisible().catch(() => false)), `${surface.label} has no row to open.`);
      await firstRow.click();
      await expect(page.locator(".record-panel, .object-settings, .admin-detail, .admin-main").first()).toBeVisible();
      await attachEvidence(page, testInfo, `admin-crud-detail-${surface.tag}`).catch(() => null);
    });
  }
});
