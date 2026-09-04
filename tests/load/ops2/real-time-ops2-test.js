/// <reference types="k6" />
// VUs and actions in ops2 test:
// - Admin app VU (admin user): login, list apps/objects, create+delete object/field/tab, list view share change.
// - Shockwave admin VUs (admin user): login, list views/query, search, file ops if supported.
// - Shockwave LIMS VUs (User01-User45): login, LIMS app/tabs, list views/query, search, file ops if supported.
// - Shockwave CRM VUs (User51-User94): login, CRM app/tabs, list views/query, search, file ops if supported.
// - Shockwave HR VUs (User46-50, User95-99): login, HR app/tabs, list views/query, search, file ops if supported.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 403, 404));

const http429Rate = new Rate("http_429_rate");
const http429Count = new Counter("http_429_count");
const TASK_NAMES = [
  "login",
  "refresh",
  "list_apps",
  "list_objects",
  "describe_object",
  "list_views",
  "query_list_view",
  "create_list_view",
  "update_list_view",
  "list_records",
  "update_record",
  "list_files",
  "upload_file",
  "download_file",
  "delete_file",
  "search",
  "admin_create_object",
  "admin_create_field",
  "admin_create_tab",
  "admin_delete_object"
];
const APP_NAMES = ["LIMS", "CRM", "HR"];
const APP_TASK_NAMES = [
  "list_views",
  "query_list_view",
  "update_record",
  "list_records",
  "search",
  "list_files",
  "upload_file",
  "download_file",
  "delete_file",
  "create_list_view",
  "update_list_view"
];
const taskCountMetrics = buildTaskCountCounters(TASK_NAMES);
const taskDurationMetrics = buildTaskTrends(TASK_NAMES);
const taskPassMetrics = buildTaskPassFailCounters(TASK_NAMES, "passed");
const taskFailMetrics = buildTaskPassFailCounters(TASK_NAMES, "failed");
const taskSlowMetrics = buildTaskPassFailCounters(TASK_NAMES, "over_5s");
const appTaskPassMetrics = buildAppTaskCounters(APP_NAMES, APP_TASK_NAMES, "passed");
const appTaskFailMetrics = buildAppTaskCounters(APP_NAMES, APP_TASK_NAMES, "failed");
const latencyBucketMetrics = buildLatencyBuckets();
const slowEndpointCounts = {};

const DEFAULT_API_BASE = "https://ops.acchindra.com";
const API_BASE = __ENV.API_BASE || __ENV.VITE_API_BASE || DEFAULT_API_BASE;

const ADMIN_USERNAME = __ENV.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || "change-me";
const DEFAULT_POOL_USERNAME = __ENV.DEFAULT_POOL_USERNAME || "User01";
const DEFAULT_POOL_PASSWORD = __ENV.DEFAULT_POOL_PASSWORD || "user01test";

const LIMS_APP_LABEL = (__ENV.LIMS_APP_LABEL || "LIMS").trim();
const CRM_APP_LABEL = (__ENV.CRM_APP_LABEL || "CRM").trim();
const LIMS_TABS = parseCsv(__ENV.LIMS_TABS || "lab result,lab test,sample");
const CRM_TABS = parseCsv(__ENV.CRM_TABS || "account,contact,opportunity,case");
const USER_POOL = parseUserPool(__ENV.USER_POOL || "");
const USE_POOL_FOR_SHOCKWAVE = String(__ENV.USE_POOL_FOR_SHOCKWAVE || "1") !== "0";
const SKIP_FILE_OPS = String(__ENV.SKIP_FILE_OPS || "0") !== "0";

const DURATION = __ENV.DURATION || "1m";
const SETUP_WAIT_SECONDS = Number(__ENV.SETUP_WAIT_SECONDS || 30);
const MIN_ITERATION_MS = Number(__ENV.MIN_ITERATION_MS || 1200);
const SESSION_REFRESH_MS = Number(__ENV.SESSION_REFRESH_MS || 3 * 60 * 1000);
const FAILURE_LOG_LIMIT = Number(__ENV.FAILURE_LOG_LIMIT || 50);

const ADMIN_APP_VUS = Number(__ENV.ADMIN_APP_VUS || 1);
const SHOCKWAVE_ADMIN_VUS = Number(__ENV.SHOCKWAVE_ADMIN_VUS || 2);
const LIMS_VUS = Number(__ENV.LIMS_VUS || 12);
const CRM_VUS = Number(__ENV.CRM_VUS || 11);
const HR_VUS = Number(__ENV.HR_VUS || 5);

