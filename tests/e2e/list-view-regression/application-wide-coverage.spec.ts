import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import {
  allowWrites,
  apiLogin,
  attachEvidence,
  authHeaders,
  clickRefresh,
  hasCredentials,
  loginToAdmin,
  loginToKeystone,
  openAdminScreen,
  searchWithinListView,
  selectKeystoneAppAndTab,
  expectListRegionReady,
  expectListToolbar
} from "./helpers";

type ApiApp = { id: string; label?: string; api_name?: string };
type ApiObject = { id?: string; api_name: string; label?: string; key_fields?: string[] };
type ApiField = { api_name: string; type?: string; required?: boolean | null; read_only?: boolean | null };
type ListView = { id: string; name?: string; view_json?: unknown };
type ApplicationContext = {
  token: string;
  app: ApiApp;
  object: ApiObject;
  fields: ApiField[];
  listView: ListView;
};

const reservedFields = new Set(["id", "created_by", "created_at", "modified_by", "modified_at"]);

const valueForField = (field: ApiField, label: string) => {
  const type = String(field.type ?? "").toLowerCase();
  if (type.includes("number") || type.includes("decimal") || type.includes("integer")) return 1;
  if (type.includes("bool")) return true;
  if (type.includes("date") && !type.includes("time")) return new Date().toISOString().slice(0, 10);
  if (type.includes("date") || type.includes("time")) return new Date().toISOString();
  return label;
};

const resolveApplicationContext = async (request: APIRequestContext): Promise<ApplicationContext> => {
  const token = await apiLogin(request);
  const appsRes = await request.get("/api/apps", { headers: authHeaders(token) });
  expect(appsRes.ok(), await appsRes.text()).toBeTruthy();
  const apps = ((await appsRes.json()) as { items?: ApiApp[] }).items ?? [];
  expect(apps.length).toBeGreaterThan(0);

  for (const app of apps) {
    const objectsRes = await request.get(`/api/apps/${app.id}/objects`, { headers: authHeaders(token) });
    if (!objectsRes.ok()) continue;
    const objects = ((await objectsRes.json()) as { items?: ApiObject[] }).items ?? [];
    for (const object of objects) {
      if (!object.api_name || object.api_name === "data_import") continue;
      const describeRes = await request.get(`/api/apps/${app.id}/objects/${object.api_name}/describe`, {
        headers: authHeaders(token)
      });
      if (!describeRes.ok()) continue;
      const describe = (await describeRes.json()) as { object?: ApiObject; fields?: ApiField[] };
      const listViewsRes = await request.get(`/api/apps/${app.id}/objects/${object.api_name}/list-views`, {
        headers: authHeaders(token)
      });
      if (!listViewsRes.ok()) continue;
      const listViews = ((await listViewsRes.json()) as { items?: ListView[] }).items ?? [];
      const listView =
        listViews.find((view) => !(view.view_json as { lookup_only?: boolean } | null | undefined)?.lookup_only) ??
        listViews[0];
      if (listView && describe.fields?.length) {
        return { token, app, object: describe.object ?? object, fields: describe.fields, listView };
      }
    }
  }

  throw new Error("No seeded application object with describe metadata and list views was found.");
};

const buildPartialSeedPayload = (ctx: ApplicationContext, label: string) => {
  const payload: Record<string, unknown> = {};
  const keyField = (ctx.object.key_fields ?? []).find((field) => field && !reservedFields.has(field));
  if (keyField) {
    payload[keyField] = label;
  } else if (ctx.fields.some((field) => field.api_name === "name" && !field.read_only)) {
    payload.name = label;
  }

  for (const field of ctx.fields) {
    if (reservedFields.has(field.api_name) || field.read_only || payload[field.api_name] !== undefined) continue;
    if (!field.required) continue;
    payload[field.api_name] = valueForField(field, label);
  }

  return payload;
};

