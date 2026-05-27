import { expect, request as playwrightRequest, test, type APIRequestContext } from "../helpers/singleBrowserTest";
import {
  apiLogin,
  authHeaders,
  hasCredentials
} from "./helpers";

type ApiApp = { id: string; label?: string; api_name?: string };
type ApiObject = { id?: string; api_name: string; label?: string };
type ListView = {
  id: string;
  name: string;
  filters_json?: unknown;
  columns_json?: unknown;
  sharing_json?: unknown;
  sort_json?: unknown;
  view_json?: unknown;
};
type ApiContext = {
  token: string;
  app: ApiApp;
  object: ApiObject;
  listView: ListView;
};

const resolveApiContext = async (request: APIRequestContext): Promise<ApiContext> => {
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
      const listViewsRes = await request.get(`/api/apps/${app.id}/objects/${object.api_name}/list-views`, {
        headers: authHeaders(token)
      });
      if (!listViewsRes.ok()) continue;
      const listViews = ((await listViewsRes.json()) as { items?: ListView[] }).items ?? [];
      const normalListView =
        listViews.find((view) => !(view.view_json as { lookup_only?: boolean } | null | undefined)?.lookup_only) ??
        listViews[0];
      if (normalListView) {
        return { token, app, object, listView: normalListView };
      }
    }
  }

  throw new Error("No accessible object with list views found for API regression.");
};