export const options = {
  scenarios: buildScenarios(DURATION),
  setupTimeout: "3m",
  thresholds: {
    http_req_failed: ["rate<0.10"],
    http_req_duration: ["p(95)<4000"]
  }
};

export const setup = () => {
  sleep(Math.max(0, SETUP_WAIT_SECONDS));
  return { startedAt: Date.now() };
};

const sessions = {
  admin: {
    token: null,
    refreshToken: null,
    lastAuthAt: 0,
    lastRefreshAt: 0,
    appIdByLabel: {},
    lastAppLookupAt: 0,
    tabsByApp: {}
  },
  pool: {
    token: null,
    refreshToken: null,
    lastAuthAt: 0,
    lastRefreshAt: 0,
    appIdByLabel: {},
    lastAppLookupAt: 0,
    tabsByApp: {}
  }
};
const describeCache = {};
const DESCRIBE_CACHE_TTL_MS = 5 * 60 * 1000;

const jsonHeaders = (token) => ({
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  }
});

const authHeaders = (token) => ({
  headers: { Authorization: `Bearer ${token}` }
});

const recordRateLimit = (res) => {
  if (!res) return;
  const is429 = res.status === 429;
  http429Rate.add(is429);
  if (is429) http429Count.add(1);
};

const recordTask = (name, res, ok) => {
  if (!name || !taskCountMetrics[name]) return;
  taskCountMetrics[name].add(1);
  if (typeof ok === "boolean") {
    if (ok) taskPassMetrics[name]?.add(1);
    else taskFailMetrics[name]?.add(1);
  }
  if (typeof ok === "boolean" && !ok) {
    logFailure(name, res);
  }
  if (res && typeof res.timings?.duration === "number" && taskDurationMetrics[name]) {
    taskDurationMetrics[name].add(res.timings.duration);
  }
  if (res && typeof res.timings?.duration === "number" && res.timings.duration > 5000) {
    taskSlowMetrics[name]?.add(1);
    recordSlowEndpoint(res);
  }
  recordLatencyBucket(res);
};

const recordAppTask = (appLabel, name, ok) => {
  if (!appLabel || !name || typeof ok !== "boolean") return;
  const appKey = appLabel.toUpperCase();
  const key = `${appKey}_${name}`;
  appTaskPassMetrics[key]?.add(ok ? 1 : 0);
  appTaskFailMetrics[key]?.add(ok ? 0 : 1);
};

const failureLogState = {
  count: 0
};

function logFailure(task, res) {
  if (failureLogState.count >= FAILURE_LOG_LIMIT) return;
  const status = res?.status ?? "unknown";
  let body = "";
  try {
    body = res?.body ? String(res.body).slice(0, 2000) : "";
  } catch {
    body = "";
  }
  const url = res?.url ?? "";
  console.error(
    `[failure ${failureLogState.count + 1}/${FAILURE_LOG_LIMIT}] ${task} ` +
      `status=${status} url=${url} body=${body}`
  );
  failureLogState.count += 1;
}

const login = (username, password) => {
  const res = http.post(
    `${API_BASE}/auth/login`,
    JSON.stringify({ username, password }),
    { headers: { "Content-Type": "application/json" } }
  );
  recordRateLimit(res);
  const ok = res.status === 200;
  recordTask("login", res, ok);
  if (!ok) return { ok: false, token: null, refreshToken: null };
  const body = res.json();
  return {
    ok: typeof body?.token === "string",
    token: body?.token ?? null,
    refreshToken: body?.refresh_token ?? null
  };
};

const refreshSession = (refreshToken) => {
  if (!refreshToken) return { ok: false, token: null, refreshToken: null };
  const res = http.post(
    `${API_BASE}/auth/refresh`,
    JSON.stringify({ refresh_token: refreshToken }),
    { headers: { "Content-Type": "application/json" } }
  );
  recordRateLimit(res);
  const ok = res.status === 200;
  recordTask("refresh", res, ok);
  if (!ok) return { ok: false, token: null, refreshToken: null };
  const body = res.json();
  return {
    ok: typeof body?.token === "string",
    token: body?.token ?? null,
    refreshToken: body?.refresh_token ?? refreshToken
  };
};

const getSession = (key, username, password) => {
  const entry = sessions[key];
  const now = Date.now();
  if (!entry.token || now - entry.lastAuthAt > 30 * 60 * 1000) {
    const result = login(username, password);
    if (!result.ok || !result.token) return { ok: false, session: null };
    entry.token = result.token;
    entry.refreshToken = result.refreshToken;
    entry.lastAuthAt = now;
    entry.lastRefreshAt = now;
  }
  if (entry.refreshToken && now - entry.lastRefreshAt > SESSION_REFRESH_MS) {
    const refreshed = refreshSession(entry.refreshToken);
    if (refreshed.ok && refreshed.token) {
      entry.token = refreshed.token;
      entry.refreshToken = refreshed.refreshToken;
      entry.lastRefreshAt = now;
    }
  }
  return { ok: true, session: entry };
};

