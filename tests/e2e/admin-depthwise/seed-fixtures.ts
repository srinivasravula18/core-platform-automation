import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import {
  apiLogin,
  attachEvidence,
  authHeaders,
  serviceBaseUrl
} from "../list-view-regression/helpers";

export type SeedApp = {
  id: string;
  api_name?: string;
  label?: string;
};

export type SeedObject = {
  id: string;
  app_id?: string;
  api_name: string;
  label?: string;
  key_fields?: string[];
};

export type SeedTab = {
  id: string;
  app_id?: string;
  api_name?: string;
  label?: string;
  object_api_name?: string | null;
};

export type SeedPrincipal = {
  id: string;
  name?: string;
  username?: string;
  label?: string;
  status?: string;
};

export type SeedFixtures = {
  token: string;
  apps: Record<string, SeedApp>;
  objects: Record<string, SeedObject>;
  tabs: Record<string, SeedTab>;
  roles: Record<string, SeedPrincipal>;
  groups: Record<string, SeedPrincipal>;
  users: Record<string, SeedPrincipal>;
  permissions: unknown[];
};

const requiredApps = ["Core Platform", "Operations Hub", "LIMS", "HR", "CRM"];
const requiredObjects = ["asset", "site", "vendor", "project", "sample", "account", "contact"];
const requiredTabs = ["Asset", "Site", "Vendor", "Project", "Sample", "Account", "Contact", "Data Import"];
const requiredRoles = ["system_admin", "lims_user", "crm_user", "hr_user"];
const requiredGroups = ["LIMS Users", "CRM Users", "HR Users"];
const requiredUsers = ["admin", "ethan.parker", "olivia.bennett", "liam.carter"];

const byLabel = <T extends { label?: string; api_name?: string; name?: string; username?: string }>(items: T[]) => {
  const out: Record<string, T> = {};
  for (const item of items) {
    for (const key of [item.label, item.api_name, item.name, item.username].filter(Boolean) as string[]) {
      out[key] = item;
    }
  }
  return out;
};

const readItems = async <T>(request: APIRequestContext, token: string, path: string) => {
  const response = await request.get(path, { headers: authHeaders(token) });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  const body = (await response.json().catch(() => ({}))) as { items?: T[] } | T[];
  return Array.isArray(body) ? body : body.items ?? [];
};

export const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const hasWrites = () => process.env.ALLOW_DATA_WRITE === "true";

export const resolveSeedFixtures = async (request: APIRequestContext): Promise<SeedFixtures> => {
  const token = await apiLogin(request);
  const apps = await readItems<SeedApp>(request, token, "/api/apps");
  const appMap = byLabel(apps);
  const coreApp = appMap["Core Platform"] ?? apps[0];
  expect(coreApp, "Core Platform seed app is required. Run seed:industry-suite.").toBeTruthy();

  const allObjects: SeedObject[] = [];
  const allTabs: SeedTab[] = [];
  for (const app of apps) {
    if (!app.id) continue;
    const [objects, tabs] = await Promise.all([
      readItems<SeedObject>(request, token, `/api/apps/${app.id}/objects`).catch(() => []),
      readItems<SeedTab>(request, token, `/api/apps/${app.id}/tabs`).catch(() => [])
    ]);
    allObjects.push(...objects.map((object) => ({ ...object, app_id: object.app_id ?? app.id })));
    allTabs.push(...tabs.map((tab) => ({ ...tab, app_id: tab.app_id ?? app.id })));
  }

  const [roles, groups, users, permissions] = await Promise.all([
    readItems<SeedPrincipal>(request, token, "/admin/roles"),
    readItems<SeedPrincipal>(request, token, "/admin/groups"),
    readItems<SeedPrincipal>(request, token, "/admin/users"),
    readItems<unknown>(request, token, "/api/permissions")
  ]);

  const fixture: SeedFixtures = {
    token,
    apps: appMap,
    objects: byLabel(allObjects),
    tabs: byLabel(allTabs),
    roles: byLabel(roles),
    groups: byLabel(groups),
    users: byLabel(users),
    permissions
  };

  assertSeedReadiness(fixture);
  return fixture;
};

export const assertSeedReadiness = (fixtures: SeedFixtures) => {
  for (const app of requiredApps) expect(fixtures.apps[app], `Missing seeded app: ${app}`).toBeTruthy();
  for (const object of requiredObjects) expect(fixtures.objects[object], `Missing seeded object: ${object}`).toBeTruthy();
  for (const tab of requiredTabs) expect(fixtures.tabs[tab], `Missing seeded tab: ${tab}`).toBeTruthy();
  for (const role of requiredRoles) expect(fixtures.roles[role], `Missing seeded role: ${role}`).toBeTruthy();
  for (const group of requiredGroups) expect(fixtures.groups[group], `Missing seeded group: ${group}`).toBeTruthy();
  for (const user of requiredUsers) expect(fixtures.users[user], `Missing seeded user: ${user}`).toBeTruthy();
  expect(fixtures.permissions.length, "Seeded permissions are required.").toBeGreaterThan(0);
};

export const attachJsonEvidence = async (
  page: Page,
  testInfo: TestInfo,
  name: string,
  payload: unknown
) => {
  const escaped = JSON.stringify(payload, null, 2).replace(/[<>&]/g, (char) => {
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&amp;";
  });
  await page.setContent(`<!doctype html><meta charset="utf-8"><title>${name}</title><style>body{font-family:Arial,sans-serif;padding:24px;background:#111827;color:#e5e7eb}pre{white-space:pre-wrap;border:1px solid #374151;padding:16px;border-radius:6px}</style><h1>${name}</h1><pre>${escaped}</pre>`);
  await attachEvidence(page, testInfo, name).catch(() => null);
};

export const serviceUrl = serviceBaseUrl;