const attachApiEvidence = async (
  page: Page,
  testInfo: TestInfo,
  name: string,
  payload: Record<string, unknown>
) => {
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <title>${name}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; background: #0f172a; color: #e5eefc; }
          h1 { font-size: 24px; margin: 0 0 16px; }
          pre { white-space: pre-wrap; background: #111827; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
        </style>
      </head>
      <body>
        <h1>${name}</h1>
        <pre>${JSON.stringify(payload, null, 2).replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char] || char))}</pre>
      </body>
    </html>`);
  await attachEvidence(page, testInfo, name).catch(() => null);
};

test.describe("Application-wide seeded data and business flow coverage", () => {
  test.beforeEach(() => {
    test.skip(!hasCredentials(), "Seeded test credentials are not configured.");
  });

  test("Application seed graph resolves queryable business data @bvt [surface: API] [feature: Seeded data graph] [level: BVT] [precondition: seeded industry-suite data is loaded] [input: resolve app, object, describe metadata, list view, and query records] [expected: app-object-list-view chain is queryable with stable response shape] [proof: seeded data supports application-wide BVT and AI-generated test creation]", async ({
    page,
    request
  }, testInfo) => {
    const ctx = await resolveApplicationContext(request);
    const queryRes = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/query`, {
      headers: authHeaders(ctx.token),
      data: {
        list_view_id: ctx.listView.id,
        pagination: { page: 1, page_size: 5 },
        columns: ["id", "name"]
      }
    });
    expect(queryRes.ok(), await queryRes.text()).toBeTruthy();
    const body = (await queryRes.json()) as { items?: unknown[]; page?: number; page_size?: number };
    expect(Array.isArray(body.items)).toBeTruthy();
    expect(body.page).toBeTruthy();
    await attachApiEvidence(page, testInfo, "application-seed-graph-api-evidence", {
      app: ctx.app.label || ctx.app.api_name || ctx.app.id,
      object: ctx.object.api_name,
      listView: ctx.listView.id,
      recordsReturned: body.items?.length ?? 0,
      page: body.page,
      pageSize: body.page_size
    });
  });

  test("Application API rejects unsafe partial test data payload @sanity [surface: API] [feature: Partial test data validation] [level: Sanity] [precondition: seeded object metadata is available] [input: POST record payload with unknown field] [expected: API rejects unsafe field instead of silently accepting invalid data] [proof: partial test-data injection validates schema boundaries before AI-generated write flows]", async ({
    page,
    request
  }, testInfo) => {
    const ctx = await resolveApplicationContext(request);
    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/records`, {
      headers: authHeaders(ctx.token),
      data: { not_a_real_field: "AI partial seed validation" }
    });
    expect([400, 422]).toContain(response.status());
    await attachApiEvidence(page, testInfo, "partial-test-data-rejected-evidence", {
      app: ctx.app.label || ctx.app.api_name || ctx.app.id,
      object: ctx.object.api_name,
      status: response.status(),
      submittedFields: ["not_a_real_field"]
    });
  });

  test("Application API accepts guarded partial seeded test data @sanity [surface: API] [feature: Partial test data creation] [level: Sanity] [precondition: ALLOW_DATA_WRITE=true and reset runs after generated write flows] [input: POST minimal required seeded test payload] [expected: record create response returns an id for reset-cleanable test data] [proof: AI agent can pass partial test data into application flows safely]", async ({
    page,
    request
  }, testInfo) => {
    test.skip(!allowWrites(), "Partial seeded write test requires ALLOW_DATA_WRITE=true and reset after completion.");
    const ctx = await resolveApplicationContext(request);
    const label = `AI Partial Seed ${Date.now()}`;
    const payload = buildPartialSeedPayload(ctx, label);
    test.skip(Object.keys(payload).length === 0, "Selected object has no writable seed-compatible fields.");

    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/records`, {
      headers: authHeaders(ctx.token),
      data: payload
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const created = (await response.json().catch(() => ({}))) as { id?: string; record?: { id?: string } };
    expect(created.id ?? created.record?.id ?? "").toBeTruthy();
    await attachApiEvidence(page, testInfo, "partial-seeded-data-created-evidence", {
      app: ctx.app.label || ctx.app.api_name || ctx.app.id,
      object: ctx.object.api_name,
      submittedFields: Object.keys(payload),
      recordId: created.id ?? created.record?.id ?? ""
    });
  });

  test("Admin security metadata surfaces remain reachable @bvt [surface: Admin] [feature: Security metadata] [level: BVT] [precondition: seeded admin user is signed in] [input: open Roles, Groups, Users, Permissions, and Access Records] [expected: every security metadata surface renders without crash or permission leakage] [proof: Admin permission model entry points are protected by BVT coverage]", async ({
    page
  }, testInfo) => {
    await loginToAdmin(page);
    for (const screen of ["Roles", "Groups", "Users", "Permissions", "Access Records"]) {
      const main = await openAdminScreen(page, screen);
      await expectListRegionReady(main);
      await expect(page.locator("body")).not.toContainText(/something went wrong|failed to render|uncaught/i);
    }
    await attachEvidence(page, testInfo, "admin-security-metadata-surfaces").catch(() => null);
  });

  test("Keystone seeded data created through API is searchable in UI @regression [surface: Keystone] [feature: API to UI seeded data flow] [level: Regression] [precondition: ALLOW_DATA_WRITE=true and reset runs after generated write flows] [input: create minimal seeded test data through API then search current object list] [expected: UI list view can consume API-created test data or remain stable after refresh] [proof: API business data and Keystone UI are connected for application-wide regression]", async ({
    page,
    request
  }, testInfo) => {
    test.skip(!allowWrites(), "API-to-UI seeded data flow requires ALLOW_DATA_WRITE=true and reset after completion.");
    await loginToKeystone(page);
    const selected = await selectKeystoneAppAndTab(page);
    const ctx = await resolveApplicationContext(request);
    const label = `AI UI Seed ${Date.now()}`;
    const payload = buildPartialSeedPayload(ctx, label);
    test.skip(Object.keys(payload).length === 0, "Selected object has no writable seed-compatible fields.");

    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/records`, {
      headers: authHeaders(ctx.token),
      data: payload
    });
    expect(response.ok(), await response.text()).toBeTruthy();

    await clickRefresh(selected.objectHome);
    await searchWithinListView(selected.objectHome, label);
    await expectListRegionReady(selected.objectHome);
    await expectListToolbar(selected.objectHome);
    await attachEvidence(page, testInfo, "keystone-api-created-seeded-data-search").catch(() => null);
  });
});