const listApps = (token) => {
  const res = http.get(`${API_BASE}/api/apps`, authHeaders(token));
  recordRateLimit(res);
  recordTask("list_apps", res, res.status === 200);
  if (res.status !== 200) return { ok: false, items: [] };
  const body = res.json();
  return { ok: true, items: Array.isArray(body?.items) ? body.items : [] };
};

const resolveAppIdCached = (session, labelOrApi) => {
  const now = Date.now();
  const key = normalize(labelOrApi || "__default__");
  const cached = session.appIdByLabel?.[key];
  if (cached && now - session.lastAppLookupAt < 2 * 60 * 1000) {
    return cached;
  }
  const appsResult = listApps(session.token);
  if (!appsResult.ok || appsResult.items.length === 0) return null;
  if (!labelOrApi) return appsResult.items[0]?.id ?? null;
  const target = normalize(labelOrApi);
  const match = appsResult.items.find(
    (app) => normalize(app.label) === target || normalize(app.api_name) === target
  );
  const appId = match?.id ?? appsResult.items[0]?.id ?? null;
  session.appIdByLabel[key] = appId;
  session.lastAppLookupAt = now;
  return appId;
};

const listTabsCached = (session, appId) => {
  const cached = session.tabsByApp?.[appId];
  if (cached) return cached;
  const res = http.get(`${API_BASE}/api/apps/${appId}/tabs`, authHeaders(session.token));
  recordRateLimit(res);
  recordTask("list_tabs", res, res.status === 200);
  if (res.status !== 200) return [];
  const body = res.json();
  const items = Array.isArray(body?.items) ? body.items : [];
  session.tabsByApp[appId] = items;
  return items;
};

const listObjects = (token, appId) => {
  const res = http.get(`${API_BASE}/api/apps/${appId}/objects`, authHeaders(token));
  recordRateLimit(res);
  recordTask("list_objects", res, res.status === 200);
  if (res.status !== 200) return { ok: false, items: [] };
  const body = res.json();
  return { ok: true, items: Array.isArray(body?.items) ? body.items : [] };
};