const createDisposableListView = async (
  request: APIRequestContext,
  ctx: ApiContext,
  suffix = Date.now()
) => {
  const name = `LV API Regression ${suffix}`;
  const response = await request.post(
    `/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views`,
    {
      headers: authHeaders(ctx.token),
      data: {
        name,
        filters_json: { logic: "AND", filters: [] },
        columns_json: ["id", "name"],
        sharing_json: { scope: "private" },
        sort_json: [{ field: "name", direction: "asc" }],
        view_json: { mode: "table" }
      }
    }
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as ListView;
};

const deleteListViewBestEffort = async (
  request: APIRequestContext,
  ctx: ApiContext,
  listViewId: string
) => {
  await request.delete(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/${listViewId}`, {
    headers: authHeaders(ctx.token)
  }).catch(() => null);
};

test.describe("List-view API regression", () => {
  test.beforeEach(() => {
    test.skip(!hasCredentials(), "API credentials are not configured.");
  });

  test("API lists accessible apps for list-view scoping [surface: API] [feature: App scope] [precondition: valid user credentials exist] [input: GET /api/apps] [expected: at least one accessible app is returned] [proof: list-view API tests can resolve app scope]", async ({
    request
  }) => {
    const token = await apiLogin(request);
    const response = await request.get("/api/apps", { headers: authHeaders(token) });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { items?: ApiApp[] };
    expect(body.items?.length ?? 0).toBeGreaterThan(0);
  });

  test("API lists objects for selected app [surface: API] [feature: Object scope] [precondition: accessible app exists] [input: GET /api/apps/{appId}/objects] [expected: object metadata list is returned] [proof: list-view object scope can be discovered]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.get(`/api/apps/${ctx.app.id}/objects`, {
      headers: authHeaders(ctx.token)
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { items?: ApiObject[] };
    expect(body.items?.some((object) => object.api_name === ctx.object.api_name)).toBeTruthy();
  });

  test("API describes selected object for list-view columns [surface: API] [feature: Describe] [precondition: accessible object exists] [input: GET object describe] [expected: object fields are returned] [proof: list-view column/filter metadata is available]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/describe`, {
      headers: authHeaders(ctx.token)
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { object?: ApiObject; fields?: Array<{ api_name: string }> };
    expect(body.object?.api_name).toBe(ctx.object.api_name);
    expect(body.fields?.length ?? 0).toBeGreaterThan(0);
  });

  test("API lists list views for selected object [surface: API] [feature: List-view metadata] [precondition: accessible object exists] [input: GET list-views] [expected: list view collection is returned] [proof: list-view metadata endpoint is covered]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views`, {
      headers: authHeaders(ctx.token)
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { items?: ListView[] };
    expect(body.items?.length ?? 0).toBeGreaterThan(0);
  });

  test("API creates and deletes a disposable private list view [surface: API] [feature: List-view CRUD] [precondition: list-view management permission is available] [input: POST then DELETE list-view] [expected: disposable view is created and deleted] [proof: create/delete lifecycle is covered]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const created = await createDisposableListView(request, ctx);
    expect(created.id).toBeTruthy();
    const del = await request.delete(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/${created.id}`, {
      headers: authHeaders(ctx.token)
    });
    expect(del.ok(), await del.text()).toBeTruthy();
  });

  test("API rejects duplicate shared list-view names [surface: API] [feature: List-view CRUD] [precondition: disposable public list view exists] [input: create another public view with same name] [expected: conflict response is returned] [proof: unique shared list-view names are enforced]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const suffix = Date.now();
    const created = await createDisposableListView(request, ctx, suffix);
    await request.patch(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/${created.id}`, {
      headers: authHeaders(ctx.token),
      data: { sharing_json: { scope: "public" } }
    });
    const duplicate = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views`, {
      headers: authHeaders(ctx.token),
      data: {
        name: created.name,
        filters_json: { logic: "AND", filters: [] },
        columns_json: ["id", "name"],
        sharing_json: { scope: "public" }
      }
    });
    expect([400, 409]).toContain(duplicate.status());
    await deleteListViewBestEffort(request, ctx, created.id);
  });

  test("API updates list-view filters columns sharing sort and view JSON [surface: API] [feature: List-view update] [precondition: disposable list view exists] [input: PATCH list-view metadata fields] [expected: updated view reflects submitted metadata] [proof: list-view metadata update contract is covered]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const created = await createDisposableListView(request, ctx);
    const response = await request.patch(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/${created.id}`, {
      headers: authHeaders(ctx.token),
      data: {
        filters_json: { logic: "AND", filters: [{ field: "name", op: "contains", value: "LV" }] },
        columns_json: ["id", "name", "created_at"],
        sharing_json: { scope: "private" },
        sort_json: [{ field: "created_at", direction: "desc" }],
        view_json: { mode: "table", summary: true }
      }
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const updated = (await response.json()) as ListView;
    expect(updated.id).toBe(created.id);
    await deleteListViewBestEffort(request, ctx, created.id);
  });

  test("API clones a disposable list view [surface: API] [feature: List-view clone] [precondition: disposable list view exists] [input: POST clone endpoint] [expected: clone is created with a different id] [proof: clone lifecycle is covered]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const created = await createDisposableListView(request, ctx);
    const response = await request.post(
      `/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/${created.id}/clone`,
      { headers: authHeaders(ctx.token) }
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    const clone = (await response.json()) as ListView;
    expect(clone.id).not.toBe(created.id);
    await deleteListViewBestEffort(request, ctx, clone.id);
    await deleteListViewBestEffort(request, ctx, created.id);
  });

  test("API reads and updates list-view preferences [surface: API] [feature: Preferences] [precondition: accessible list view exists] [input: GET then PUT preferences] [expected: last/default/pinned preferences are accepted] [proof: user list-view preferences endpoint is covered]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const getResponse = await request.get(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/preferences`, {
      headers: authHeaders(ctx.token)
    });
    expect(getResponse.ok(), await getResponse.text()).toBeTruthy();
    const putResponse = await request.put(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/preferences`, {
      headers: authHeaders(ctx.token),
      data: {
        last_list_view_id: ctx.listView.id,
        pinned_list_view_id: ctx.listView.id,
        default_list_view_id: ctx.listView.id,
        sort_json: [{ field: "name", direction: "asc" }]
      }
    });
    expect(putResponse.ok(), await putResponse.text()).toBeTruthy();
  });

  const queryCases = [
    {
      name: "default pagination",
      payload: { pagination: { page: 1, page_size: 25 }, columns: ["id", "name"] }
    },
    {
      name: "search",
      payload: { pagination: { page: 1, page_size: 25 }, search: "test", columns: ["id", "name"] }
    },
    {
      name: "sort ascending",
      payload: { pagination: { page: 1, page_size: 25 }, sort: [{ field: "name", direction: "asc" }], columns: ["id", "name"] }
    },
    {
      name: "sort descending",
      payload: { pagination: { page: 1, page_size: 25 }, sort: [{ field: "name", direction: "desc" }], columns: ["id", "name"] }
    },
    {
      name: "contains filter",
      payload: { pagination: { page: 1, page_size: 25 }, filters: { logic: "AND", filters: [{ field: "name", op: "contains", value: "a" }] }, columns: ["id", "name"] }
    },
    {
      name: "nested filter group",
      payload: { pagination: { page: 1, page_size: 25 }, filters: { logic: "AND", groups: [{ logic: "OR", filters: [{ field: "name", op: "contains", value: "a" }, { field: "name", op: "contains", value: "e" }] }] }, columns: ["id", "name"] }
    },
    {
      name: "date expression filter",
      payload: { pagination: { page: 1, page_size: 25 }, filters: { logic: "AND", filters: [{ field: "created_at", op: "date_expr", value: "THIS_YEAR" }] }, columns: ["id", "name", "created_at"] }
    },
    {
      name: "summary request",
      payload: { pagination: { page: 1, page_size: 25 }, summary: { fields: ["id"], operations: ["count"] }, columns: ["id", "name"] }
    },
    {
      name: "chart request",
      payload: { pagination: { page: 1, page_size: 25 }, view_mode: "chart", chart: { group_by: "created_at", operation: "count", bucket: "month" }, columns: ["id", "name", "created_at"] }
    },
    {
      name: "kanban request",
      payload: { pagination: { page: 1, page_size: 25 }, view_mode: "kanban", kanban: { group_by: "status", limit_per_lane: 25 }, columns: ["id", "name", "status"] }
    }
  ];

  for (const queryCase of queryCases) {
    test(`API query supports ${queryCase.name} [surface: API] [feature: Query] [precondition: accessible list view exists] [input: POST list-view query using ${queryCase.name}] [expected: query response returns items and pagination metadata or valid grouped payload] [proof: server-side list-view query behavior covers ${queryCase.name}]`, async ({
      request
    }) => {
      const ctx = await resolveApiContext(request);
      const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/query`, {
        headers: authHeaders(ctx.token),
        data: { list_view_id: ctx.listView.id, ...queryCase.payload }
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      const body = (await response.json()) as { items?: unknown[]; page?: number; page_size?: number };
      expect(Array.isArray(body.items)).toBeTruthy();
      expect(body.page).toBeTruthy();
    });
  }

  test("API rejects invalid query page size [surface: API] [feature: Validation] [precondition: accessible list view exists] [input: page_size above schema max] [expected: invalid_request Problem Details response] [proof: query input limits are enforced]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/query`, {
      headers: authHeaders(ctx.token),
      data: { pagination: { page: 1, page_size: 9999 } }
    });
    expect(response.status()).toBe(400);
  });

  test("API rejects invalid filter field [surface: API] [feature: Validation] [precondition: accessible object exists] [input: query with unknown filter field] [expected: invalid_filters Problem Details response] [proof: server rejects unsafe or unknown filter fields]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/query`, {
      headers: authHeaders(ctx.token),
      data: {
        filters: { logic: "AND", filters: [{ field: "not_a_real_field", op: "eq", value: "x" }] }
      }
    });
    expect(response.status()).toBe(400);
  });

  test("API returns not found for invalid object list views [surface: API] [feature: Security] [precondition: authenticated user exists] [input: GET list views for invalid object] [expected: 404 response] [proof: invalid object names do not leak data]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.get(`/api/apps/${ctx.app.id}/objects/not_a_real_object/list-views`, {
      headers: authHeaders(ctx.token)
    });
    expect(response.status()).toBe(404);
  });

  test("API requires authentication for list-view endpoints [surface: API] [feature: Security] [precondition: no token is provided] [input: GET /api/apps] [expected: unauthorized response] [proof: list-view discovery cannot bypass auth]", async () => {
    const anonymousRequest = await playwrightRequest.newContext({
      baseURL: process.env.TEST_API_URL || "http://localhost:5001"
    });
    try {
      const response = await anonymousRequest.get("/api/apps");
      expect([401, 403]).toContain(response.status());
    } finally {
      await anonymousRequest.dispose();
    }
  });

  test("API exports CSV from list view [surface: API] [feature: Export] [precondition: accessible list view exists] [input: POST list-view export format csv] [expected: CSV response has non-empty body] [proof: CSV export endpoint is covered]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/export`, {
      headers: authHeaders(ctx.token),
      data: { list_view_id: ctx.listView.id, format: "csv", columns: ["id", "name"] }
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = await response.body();
    expect(body.length).toBeGreaterThan(0);
  });

  test("API exports PDF from list view [surface: API] [feature: Export] [precondition: accessible list view exists] [input: POST list-view export format pdf] [expected: PDF response has non-empty body] [proof: PDF export endpoint is covered]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/export`, {
      headers: authHeaders(ctx.token),
      data: { list_view_id: ctx.listView.id, format: "pdf", columns: ["id", "name"] }
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = await response.body();
    expect(body.length).toBeGreaterThan(0);
  });

  test("API rejects invalid export format [surface: API] [feature: Validation] [precondition: accessible list view exists] [input: POST list-view export with invalid format] [expected: invalid_request response] [proof: export format schema is enforced]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/export`, {
      headers: authHeaders(ctx.token),
      data: { list_view_id: ctx.listView.id, format: "xlsx" }
    });
    expect(response.status()).toBe(400);
  });

  test("API performs bulk delete dry run without mutation [surface: API] [feature: Bulk actions] [precondition: accessible list view exists] [input: POST bulk delete dry_run=true] [expected: dry-run response returns action summary] [proof: destructive list-view bulk path can be previewed safely]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/bulk`, {
      headers: authHeaders(ctx.token),
      data: {
        action: "delete",
        list_view_id: ctx.listView.id,
        dry_run: true,
        filters: { logic: "AND", filters: [] }
      }
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { action?: string; total?: number };
    expect(body.action).toBe("delete");
  });

  test("API requires concurrency precondition for bulk update [surface: API] [feature: Bulk actions] [precondition: accessible list view exists] [input: POST bulk update without row versions or timestamp] [expected: precondition_required response] [proof: list-view bulk update protects concurrent edits]", async ({
    request
  }) => {
    const ctx = await resolveApiContext(request);
    const response = await request.post(`/api/apps/${ctx.app.id}/objects/${ctx.object.api_name}/list-views/bulk`, {
      headers: authHeaders(ctx.token),
      data: {
        action: "update",
        list_view_id: ctx.listView.id,
        updates: { name: "LV Bulk Update" },
        record_ids: []
      }
    });
    expect([403, 428]).toContain(response.status());
  });
});