const listViews = (token, appId, objectApi) => {
  const res = http.get(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/list-views`,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("list_views", res, res.status === 200);
  return { ok: res.status === 200 };
};

const describeObject = (token, appId, objectApi) => {
  const cacheKey = `${appId}:${objectApi}`;
  const cached = describeCache[cacheKey];
  const now = Date.now();
  if (cached && now - cached.at < DESCRIBE_CACHE_TTL_MS) {
    return cached.value;
  }
  const res = http.get(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/describe`,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("describe_object", res, res.status === 200);
  if (res.status !== 200) return null;
  try {
    const value = res.json();
    describeCache[cacheKey] = { value, at: now };
    return value;
  } catch {
    return null;
  }
};

const queryListView = (token, appId, objectApi) => {
  const res = http.post(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/list-views/query`,
    JSON.stringify({ page: 1, page_size: 10, sort: [], filters: [] }),
    jsonHeaders(token)
  );
  recordRateLimit(res);
  recordTask("query_list_view", res, res.status === 200);
  return { ok: res.status === 200 };
};

const createListView = (token, appId, objectApi) => {
  const stamp = `${__VU}_${__ITER}_${Date.now()}`;
  const res = http.post(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/list-views`,
    JSON.stringify({
      name: `Load View ${stamp}`,
      filters_json: { type: "and", filters: [] },
      columns_json: [],
      sharing_json: { scope: "private" }
    }),
    jsonHeaders(token)
  );
  recordRateLimit(res);
  recordTask("create_list_view", res, res.status === 201);
  if (res.status !== 201) return { ok: false, id: null };
  const body = res.json();
  return { ok: true, id: body?.id ?? null };
};

const updateListView = (token, appId, objectApi, listViewId) => {
  const res = http.patch(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/list-views/${listViewId}`,
    JSON.stringify({ sharing_json: { scope: "public" } }),
    jsonHeaders(token)
  );
  recordRateLimit(res);
  recordTask("update_list_view", res, res.status === 200);
  return { ok: res.status === 200 };
};

const listRecords = (token, appId, objectApi) => {
  const res = http.get(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records?page=1&page_size=10`,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("list_records", res, res.status === 200);
  if (res.status !== 200) return { ok: false, items: [] };
  const body = res.json();
  return { ok: true, items: Array.isArray(body?.items) ? body.items : [] };
};

const createRecord = (token, appId, objectApi) => {
  const res = http.post(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records`,
    JSON.stringify({ name: `Load ${Date.now()}` }),
    jsonHeaders(token)
  );
  recordRateLimit(res);
  recordTask("create_record", res, res.status === 201);
  if (res.status !== 201) return { ok: false, recordId: null };
  const body = res.json();
  const recordId = body?.id || body?.record_id || body?.recordId || null;
  return { ok: Boolean(recordId), recordId };
};

const updateRecord = (token, appId, objectApi, recordId) => {
  const res = http.patch(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records/${recordId}`,
    JSON.stringify({ name: `Updated ${Date.now()}` }),
    jsonHeaders(token)
  );
  recordRateLimit(res);
  recordTask("update_record", res, res.status === 200);
  return { ok: res.status === 200 };
};

const deleteRecord = (token, appId, objectApi, recordId) => {
  const res = http.del(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records/${recordId}`,
    null,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("delete_record", res, res.status === 200);
  return { ok: res.status === 200 };
};

const listRecordFiles = (token, appId, objectApi, recordId, fieldApi) => {
  const fieldParam = fieldApi ? `?field=${encodeURIComponent(fieldApi)}` : "";
  const res = http.get(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records/${recordId}/files${fieldParam}`,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("list_files", res, res.status === 200);
  return { ok: res.status === 200, items: res.status === 200 ? res.json()?.items ?? [] : [] };
};

const uploadRecordFile = (token, appId, objectApi, recordId, fieldApi) => {
  if (!fieldApi) return { ok: false, fileId: null };
  const res = http.post(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records/${recordId}/files?field=${encodeURIComponent(
      fieldApi
    )}`,
    { file: http.file("load-test", "load-test.txt", "text/plain") },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  recordRateLimit(res);
  recordTask("upload_file", res, res.status === 201);
  if (res.status !== 201) return { ok: false, fileId: null };
  const body = res.json();
  return { ok: true, fileId: body?.file_id || body?.id || body?.fileId || null };
};

const downloadFile = (token, fileId) => {
  const res = http.get(`${API_BASE}/api/files/${fileId}/download`, authHeaders(token));
  recordRateLimit(res);
  recordTask("download_file", res, res.status === 200);
  return { ok: res.status === 200 };
};

const deleteFile = (token, fileId) => {
  const res = http.del(`${API_BASE}/api/files/${fileId}`, null, authHeaders(token));
  recordRateLimit(res);
  recordTask("delete_file", res, res.status === 200);
  return { ok: res.status === 200 };
};

const searchApp = (token, appId, query) => {
  const res = http.get(
    `${API_BASE}/api/apps/${appId}/search?q=${encodeURIComponent(query)}`,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("search", res, res.status === 200);
  return { ok: res.status === 200 };
};

const adminCreateObjectAndField = (token, appId) => {
  const stamp = `${__VU}_${__ITER}_${Date.now()}`;
  const apiName = `load_obj_${stamp}`;
  const objectRes = http.post(
    `${API_BASE}/admin/apps/${appId}/objects`,
    JSON.stringify({
      api_name: apiName,
      label: `Load Obj ${stamp}`,
      id_prefix: buildIdPrefix(),
      global_search_enabled: false,
      inline_edit_enabled: true,
      list_view_relationship_depth: 2
    }),
    jsonHeaders(token)
  );
  recordRateLimit(objectRes);
  recordTask("admin_create_object", objectRes, objectRes.status === 201);
  if (objectRes.status !== 201) return { ok: false, objectId: null };
  const object = objectRes.json();
  const fieldRes = http.post(
    `${API_BASE}/admin/objects/${object.id}/fields`,
    JSON.stringify({
      api_name: `load_field_${stamp}`,
      label: `Load Field ${stamp}`,
      type: "text",
      required: false,
      searchable: true
    }),
    jsonHeaders(token)
  );
  recordRateLimit(fieldRes);
  recordTask("admin_create_field", fieldRes, fieldRes.status === 201);
  const tabRes = http.post(
    `${API_BASE}/admin/apps/${appId}/tabs`,
    JSON.stringify({
      api_name: `load_tab_${stamp}`,
      label: `Load Tab ${stamp}`,
      object_id: object.id
    }),
    jsonHeaders(token)
  );
  recordRateLimit(tabRes);
  recordTask("admin_create_tab", tabRes, tabRes.status === 201);
  return { ok: true, objectId: object.id, apiName };
};

const adminDeleteObject = (token, objectId) => {
  if (!objectId) return { ok: false };
  const res = http.del(`${API_BASE}/admin/objects/${objectId}`, null, authHeaders(token));
  recordRateLimit(res);
  recordTask("admin_delete_object", res, res.status === 200 || res.status === 204);
  return { ok: res.status === 200 || res.status === 204 };
};

function adminOpsFlow() {
  const startedAt = Date.now();
  const sessionResult = getSession("admin", ADMIN_USERNAME, ADMIN_PASSWORD);
  if (!sessionResult.ok || !sessionResult.session?.token) return pace(startedAt);
  const token = sessionResult.session.token;
  const apps = listApps(token);
  if (!apps.ok || apps.items.length === 0) return pace(startedAt);
  const appId = apps.items[0].id;
  const objects = listObjects(token, appId);
  if (objects.ok && objects.items.length > 0) {
    const objectApi = objects.items[0].api_name || objects.items[0].apiName;
    const listViewsResult = listViews(token, appId, objectApi);
    recordAppTask("ADMIN", "list_views", listViewsResult.ok);
    if (listViewsResult.ok) {
      const created = createListView(token, appId, objectApi);
      recordAppTask("ADMIN", "create_list_view", created.ok);
      if (created.ok && created.id) {
        updateListView(token, appId, objectApi, created.id);
        recordAppTask("ADMIN", "update_list_view", true);
      }
    }
  }
  const created = adminCreateObjectAndField(token, appId);
  pace(startedAt);
}

function shockwaveOpsFlow(sessionKey, username, password, appLabel, allowedTabs) {
  const startedAt = Date.now();
  const sessionResult = getSession(sessionKey, username, password);
  if (!sessionResult.ok || !sessionResult.session?.token) return pace(startedAt);
  const session = sessionResult.session;
  const token = session.token;
  const appId = resolveAppIdCached(session, appLabel);
  if (!appId) return pace(startedAt);
  const tabs = listTabsCached(session, appId);
  const allowedSet = new Set((allowedTabs || []).map((label) => normalize(label)));
  const target = tabs.find((tab) => allowedSet.has(normalize(tab.label))) ?? tabs[0];
  const objectApi = target?.object_api_name || target?.api_name;
  if (!objectApi) return pace(startedAt);
  const listViewsResult = listViews(token, appId, objectApi);
  recordAppTask(appLabel, "list_views", listViewsResult.ok);
  const query = queryListView(token, appId, objectApi);
  recordAppTask(appLabel, "query_list_view", query.ok);
  const search = searchApp(token, appId, "load");
  recordAppTask(appLabel, "search", search.ok);
  const records = listRecords(token, appId, objectApi);
  recordAppTask(appLabel, "list_records", records.ok);
  const recordId = records.items[0]?.id || records.items[0]?.record_id || records.items[0]?.recordId;
  if (!recordId) return pace(startedAt);
  if (!SKIP_FILE_OPS) {
    const describe = describeObject(token, appId, objectApi);
    const fileField = pickFileField(describe?.fields || []);
    if (!fileField) return pace(startedAt);
    const upload = uploadRecordFile(token, appId, objectApi, recordId, fileField);
    recordAppTask(appLabel, "upload_file", upload.ok);
    if (upload.ok && upload.fileId) {
      const downloaded = downloadFile(token, upload.fileId);
      recordAppTask(appLabel, "download_file", downloaded.ok);
      const deleted = deleteFile(token, upload.fileId);
      recordAppTask(appLabel, "delete_file", deleted.ok);
    }
  }
  pace(startedAt);
}

export const adminFlow = () => adminOpsFlow();
export const shockwaveAdminFlow = () =>
  shockwaveOpsFlow("admin", ADMIN_USERNAME, ADMIN_PASSWORD, "", []);
export const shockwaveLimsFlow = () => {
  const creds = resolveGroupCredentials("LIMS");
  const scope = resolveUserScope(creds.username);
  shockwaveOpsFlow("pool", creds.username, creds.password, scope.appLabel, scope.tabs);
};
export const shockwaveCrmFlow = () => {
  const creds = resolveGroupCredentials("CRM");
  const scope = resolveUserScope(creds.username);
  shockwaveOpsFlow("pool", creds.username, creds.password, scope.appLabel, scope.tabs);
};
export const shockwaveHrFlow = () => {
  const creds = resolveGroupCredentials("HR");
  const scope = resolveUserScope(creds.username);
  shockwaveOpsFlow("pool", creds.username, creds.password, scope.appLabel, scope.tabs);
};

function parseCsv(raw) {
  return String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseUserPool(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,;|]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [username, password] = entry.split(":");
      return {
        username: String(username || "").trim(),
        password: String(password || "").trim()
      };
    })
    .filter((entry) => entry.username.length > 0 && entry.password.length > 0);
}

function resolvePoolCredentials(pool, fallbackUsername, fallbackPassword, offset) {
  if (!USE_POOL_FOR_SHOCKWAVE || !pool || pool.length === 0) {
    return { username: fallbackUsername, password: fallbackPassword };
  }
  const base = Number.isFinite(offset) ? offset : 0;
  const index = (base + (__VU - 1)) % pool.length;
  return pool[index] ?? { username: fallbackUsername, password: fallbackPassword };
}

function resolveGroupCredentials(group) {
  const pools = buildGroupPools();
  if (group === "LIMS" && pools.lims.length > 0) {
    return pools.lims[(__VU - 1) % pools.lims.length];
  }
  if (group === "CRM" && pools.crm.length > 0) {
    return pools.crm[(__VU - 1) % pools.crm.length];
  }
  if (group === "HR" && pools.hr.length > 0) {
    return pools.hr[(__VU - 1) % pools.hr.length];
  }
  return { username: DEFAULT_POOL_USERNAME, password: DEFAULT_POOL_PASSWORD };
}

function buildGroupPools() {
  const lims = [];
  const crm = [];
  const hr = [];
  for (const entry of USER_POOL) {
    const scope = resolveUserScope(entry.username);
    if (scope.appLabel === LIMS_APP_LABEL) lims.push(entry);
    else if (scope.appLabel === CRM_APP_LABEL) crm.push(entry);
    else if (scope.appLabel === "HR") hr.push(entry);
  }
  return { lims, crm, hr };
}

function resolveUserScope(username) {
  const match = /^User(\d{2})$/i.exec(String(username));
  const num = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(num)) {
    return { appLabel: "", tabs: [] };
  }
  if (num >= 1 && num <= 45) {
    return { appLabel: LIMS_APP_LABEL, tabs: LIMS_TABS };
  }
  if ((num >= 46 && num <= 50) || (num >= 95 && num <= 99)) {
    return { appLabel: "HR", tabs: ["department", "employee", "leave request"] };
  }
  if (num >= 51 && num <= 94) {
    return { appLabel: CRM_APP_LABEL, tabs: CRM_TABS };
  }
  return { appLabel: "", tabs: [] };
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function pace(startedAtMs) {
  const elapsed = Date.now() - startedAtMs;
  const remaining = MIN_ITERATION_MS - elapsed;
  if (remaining > 0) {
    sleep(remaining / 1000);
  }
}

function buildScenarios(duration) {
  const scenarios = {};
  if (ADMIN_APP_VUS > 0) {
    scenarios.adminFlow = {
      executor: "constant-vus",
      vus: ADMIN_APP_VUS,
      duration,
      exec: "adminFlow"
    };
  }
  if (SHOCKWAVE_ADMIN_VUS > 0) {
    scenarios.shockwaveAdminFlow = {
      executor: "constant-vus",
      vus: SHOCKWAVE_ADMIN_VUS,
      duration,
      exec: "shockwaveAdminFlow"
    };
  }
  if (LIMS_VUS > 0) {
    scenarios.shockwaveLimsFlow = {
      executor: "constant-vus",
      vus: LIMS_VUS,
      duration,
      exec: "shockwaveLimsFlow"
    };
  }
  if (CRM_VUS > 0) {
    scenarios.shockwaveCrmFlow = {
      executor: "constant-vus",
      vus: CRM_VUS,
      duration,
      exec: "shockwaveCrmFlow"
    };
  }
  if (HR_VUS > 0) {
    scenarios.shockwaveHrFlow = {
      executor: "constant-vus",
      vus: HR_VUS,
      duration,
      exec: "shockwaveHrFlow"
    };
  }
  return scenarios;
}

export function handleSummary(data) {
  const reqs = data.metrics?.http_reqs?.values?.count ?? 0;
  const reqRate = data.metrics?.http_reqs?.values?.rate ?? 0;
  const duration = data.metrics?.http_req_duration?.values ?? {};
  const rate = data.metrics?.http_429_rate?.values?.rate ?? 0;
  const count = data.metrics?.http_429_count?.values?.count ?? 0;
  const taskSummaryLines = buildTaskSummaryLines(data);
  const slowSummaryLines = buildSlowSummaryLines(data);
  const slowEndpointLines = buildSlowEndpointLines();
  const appTaskSummaryLines = buildAppTaskSummaryLines(data);
  const latencyLines = buildLatencyBucketLines(data);
  const summaryLines = [
    `requests_per_second: ${reqRate.toFixed(2)}`,
    `http_req_duration_avg_ms: ${(duration.avg ?? 0).toFixed(2)}`,
    `http_req_duration_min_ms: ${(duration.min ?? 0).toFixed(2)}`,
    `http_req_duration_max_ms: ${(duration.max ?? 0).toFixed(2)}`
  ];
  const rateLines = [
    `http_429_count: ${count}`,
    `http_429_rate: ${(rate * 100).toFixed(2)}%`,
    `http_reqs: ${reqs}`
  ];
  const lines = [
    "",
    "Summary",
    ...summaryLines,
    "",
    "Latency Buckets",
    ...latencyLines,
    "",
    "Slow Requests (>5s)",
    ...slowSummaryLines,
    "",
    "Slow Endpoints (>5s)",
    ...slowEndpointLines,
    "",
    "Task Results",
    ...taskSummaryLines,
    "",
    "App Task Results",
    ...appTaskSummaryLines,
    "",
    "429 Summary",
    ...rateLines
  ];
  const html = buildHtmlReport({
    summaryLines,
    latencyLines,
    slowSummaryLines,
    slowEndpointLines,
    taskSummaryLines,
    appTaskSummaryLines,
    rateLines
  });
  return {
    stdout: `${lines.join("\n")}\n`,
    "ops2-summary.html": html
  };
}

function buildHtmlReport(sections) {
  const summaryRows = buildKeyValueRows(sections.summaryLines);
  const latencyRows = buildKeyValueRows(sections.latencyLines);
  const slowRows = buildKeyValueRows(sections.slowSummaryLines);
  const slowEndpointRows = buildKeyValueRows(sections.slowEndpointLines);
  const taskRows = buildKeyValueRows(sections.taskSummaryLines);
  const appTaskRows = buildKeyValueRows(sections.appTaskSummaryLines);
  const rateRows = buildKeyValueRows(sections.rateLines);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Ops2 Load Test Report</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: "Segoe UI", Arial, sans-serif; margin: 24px; color: #1f2937; background: #f8fafc; }
    h1 { font-size: 22px; margin: 0 0 16px; }
    h2 { font-size: 16px; margin: 20px 0 8px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef2f7; }
    th { color: #6b7280; font-weight: 600; width: 45%; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <h1>Ops2 Load Test Report</h1>
  <div class="grid">
    <div class="card">
      <h2>Summary</h2>
      <table>${summaryRows}</table>
    </div>
    <div class="card">
      <h2>Latency Buckets</h2>
      <table>${latencyRows}</table>
    </div>
    <div class="card">
      <h2>Slow Requests (&gt;5s)</h2>
      <table>${slowRows}</table>
    </div>
    <div class="card">
      <h2>Slow Endpoints (&gt;5s)</h2>
      <table>${slowEndpointRows}</table>
    </div>
    <div class="card">
      <h2>429 Summary</h2>
      <table>${rateRows}</table>
    </div>
  </div>
  <div class="card" style="margin-top:16px;">
    <h2>Task Results</h2>
    <table class="mono">${taskRows}</table>
  </div>
  <div class="card" style="margin-top:16px;">
    <h2>App Task Results</h2>
    <table class="mono">${appTaskRows}</table>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildKeyValueRows(lines) {
  if (!lines || lines.length === 0) {
    return `<tr><td colspan="2">No data</td></tr>`;
  }
  return lines
    .map((line) => {
      const [rawKey, ...rest] = String(line).split(":");
      const key = escapeHtml(rawKey.trim());
      const value = escapeHtml(rest.join(":").trim());
      return `<tr><th>${key}</th><td>${value}</td></tr>`;
    })
    .join("");
}

function buildTaskCountCounters(names) {
  const metrics = {};
  for (const name of names) {
    metrics[name] = new Counter(`task_${name}_count`);
  }
  return metrics;
}

function buildTaskPassFailCounters(names, suffix) {
  const metrics = {};
  for (const name of names) {
    metrics[name] = new Counter(`task_${name}_${suffix}`);
  }
  return metrics;
}

function buildTaskTrends(names) {
  const metrics = {};
  for (const name of names) {
    metrics[name] = new Trend(`task_${name}_duration_ms`, true);
  }
  return metrics;
}

function pickFileField(fields) {
  const fileField = fields.find((field) => {
    const type = normalize(field.type);
    return type === "file" || type === "files";
  });
  return fileField?.api_name ?? null;
}

function buildAppTaskCounters(apps, tasks, suffix) {
  const metrics = {};
  for (const app of apps) {
    for (const task of tasks) {
      const key = `${app}_${task}`;
      metrics[key] = new Counter(`task_${app.toLowerCase()}_${task}_${suffix}`);
    }
  }
  return metrics;
}

function buildTaskSummaryLines(data) {
  const lines = [];
  for (const name of TASK_NAMES) {
    const passMetric = data.metrics?.[`task_${name}_passed`]?.values?.count ?? 0;
    const failMetric = data.metrics?.[`task_${name}_failed`]?.values?.count ?? 0;
    if (passMetric > 0 || failMetric > 0) {
      lines.push(`${name}_passed: ${passMetric}`, `${name}_failed: ${failMetric}`);
    }
  }
  return lines;
}

function buildSlowSummaryLines(data) {
  const lines = [];
  for (const name of TASK_NAMES) {
    const slowMetric = data.metrics?.[`task_${name}_over_5s`]?.values?.count ?? 0;
    if (slowMetric > 0) {
      lines.push(`${name}_over_5s: ${slowMetric}`);
    }
  }
  if (lines.length === 0) {
    lines.push("no_requests_over_5s: 0");
  }
  return lines;
}

function buildSlowEndpointLines() {
  const entries = Object.entries(slowEndpointCounts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return ["no_slow_endpoints: 0"];
  return entries.map(([endpoint, count]) => `${endpoint}: ${count}`);
}

function buildAppTaskSummaryLines(data) {
  const lines = [];
  for (const app of APP_NAMES) {
    for (const task of APP_TASK_NAMES) {
      const key = `task_${app.toLowerCase()}_${task}`;
      const passMetric = data.metrics?.[`${key}_passed`]?.values?.count ?? 0;
      const failMetric = data.metrics?.[`${key}_failed`]?.values?.count ?? 0;
      if (passMetric > 0 || failMetric > 0) {
        lines.push(`${app}_${task}_passed: ${passMetric}`, `${app}_${task}_failed: ${failMetric}`);
      }
    }
  }
  return lines;
}

function buildIdPrefix() {
  const twoChars = Math.floor(Math.random() * 1296)
    .toString(36)
    .toUpperCase()
    .padStart(2, "0")
    .slice(-2);
  return `O${twoChars}`;
}

function buildLatencyBuckets() {
  return {
    "latency_1_100_ms": new Counter("latency_1_100_ms"),
    "latency_100_1000_ms": new Counter("latency_100_1000_ms"),
    "latency_1000_3000_ms": new Counter("latency_1000_3000_ms"),
    "latency_3000_5000_ms": new Counter("latency_3000_5000_ms"),
    "latency_5000_10000_ms": new Counter("latency_5000_10000_ms"),
    "latency_over_10000_ms": new Counter("latency_over_10000_ms")
  };
}

function recordLatencyBucket(res) {
  if (!res || typeof res.timings?.duration !== "number") return;
  const ms = res.timings.duration;
  if (ms < 100) latencyBucketMetrics.latency_1_100_ms.add(1);
  else if (ms < 1000) latencyBucketMetrics.latency_100_1000_ms.add(1);
  else if (ms < 3000) latencyBucketMetrics.latency_1000_3000_ms.add(1);
  else if (ms < 5000) latencyBucketMetrics.latency_3000_5000_ms.add(1);
  else if (ms < 10000) latencyBucketMetrics.latency_5000_10000_ms.add(1);
  else latencyBucketMetrics.latency_over_10000_ms.add(1);
}

function buildLatencyBucketLines(data) {
  const buckets = [
    ["1-100ms", "latency_1_100_ms"],
    ["100-1000ms", "latency_100_1000_ms"],
    ["1000-3000ms", "latency_1000_3000_ms"],
    ["3000-5000ms", "latency_3000_5000_ms"],
    ["5000-10000ms", "latency_5000_10000_ms"],
    [">10000ms", "latency_over_10000_ms"]
  ];
  return buckets.map(([label, key]) => {
    const count = data.metrics?.[key]?.values?.count ?? 0;
    return `requests_${label}: ${count}`;
  });
}

function recordSlowEndpoint(res) {
  if (!res?.url) return;
  const normalized = normalizeUrl(res.url);
  slowEndpointCounts[normalized] = (slowEndpointCounts[normalized] || 0) + 1;
}

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean).map(normalizePathSegment);
    return `${url.protocol}//${url.host}/${parts.join("/")}`;
  } catch {
    return String(rawUrl);
  }
}

function normalizePathSegment(segment) {
  const value = String(segment || "");
  if (value.length > 12 && /^[A-Za-z0-9_-]+$/.test(value)) return ":id";
  if (/^[A-Z]{3}[A-Za-z0-9]+$/.test(value)) return ":id";
  if (/^[A-Fa-f0-9-]{12,}$/.test(value)) return ":id";
  return value;
}
