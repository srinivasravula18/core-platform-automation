/// <reference types="k6" />
// VUs and actions in ops3 test (100 concurrent users):
// - Admin app VUs (admin user): login, list apps/objects, create+delete object/field/tab, list view share change.
// - Shockwave admin VUs (admin user): login, app/tabs, list views/query, search, file ops if supported.
// - Shockwave CRM VUs: login, CRM app/tabs, list views/query, list records, then:
//   - Seed users 1-70 and 100-300 are read-only
//   - User71-85 create
//   - User86-94 create, update, and delete their own record
// - Shockwave HR VUs (User46-50, User95-99): login, HR app/tabs, list views/query, list records, create+update.
// - File ops (upload/download/delete) run only if object has file/files field.
import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 403, 404));

const http429Rate = new Rate("http_429_rate");
const http429Count = new Counter("http_429_count");
const bucket1to100 = new Counter("resp_1_100ms");
const bucket100to1000 = new Counter("resp_100_1000ms");
const bucket1000to3000 = new Counter("resp_1000_3000ms");
const bucket3000to5000 = new Counter("resp_3000_5000ms");
const bucket5000to10000 = new Counter("resp_5000_10000ms");
const bucket10000plus = new Counter("resp_10000plus_ms");

const TASK_NAMES = [
  "login",
  "refresh",
  "list_apps",
  "list_tabs",
  "list_objects",
  "describe_object",
  "list_views",
  "query_list_view",
  "create_list_view",
  "update_list_view",
  "list_records",
  "create_record",
  "update_record",
  "delete_record",
  "list_files",
  "upload_file",
  "download_file",
  "delete_file",
  "search",
  "admin_create_object",
  "admin_create_field",
  "admin_create_tab"
];
const APP_NAMES = ["CRM", "HR"];
const APP_TASK_NAMES = [
  "list_views",
  "query_list_view",
  "list_records",
  "create_record",
  "update_record",
  "delete_record",
  "search",
  "list_files",
  "upload_file",
  "download_file",
  "delete_file"
];
const taskCountMetrics = buildTaskCountCounters(TASK_NAMES);
const taskDurationMetrics = buildTaskTrends(TASK_NAMES);
const taskPassMetrics = buildTaskPassFailCounters(TASK_NAMES, "passed");
const taskFailMetrics = buildTaskPassFailCounters(TASK_NAMES, "failed");
const taskSlowMetrics = buildTaskPassFailCounters(TASK_NAMES, "over_5s");
const appTaskPassMetrics = buildAppTaskCounters(APP_NAMES, APP_TASK_NAMES, "passed");
const appTaskFailMetrics = buildAppTaskCounters(APP_NAMES, APP_TASK_NAMES, "failed");
const slowEndpointCounts = {};
const SYSTEM_CREATE_EXCLUDED_FIELDS = new Set([
  "id",
  "app_id",
  "row_version",
  "created_by",
  "created_at",
  "modified_by",
  "modified_at"
]);

const buildLoadText = (prefix) => `${prefix} ${__VU}-${__ITER}-${Date.now()}`;

const failureLogCounts = {};
const FAILURE_LOG_LIMIT = Number(__ENV.FAILURE_LOG_LIMIT || 5);

const businessSuccessCount = new Counter("business_success_count");
const businessFailureCount = new Counter("business_failure_count");
const businessSuccessRate = new Rate("business_success_rate");
const adminFlowSuccessCount = new Counter("flow_admin_success_count");
const adminFlowFailureCount = new Counter("flow_admin_failure_count");
const shockwaveAdminFlowSuccessCount = new Counter("flow_shockwave_admin_success_count");
const shockwaveAdminFlowFailureCount = new Counter("flow_shockwave_admin_failure_count");
const shockwaveCrmFlowSuccessCount = new Counter("flow_shockwave_crm_success_count");
const shockwaveCrmFlowFailureCount = new Counter("flow_shockwave_crm_failure_count");
const shockwaveHrFlowSuccessCount = new Counter("flow_shockwave_hr_success_count");
const shockwaveHrFlowFailureCount = new Counter("flow_shockwave_hr_failure_count");

const DEFAULT_API_BASE = "http://localhost:5001";
const API_BASE = (__ENV.API_BASE || __ENV.VITE_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
const DEFAULT_AUTH_API_BASE = API_BASE;
const AUTH_API_BASE = (__ENV.AUTH_API_BASE || __ENV.AUTH_BASE || DEFAULT_AUTH_API_BASE).replace(/\/+$/, "");

const ADMIN_USERNAME = (__ENV.ADMIN_USERNAME || "admin").trim();
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || "admin";
const DEFAULT_POOL_USERNAME = (__ENV.DEFAULT_POOL_USERNAME || "ethan.parker").trim();
const DEFAULT_POOL_PASSWORD = __ENV.DEFAULT_POOL_PASSWORD || `${DEFAULT_POOL_USERNAME}@123`;

const CRM_APP_LABEL = (__ENV.CRM_APP_LABEL || "CRM").trim();
const CRM_TABS = parseCsv(__ENV.CRM_TABS || "account,contact,opportunity,case");
const CRM_OBJECT_API = (__ENV.CRM_OBJECT_API || "").trim();
const HR_OBJECT_API = (__ENV.HR_OBJECT_API || "").trim();
const USER_POOL = parseUserPool(__ENV.USER_POOL || "");
const SEEDED_USER_POOL_LIMIT = resolveSeededUserPoolLimit(__ENV.SEEDED_USER_POOL_LIMIT, USER_POOL);
const REQUIRE_UNIQUE_USERS = String(__ENV.REQUIRE_UNIQUE_USERS || "1") !== "0";
const USE_POOL_FOR_SHOCKWAVE = String(__ENV.USE_POOL_FOR_SHOCKWAVE || "1") !== "0";
const SKIP_LIST_TABS = String(__ENV.SKIP_LIST_TABS || "0") === "1";
const QUERY_LIST_VIEW_EVERY = Math.max(1, Number(__ENV.QUERY_LIST_VIEW_EVERY || 1));
const SKIP_QUERY_LIST_VIEW = String(__ENV.SKIP_QUERY_LIST_VIEW || "0") === "1";
const SKIP_FILE_OPS = String(__ENV.SKIP_FILE_OPS || "0") === "1";

const DURATION = __ENV.DURATION || "1m";
const SETUP_WAIT_SECONDS = Number(__ENV.SETUP_WAIT_SECONDS || 30);
const MIN_ITERATION_MS = Number(__ENV.MIN_ITERATION_MS || 800);
const SESSION_REFRESH_MS = Number(__ENV.SESSION_REFRESH_MS || 3 * 60 * 1000);
const INITIAL_LOGIN_SPREAD_MS = Math.max(0, Number(__ENV.INITIAL_LOGIN_SPREAD_MS || 0));
const LOGIN_MAX_ATTEMPTS = Math.max(1, Number(__ENV.LOGIN_MAX_ATTEMPTS || 1));
const LOGIN_RETRY_BASE_MS = Math.max(100, Number(__ENV.LOGIN_RETRY_BASE_MS || 1000));

// Default split: 100 VUs total, aligned to the current CRM/HR seed.
const ADMIN_APP_VUS = Number(__ENV.ADMIN_APP_VUS || 2);
const SHOCKWAVE_ADMIN_VUS = Number(__ENV.SHOCKWAVE_ADMIN_VUS || 5);
const CRM_VUS = Number(__ENV.CRM_VUS || 83);
const HR_VUS = Number(__ENV.HR_VUS || 10);
const TOTAL_VUS = ADMIN_APP_VUS + SHOCKWAVE_ADMIN_VUS + CRM_VUS + HR_VUS;

export const options = {
  scenarios: buildScenarios(DURATION),
  setupTimeout: "3m",
  thresholds: {
    http_req_failed: ["rate<0.10"],
    http_req_duration: ["p(95)<40000"]
  }
};

const readResponseHeader = (res, name) => {
  if (!res?.headers || !name) return null;
  const target = String(name).toLowerCase();
  for (const [headerName, value] of Object.entries(res.headers)) {
    if (String(headerName).toLowerCase() === target) {
      return Array.isArray(value) ? value[0] ?? null : value ?? null;
    }
  }
  return null;
};

const parseHeaderNumber = (res, name) => {
  const raw = readResponseHeader(res, name);
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const loadTestAuthLimitMessage = (limit) => {
  const limitText = Number.isFinite(limit) ? String(limit) : "unknown";
  return [
    `Ops3 needs at least ${TOTAL_VUS + 1} login requests per auth window because ${TOTAL_VUS} VUs authenticate from one IP at startup.`,
    `Current /auth/login rate limit is ${limitText}.`,
    "Start the service in load-test mode or raise AUTH_RATE_LIMIT_LOGIN_MAX_IP before running k6.",
    "Example: AUTH_RATE_LIMIT_LOGIN_MAX_IP=5000 AUTH_RATE_LIMIT_WINDOW_MS=900000 npm --workspace @core-platform/service run dev"
  ].join(" ");
};

export const setup = () => {
  sleep(Math.max(0, SETUP_WAIT_SECONDS));
  validateShockwaveUserPool();
  const loginRes = http.post(
    `${AUTH_API_BASE}/auth/login`,
    JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    { headers: { "Content-Type": "application/json" } }
  );
  recordRateLimit(loginRes);
  recordTask("login", loginRes, loginRes.status === 200);
  const loginLimit = parseHeaderNumber(loginRes, "x-ratelimit-limit");
  if (loginRes.status === 429) {
    throw new Error(loadTestAuthLimitMessage(loginLimit));
  }
  if (loginRes.status !== 200) return { startedAt: Date.now() };
  if (Number.isFinite(loginLimit) && loginLimit < TOTAL_VUS + 1) {
    throw new Error(loadTestAuthLimitMessage(loginLimit));
  }
  const loginBody = loginRes.json();
  const token = loginBody?.access_token ?? loginBody?.token ?? null;
  if (!token) return { startedAt: Date.now() };
  const useSetupDescribe = String(__ENV.SETUP_DESCRIBE || "0") === "1";
  if (!useSetupDescribe) return { startedAt: Date.now() };
  const appsRes = http.get(`${API_BASE}/api/apps`, authHeaders(token));
  if (appsRes.status !== 200) return { startedAt: Date.now() };
  const apps = appsRes.json()?.items || [];
  const describeByKey = {};
  const targets = [
    { label: CRM_APP_LABEL, objectApi: CRM_OBJECT_API },
    { label: "HR", objectApi: HR_OBJECT_API }
  ].filter((entry) => entry.objectApi);
  for (const target of targets) {
    const app = apps.find(
      (item) => normalize(item.label) === normalize(target.label) || normalize(item.api_name) === normalize(target.label)
    );
    if (!app?.id) continue;
    const res = http.get(
      `${API_BASE}/api/apps/${app.id}/objects/${target.objectApi}/describe`,
      authHeaders(token)
    );
    if (res.status === 200) {
      const key = buildDescribeKey(target.label, target.objectApi);
      describeByKey[key] = res.json();
    }
  }
  return { startedAt: Date.now(), describeByKey };
};

const sessions = {
  admin: { token: null, refreshToken: null, lastAuthAt: 0, lastRefreshAt: 0, initialDelayDone: false },
  pool: { token: null, refreshToken: null, lastAuthAt: 0, lastRefreshAt: 0, initialDelayDone: false }
};
const GROUP_POOLS = buildGroupPools();

const recordCache = new Map();
const objectsCacheByApp = new Map();
const describeCacheByObject = new Map();

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
    else {
      taskFailMetrics[name]?.add(1);
      logFailure(name, res);
    }
  }
  recordDurationBucket(res);
  if (res && typeof res.timings?.duration === "number" && taskDurationMetrics[name]) {
    taskDurationMetrics[name].add(res.timings.duration);
  }
  if (res && typeof res.timings?.duration === "number" && res.timings.duration > 5000) {
    taskSlowMetrics[name]?.add(1);
    recordSlowEndpoint(res);
  }
};

const cacheKey = (appId, objectApi) => `${appId}:${objectApi}`;
const getCachedRecordId = (appId, objectApi) => recordCache.get(cacheKey(appId, objectApi)) || null;
const setCachedRecordId = (appId, objectApi, recordId) => {
  if (!recordId) return;
  recordCache.set(cacheKey(appId, objectApi), recordId);
};
const clearCachedRecordId = (appId, objectApi, recordId) => {
  const key = cacheKey(appId, objectApi);
  if (recordCache.get(key) === recordId) recordCache.delete(key);
};

const logFailure = (name, res) => {
  if (!res) return;
  const count = failureLogCounts[name] || 0;
  if (count >= FAILURE_LOG_LIMIT) return;
  failureLogCounts[name] = count + 1;
  const status = res.status;
  const url = res.url;
  const body = typeof res.body === "string" ? res.body.slice(0, 500) : "";
  console.error(`[ops3][${name}] status=${status} url=${url} body=${body}`);
};

const logLoginFailure = (username, res) => {
  if (!res || !username) return;
  const key = `login:${username}`;
  const count = failureLogCounts[key] || 0;
  if (count >= FAILURE_LOG_LIMIT) return;
  failureLogCounts[key] = count + 1;
  const body = typeof res.body === "string" ? res.body.slice(0, 500) : "";
  console.error(`[ops3][login][user=${username}] status=${res.status} url=${res.url} body=${body}`);
};

const recordAppTask = (appLabel, name, ok) => {
  if (!appLabel || !name || typeof ok !== "boolean") return;
  const appKey = appLabel.toUpperCase();
  const key = `${appKey}_${name}`;
  appTaskPassMetrics[key]?.add(ok ? 1 : 0);
  appTaskFailMetrics[key]?.add(ok ? 0 : 1);
};

const recordBusinessResult = (success) => {
  if (success) businessSuccessCount.add(1);
  else businessFailureCount.add(1);
  businessSuccessRate.add(Boolean(success));
};

const recordFlowResult = (flow, success) => {
  const ok = Boolean(success);
  if (flow === "admin") return ok ? adminFlowSuccessCount.add(1) : adminFlowFailureCount.add(1);
  if (flow === "shockwave_admin")
    return ok ? shockwaveAdminFlowSuccessCount.add(1) : shockwaveAdminFlowFailureCount.add(1);
  if (flow === "shockwave_crm")
    return ok ? shockwaveCrmFlowSuccessCount.add(1) : shockwaveCrmFlowFailureCount.add(1);
  if (flow === "shockwave_hr")
    return ok ? shockwaveHrFlowSuccessCount.add(1) : shockwaveHrFlowFailureCount.add(1);
};
const login = (username, password, authBase = AUTH_API_BASE) => {
  let lastRes = null;
  for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
    const res = http.post(
      `${authBase}/auth/login`,
      JSON.stringify({ username, password }),
      { headers: { "Content-Type": "application/json" } }
    );
    lastRes = res;
    recordRateLimit(res);
    const ok = res.status === 200;
    recordTask("login", res, ok);
    if (ok) {
      const body = res.json();
      return {
        ok: typeof (body?.access_token ?? body?.token) === "string",
        token: body?.access_token ?? body?.token ?? null,
        refreshToken: body?.refresh_token ?? null
      };
    }
    if (res.status !== 429 || attempt >= LOGIN_MAX_ATTEMPTS) {
      logLoginFailure(username, res);
      return { ok: false, token: null, refreshToken: null };
    }
    sleep(resolveRetryDelayMs(res, attempt) / 1000);
  }
  logLoginFailure(username, lastRes);
  return { ok: false, token: null, refreshToken: null };
};

const refreshSession = (refreshToken, authBase = AUTH_API_BASE) => {
  if (!refreshToken) return { ok: false, token: null, refreshToken: null };
  const res = http.post(
    `${authBase}/auth/refresh`,
    JSON.stringify({ refresh_token: refreshToken }),
    { headers: { "Content-Type": "application/json" } }
  );
  recordRateLimit(res);
  const ok = res.status === 200;
  recordTask("refresh", res, ok);
  if (!ok) return { ok: false, token: null, refreshToken: null };
  const body = res.json();
  return {
    ok: typeof (body?.access_token ?? body?.token) === "string",
    token: body?.access_token ?? body?.token ?? null,
    refreshToken: body?.refresh_token ?? refreshToken
  };
};

const getSession = (key, username, password) => {
  const entry = sessions[key];
  const authBase = AUTH_API_BASE;
  const now = Date.now();
  if (!entry.token || now - entry.lastAuthAt > 30 * 60 * 1000) {
    ensureInitialLoginDelay(entry);
    const result = login(username, password, authBase);
    if (!result.ok || !result.token) return { ok: false, session: null };
    entry.token = result.token;
    entry.refreshToken = result.refreshToken;
    entry.lastAuthAt = now;
    entry.lastRefreshAt = now;
  }
  if (entry.refreshToken && now - entry.lastRefreshAt > SESSION_REFRESH_MS) {
    const refreshed = refreshSession(entry.refreshToken, authBase);
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

const resolveAppId = (token, labelOrApi) => {
  const appsResult = listApps(token);
  if (!appsResult.ok || appsResult.items.length === 0) return null;
  if (!labelOrApi) return appsResult.items[0]?.id ?? null;
  const target = normalize(labelOrApi);
  const match = appsResult.items.find(
    (app) => normalize(app.label) === target || normalize(app.api_name) === target
  );
  return match?.id ?? appsResult.items[0]?.id ?? null;
};

const listTabs = (token, appId) => {
  const res = http.get(`${API_BASE}/api/apps/${appId}/tabs`, authHeaders(token));
  recordRateLimit(res);
  recordTask("list_tabs", res, res.status === 200);
  if (res.status !== 200) return [];
  const body = res.json();
  return Array.isArray(body?.items) ? body.items : [];
};

const listObjects = (token, appId) => {
  const res = http.get(`${API_BASE}/api/apps/${appId}/objects`, authHeaders(token));
  recordRateLimit(res);
  recordTask("list_objects", res, res.status === 200);
  if (res.status !== 200) return { ok: false, items: [] };
  const body = res.json();
  return { ok: true, items: Array.isArray(body?.items) ? body.items : [] };
};

const listObjectsCached = (token, appId) => {
  if (objectsCacheByApp.has(appId)) {
    return { ok: true, items: objectsCacheByApp.get(appId) };
  }
  const result = listObjects(token, appId);
  if (result.ok) objectsCacheByApp.set(appId, result.items);
  return result;
};

const describeObjectCached = (token, appId, objectApi) => {
  const key = `${appId}:${objectApi}`;
  const cached = describeCacheByObject.get(key);
  if (cached && cached.ok) return cached.value;
  if (cached && !cached.ok && Date.now() - cached.at < 60 * 1000) return null;
  const value = describeObject(token, appId, objectApi);
  if (value) {
    describeCacheByObject.set(key, { ok: true, value, at: Date.now() });
    return value;
  }
  describeCacheByObject.set(key, { ok: false, value: null, at: Date.now() });
  return null;
};

const describeObject = (token, appId, objectApi) => {
  const res = http.get(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/describe`,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("describe_object", res, res.status === 200);
  if (res.status !== 200) return null;
  try {
    return res.json();
  } catch {
    return null;
  }
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

const createRecord = (token, appId, objectApi, payload) => {
  const res = http.post(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records`,
    JSON.stringify(payload || { name: buildLoadText("Load") }),
    jsonHeaders(token)
  );
  recordRateLimit(res);
  recordTask("create_record", res, res.status === 201);
  if (res.status !== 201) return { ok: false, recordId: null, rowVersion: null };
  const body = res.json();
  const recordId = body?.id || body?.record_id || body?.recordId || null;
  const rowVersion = Number(body?.row_version);
  return {
    ok: Boolean(recordId),
    recordId,
    rowVersion: Number.isFinite(rowVersion) ? rowVersion : null
  };
};

const updateRecord = (token, appId, objectApi, recordId, rowVersion) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  if (Number.isFinite(rowVersion)) {
    headers["If-Match"] = String(rowVersion);
  }
  const res = http.patch(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records/${recordId}`,
    JSON.stringify({ name: buildLoadText("Updated") }),
    { headers }
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
  let objectRes = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    objectRes = http.post(
      `${API_BASE}/admin/apps/${appId}/objects`,
      JSON.stringify({
        api_name: `${apiName}_${attempt}`,
        label: `Load Obj ${stamp} ${attempt + 1}`,
        id_prefix: buildIdPrefix(),
        global_search_enabled: false,
        inline_edit_enabled: true,
        list_view_relationship_depth: 2
      }),
      jsonHeaders(token)
    );
    recordRateLimit(objectRes);
    if (objectRes.status === 201) {
      recordTask("admin_create_object", objectRes, true);
      break;
    }
    if (objectRes.status !== 409) {
      recordTask("admin_create_object", objectRes, false);
      return { ok: false, objectId: null };
    }
  }
  if (!objectRes || objectRes.status !== 201) {
    recordTask("admin_create_object", objectRes, false);
    return { ok: false, objectId: null };
  }
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
  return { ok: true, objectId: object.id };
};

function adminOpsFlow() {
  const startedAt = Date.now();
  let flowSuccess = true;
  const sessionResult = getSession("admin", ADMIN_USERNAME, ADMIN_PASSWORD);
  if (!sessionResult.ok || !sessionResult.session?.token) flowSuccess = false;
  if (!flowSuccess) {
    recordBusinessResult(false);
    recordFlowResult("admin", false);
    return pace(startedAt);
  }
  const token = sessionResult.session.token;
  const apps = listApps(token);
  if (!apps.ok || apps.items.length === 0) flowSuccess = false;
  const appId = apps.items[0]?.id ?? null;
  if (!appId) flowSuccess = false;
  if (!flowSuccess) {
    recordBusinessResult(false);
    recordFlowResult("admin", false);
    return pace(startedAt);
  }
  const objects = listObjectsCached(token, appId);
  if (objects.ok && objects.items.length > 0) {
    const objectApi = objects.items[0].api_name || objects.items[0].apiName;
    const listViewsResult = listViews(token, appId, objectApi);
    if (listViewsResult.ok) {
      const created = createListView(token, appId, objectApi);
      if (created.ok && created.id) {
        updateListView(token, appId, objectApi, created.id);
      }
    }
  } else {
    flowSuccess = false;
  }
  const created = adminCreateObjectAndField(token, appId);
  if (!created.ok || !created.objectId) {
    flowSuccess = false;
  }
  recordBusinessResult(flowSuccess);
  recordFlowResult("admin", flowSuccess);
  pace(startedAt);
}

function shockwaveOpsFlow(
  sessionKey,
  username,
  password,
  appLabel,
  allowedTabs,
  profile,
  flowKey,
  setupData
) {
  const startedAt = Date.now();
  let flowSuccess = true;
  const sessionResult = getSession(sessionKey, username, password);
  if (!sessionResult.ok || !sessionResult.session?.token) flowSuccess = false;
  if (!flowSuccess) {
    recordBusinessResult(false);
    recordFlowResult(flowKey, false);
    return pace(startedAt);
  }
  const token = sessionResult.session.token;
  const appId = resolveAppId(token, appLabel);
  if (!appId) flowSuccess = false;
  if (!flowSuccess) {
    recordBusinessResult(false);
    recordFlowResult(flowKey, false);
    return pace(startedAt);
  }
  const allowedSet = new Set((allowedTabs || []).map((label) => normalize(label)));
  let objectApi = null;
  if (SKIP_LIST_TABS) {
    objectApi = resolveObjectApiOverride(appLabel);
    if (!objectApi) {
      const objectsResult = listObjectsCached(token, appId);
      if (!objectsResult.ok) flowSuccess = false;
      const objects = objectsResult.items;
      const target =
        objects.find(
          (object) =>
            allowedSet.has(normalize(object.label)) || allowedSet.has(normalize(object.api_name))
        ) ?? objects[0];
      objectApi = target?.api_name || null;
    }
  } else {
    const tabs = listTabs(token, appId);
    const target = tabs.find((tab) => allowedSet.has(normalize(tab.label))) ?? tabs[0];
    objectApi = target?.object_api_name || target?.api_name;
  }
  if (!objectApi) flowSuccess = false;
  if (!flowSuccess) {
    recordBusinessResult(false);
    recordFlowResult(flowKey, false);
    return pace(startedAt);
  }
  const listViewsResult = listViews(token, appId, objectApi);
  recordAppTask(appLabel, "list_views", listViewsResult.ok);
  if (!listViewsResult.ok) flowSuccess = false;
  if (!SKIP_QUERY_LIST_VIEW && shouldQueryListView()) {
    const query = queryListView(token, appId, objectApi);
    recordAppTask(appLabel, "query_list_view", query.ok);
    if (!query.ok) flowSuccess = false;
  }
  const search = searchApp(token, appId, "load");
  recordAppTask(appLabel, "search", search.ok);
  if (!search.ok) flowSuccess = false;
  const records = listRecords(token, appId, objectApi);
  recordAppTask(appLabel, "list_records", records.ok);
  if (!records.ok) flowSuccess = false;
  const listedRecordId = records.items[0]?.id || records.items[0]?.record_id || records.items[0]?.recordId;
  const cachedRecordId = getCachedRecordId(appId, objectApi);
  const recordId = cachedRecordId || listedRecordId || null;
  if (!cachedRecordId && listedRecordId) {
    setCachedRecordId(appId, objectApi, listedRecordId);
  }
  const needsDescribe =
    profile === "create" ||
    profile === "update" ||
    profile === "update_delete" ||
    profile === "create_update";
  const describeFromSetup = resolveDescribeFromSetup(setupData, appLabel, objectApi);
  const describe =
    describeFromSetup ||
    (needsDescribe || (!SKIP_FILE_OPS && recordId) ? describeObjectCached(token, appId, objectApi) : null);
  if ((needsDescribe || (!SKIP_FILE_OPS && recordId)) && !describe) {
    flowSuccess = false;
  }
  const payloadInfo = buildRecordPayload({
    objectApi,
    describe
  });
  let currentRecordId = null;
  if (profile === "create") {
    const created = payloadInfo.__ok
      ? createRecord(token, appId, objectApi, payloadInfo.payload)
      : { ok: false, recordId: null };
    recordAppTask(appLabel, "create_record", created.ok);
    if (!created.ok) flowSuccess = false;
    if (created.recordId) {
      setCachedRecordId(appId, objectApi, created.recordId);
      currentRecordId = created.recordId;
    }
  } else if (profile === "update") {
    const created = payloadInfo.__ok
      ? createRecord(token, appId, objectApi, payloadInfo.payload)
      : { ok: false, recordId: null };
    recordAppTask(appLabel, "create_record", created.ok);
    if (!created.ok) flowSuccess = false;
    let targetId = created.recordId;
    if (targetId) setCachedRecordId(appId, objectApi, targetId);
    if (targetId) {
      const updated = updateRecord(token, appId, objectApi, targetId, created.rowVersion);
      recordAppTask(appLabel, "update_record", updated.ok);
      if (!updated.ok) flowSuccess = false;
      if (updated.ok) currentRecordId = targetId;
    } else {
      flowSuccess = false;
    }
  } else if (profile === "update_delete") {
    const created = payloadInfo.__ok
      ? createRecord(token, appId, objectApi, payloadInfo.payload)
      : { ok: false, recordId: null };
    recordAppTask(appLabel, "create_record", created.ok);
    if (!created.ok) flowSuccess = false;
    let targetId = created.recordId;
    if (targetId) setCachedRecordId(appId, objectApi, targetId);
    if (targetId) {
      const updated = updateRecord(token, appId, objectApi, targetId, created.rowVersion);
      recordAppTask(appLabel, "update_record", updated.ok);
      if (!updated.ok) flowSuccess = false;
      if (updated.ok) {
        const deleted = deleteRecord(token, appId, objectApi, targetId);
        recordAppTask(appLabel, "delete_record", deleted.ok);
        if (!deleted.ok) flowSuccess = false;
        if (deleted.ok) clearCachedRecordId(appId, objectApi, targetId);
        if (deleted.ok) currentRecordId = targetId;
      }
    } else {
      flowSuccess = false;
    }
  } else if (profile === "create_update") {
    const created = payloadInfo.__ok
      ? createRecord(token, appId, objectApi, payloadInfo.payload)
      : { ok: false, recordId: null };
    recordAppTask(appLabel, "create_record", created.ok);
    if (!created.ok) flowSuccess = false;
    if (created.recordId) {
      setCachedRecordId(appId, objectApi, created.recordId);
      const updated = updateRecord(token, appId, objectApi, created.recordId, created.rowVersion);
      recordAppTask(appLabel, "update_record", updated.ok);
      if (!updated.ok) flowSuccess = false;
      if (updated.ok) currentRecordId = created.recordId;
    }
  }
  if (!SKIP_FILE_OPS) {
    const fileTargetId = currentRecordId || getCachedRecordId(appId, objectApi);
    if (fileTargetId && describe) {
      const fileField = pickFileField(describe?.fields || []);
      if (fileField) {
        const upload = uploadRecordFile(token, appId, objectApi, fileTargetId, fileField);
        recordAppTask(appLabel, "upload_file", upload.ok);
        if (upload.ok && upload.fileId) {
          const downloaded = downloadFile(token, upload.fileId);
          recordAppTask(appLabel, "download_file", downloaded.ok);
          const deleted = deleteFile(token, upload.fileId);
          recordAppTask(appLabel, "delete_file", deleted.ok);
        }
      }
    }
  }
  recordBusinessResult(flowSuccess);
  recordFlowResult(flowKey, flowSuccess);
  pace(startedAt);
}

export const adminFlow = () => adminOpsFlow();
export const shockwaveAdminFlow = (data) =>
  shockwaveOpsFlow("admin", ADMIN_USERNAME, ADMIN_PASSWORD, "", [], "read", "shockwave_admin", data);
export const shockwaveCrmFlow = (data) => {
  const creds = resolveGroupCredentials("CRM");
  const scope = resolveUserScope(creds);
  const profile = resolveCrmProfile(creds);
  shockwaveOpsFlow(
    "pool",
    creds.username,
    creds.password,
    scope.appLabel,
    scope.tabs,
    profile,
    "shockwave_crm",
    data
  );
};
export const shockwaveHrFlow = (data) => {
  const creds = resolveGroupCredentials("HR");
  const scope = resolveUserScope(creds);
  const profile = resolveHrProfile(creds);
  shockwaveOpsFlow(
    "pool",
    creds.username,
    creds.password,
    scope.appLabel,
    scope.tabs,
    profile,
    "shockwave_hr",
    data
  );
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
    .map((entry, index) => {
      const [username, password] = entry.split(":");
      return {
        username: String(username || "").trim(),
        password: String(password || "").trim(),
        seedIndex: index + 1
      };
    })
    .filter((entry) => entry.username.length > 0 && entry.password.length > 0);
}

function resolveGroupCredentials(group) {
  const vuIndex = resolveScenarioVuIndex();
  if (group === "CRM" && GROUP_POOLS.crm.length > 0) {
    return GROUP_POOLS.crm[vuIndex] || GROUP_POOLS.crm[vuIndex % GROUP_POOLS.crm.length];
  }
  if (group === "HR" && GROUP_POOLS.hr.length > 0) {
    return GROUP_POOLS.hr[vuIndex] || GROUP_POOLS.hr[vuIndex % GROUP_POOLS.hr.length];
  }
  return { username: DEFAULT_POOL_USERNAME, password: DEFAULT_POOL_PASSWORD };
}

function resolveScenarioVuIndex() {
  const scenarioName = String(exec?.scenario?.name || "");
  if (scenarioName === "adminFlow") return Math.max(0, __VU - 1);
  if (scenarioName === "shockwaveAdminFlow") return Math.max(0, __VU - ADMIN_APP_VUS - 1);
  if (scenarioName === "shockwaveCrmFlow") {
    return Math.max(0, __VU - ADMIN_APP_VUS - SHOCKWAVE_ADMIN_VUS - 1);
  }
  if (scenarioName === "shockwaveHrFlow") {
    return Math.max(0, __VU - ADMIN_APP_VUS - SHOCKWAVE_ADMIN_VUS - CRM_VUS - 1);
  }
  return Math.max(0, __VU - 1);
}

function buildGroupPools() {
  const crm = [];
  const hr = [];
  for (const entry of USER_POOL) {
    if (SEEDED_USER_POOL_LIMIT > 0 && entry.seedIndex > SEEDED_USER_POOL_LIMIT) {
      continue;
    }
    const scope = resolveUserScope(entry);
    if (scope.appLabel === CRM_APP_LABEL) crm.push(entry);
    else if (scope.appLabel === "HR") hr.push(entry);
  }
  return { crm, hr };
}

function resolveSeededUserPoolLimit(rawValue, pool) {
  const parsed = Number(rawValue);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  if (Array.isArray(pool) && pool.length > 0) {
    return pool.length;
  }
  return 0;
}

function validateShockwaveUserPool() {
  if (!USE_POOL_FOR_SHOCKWAVE || USER_POOL.length === 0) {
    return;
  }

  const checks = [
    { group: "CRM", required: CRM_VUS, available: GROUP_POOLS.crm.length },
    { group: "HR", required: HR_VUS, available: GROUP_POOLS.hr.length }
  ];

  const emptyGroups = checks.filter((check) => check.required > 0 && check.available === 0);
  if (emptyGroups.length > 0) {
    throw new Error(
      `ops3 user pool has no credentials for required groups: ${emptyGroups
        .map((check) => check.group)
        .join(", ")}`
    );
  }

  if (!REQUIRE_UNIQUE_USERS) {
    return;
  }

  const exhaustedGroups = checks.filter((check) => check.required > check.available);
  if (exhaustedGroups.length > 0) {
    throw new Error(
      `ops3 requires unique users per VU, but the pool is too small: ${exhaustedGroups
        .map((check) => `${check.group} needs ${check.required}, has ${check.available}`)
        .join("; ")}`
    );
  }
}

function resolveSeedIndex(userOrIndex) {
  if (typeof userOrIndex === "number" && Number.isFinite(userOrIndex)) {
    return Math.floor(userOrIndex);
  }
  if (userOrIndex && typeof userOrIndex.seedIndex === "number" && Number.isFinite(userOrIndex.seedIndex)) {
    return Math.floor(userOrIndex.seedIndex);
  }
  const match = /^User(\d{2,3})$/i.exec(String(userOrIndex?.username || userOrIndex || ""));
  return match ? Number(match[1]) : NaN;
}

function resolveUserScope(userOrIndex) {
  const num = resolveSeedIndex(userOrIndex);
  if (!Number.isFinite(num)) return { appLabel: "", tabs: [] };
  if ((num >= 46 && num <= 50) || (num >= 95 && num <= 99)) {
    return { appLabel: "HR", tabs: ["department", "employee", "leave request"] };
  }
  if (num >= 1) return { appLabel: CRM_APP_LABEL, tabs: CRM_TABS };
  return { appLabel: "", tabs: [] };
}

function resolveObjectApiOverride(appLabel) {
  const key = normalize(appLabel);
  if (key === normalize(CRM_APP_LABEL) && CRM_OBJECT_API) return CRM_OBJECT_API;
  if (key === "hr" && HR_OBJECT_API) return HR_OBJECT_API;
  return "";
}

function buildDescribeKey(appLabel, objectApi) {
  return `${normalize(appLabel)}:${normalize(objectApi)}`;
}

function resolveDescribeFromSetup(setupData, appLabel, objectApi) {
  if (!setupData?.describeByKey) return null;
  const key = buildDescribeKey(appLabel || "", objectApi || "");
  return setupData.describeByKey[key] || null;
}

function resolveCrmProfile(userOrIndex) {
  const num = resolveSeedIndex(userOrIndex);
  if (!Number.isFinite(num)) return "read";
  if (num <= 70) return "read";
  if (num <= 85) return "create";
  if (num <= 94) return "update_delete";
  return "read";
}

function resolveHrProfile(userOrIndex) {
  const num = resolveSeedIndex(userOrIndex);
  if (!Number.isFinite(num)) return "read";
  return "create_update";
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function ensureInitialLoginDelay(entry) {
  if (entry.initialDelayDone || INITIAL_LOGIN_SPREAD_MS <= 0) return;
  entry.initialDelayDone = true;
  const totalVus = Math.max(1, ADMIN_APP_VUS + SHOCKWAVE_ADMIN_VUS + CRM_VUS + HR_VUS);
  const position = Math.max(0, __VU - 1);
  const delayMs = Math.floor((position / totalVus) * INITIAL_LOGIN_SPREAD_MS);
  if (delayMs > 0) {
    sleep(delayMs / 1000);
  }
}

function resolveRetryDelayMs(res, attempt) {
  const retryAfterHeader = res?.headers?.["Retry-After"] ?? res?.headers?.["retry-after"] ?? null;
  const retryAfterSeconds = Number(Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  return LOGIN_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
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
  data.report_metadata = {
    testName: "OPS3 real-time load test",
    targetBaseUrl: API_BASE,
    generatedAt: new Date().toISOString(),
    slowEndpoints: Object.entries(slowEndpointCounts)
      .sort((left, right) => right[1] - left[1])
      .map(([url, count]) => ({ url, count }))
  };
  const reqs = data.metrics?.http_reqs?.values?.count ?? 0;
  const reqRate = data.metrics?.http_reqs?.values?.rate ?? 0;
  const duration = data.metrics?.http_req_duration?.values ?? {};
  const p95 = duration["p(95)"] ?? 0;
  const rate = data.metrics?.http_429_rate?.values?.rate ?? 0;
  const count = data.metrics?.http_429_count?.values?.count ?? 0;
  const businessSuccess = data.metrics?.business_success_count?.values?.count ?? 0;
  const businessFailure = data.metrics?.business_failure_count?.values?.count ?? 0;
  const businessRate = data.metrics?.business_success_rate?.values?.rate ?? 0;
  const httpFailedRate = data.metrics?.http_req_failed?.values?.rate ?? 0;
  const adminSuccess = data.metrics?.flow_admin_success_count?.values?.count ?? 0;
  const adminFailure = data.metrics?.flow_admin_failure_count?.values?.count ?? 0;
  const shockwaveAdminSuccess =
    data.metrics?.flow_shockwave_admin_success_count?.values?.count ?? 0;
  const shockwaveAdminFailure =
    data.metrics?.flow_shockwave_admin_failure_count?.values?.count ?? 0;
  const shockwaveCrmSuccess =
    data.metrics?.flow_shockwave_crm_success_count?.values?.count ?? 0;
  const shockwaveCrmFailure =
    data.metrics?.flow_shockwave_crm_failure_count?.values?.count ?? 0;
  const shockwaveHrSuccess =
    data.metrics?.flow_shockwave_hr_success_count?.values?.count ?? 0;
  const shockwaveHrFailure =
    data.metrics?.flow_shockwave_hr_failure_count?.values?.count ?? 0;
  const taskSummaryLines = buildTaskSummaryLines(data);
  const appTaskSummaryLines = buildAppTaskSummaryLines(data);
  const bucketLines = buildBucketSummaryLines(data);
  const slowSummaryLines = buildSlowSummaryLines(data);
  const slowEndpointLines = buildSlowEndpointLines();
  const summaryLines = [
    `requests_per_second: ${reqRate.toFixed(2)}`,
    `http_req_duration_avg_ms: ${(duration.avg ?? 0).toFixed(2)}`,
    `http_req_duration_min_ms: ${(duration.min ?? 0).toFixed(2)}`,
    `http_req_duration_max_ms: ${(duration.max ?? 0).toFixed(2)}`,
    `http_req_duration_p95_ms: ${p95.toFixed(2)}`,
    `business_success_count: ${businessSuccess}`,
    `business_failure_count: ${businessFailure}`,
    `business_success_rate: ${(businessRate * 100).toFixed(2)}%`,
    `http_req_failed_rate: ${(httpFailedRate * 100).toFixed(2)}%`
  ];
  const flowLines = [
    `admin_iterations: ${adminSuccess + adminFailure}`,
    `admin_failed: ${adminFailure}`,
    `shockwave_admin_iterations: ${shockwaveAdminSuccess + shockwaveAdminFailure}`,
    `shockwave_admin_failed: ${shockwaveAdminFailure}`,
    `shockwave_crm_iterations: ${shockwaveCrmSuccess + shockwaveCrmFailure}`,
    `shockwave_crm_failed: ${shockwaveCrmFailure}`,
    `shockwave_hr_iterations: ${shockwaveHrSuccess + shockwaveHrFailure}`,
    `shockwave_hr_failed: ${shockwaveHrFailure}`
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
    "Latency Buckets (ms)",
    ...bucketLines,
    "",
    "Slow Requests (>5s)",
    ...slowSummaryLines,
    "",
    "Slow Endpoints (>5s)",
    ...slowEndpointLines,
    "",
    "Flow Results",
    ...flowLines,
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
    latencyLines: bucketLines,
    slowSummaryLines,
    slowEndpointLines,
    flowLines,
    taskSummaryLines,
    appTaskSummaryLines,
    rateLines
  });
  return {
    stdout: `${lines.join("\n")}\n`,
    "ops3-summary.html": html,
    "ops3-summary.json": JSON.stringify(data, null, 2)
  };
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
    if (passMetric + failMetric > 0) {
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

function shouldQueryListView() {
  if (QUERY_LIST_VIEW_EVERY <= 1) return true;
  return __ITER % QUERY_LIST_VIEW_EVERY === 0;
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
      if (passMetric + failMetric > 0) {
        lines.push(`${app}_${task}_passed: ${passMetric}`, `${app}_${task}_failed: ${failMetric}`);
      }
    }
  }
  return lines;
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

function recordDurationBucket(res) {
  if (!res || typeof res.timings?.duration !== "number") return;
  const ms = res.timings.duration;
  if (ms >= 1 && ms < 100) bucket1to100.add(1);
  else if (ms < 1000) bucket100to1000.add(1);
  else if (ms < 3000) bucket1000to3000.add(1);
  else if (ms < 5000) bucket3000to5000.add(1);
  else if (ms < 10000) bucket5000to10000.add(1);
  else bucket10000plus.add(1);
}

function buildBucketSummaryLines(data) {
  return [
    `1-100: ${data.metrics?.resp_1_100ms?.values?.count ?? 0}`,
    `100-1000: ${data.metrics?.resp_100_1000ms?.values?.count ?? 0}`,
    `1000-3000: ${data.metrics?.resp_1000_3000ms?.values?.count ?? 0}`,
    `3000-5000: ${data.metrics?.resp_3000_5000ms?.values?.count ?? 0}`,
    `5000-10000: ${data.metrics?.resp_5000_10000ms?.values?.count ?? 0}`,
    `10000+: ${data.metrics?.resp_10000plus_ms?.values?.count ?? 0}`
  ];
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

function buildHtmlReport(sections) {
  const summaryRows = buildKeyValueRows(sections.summaryLines);
  const latencyRows = buildKeyValueRows(sections.latencyLines);
  const slowRows = buildKeyValueRows(sections.slowSummaryLines);
  const slowEndpointRows = buildKeyValueRows(sections.slowEndpointLines);
  const flowRows = buildKeyValueRows(sections.flowLines);
  const taskRows = buildKeyValueRows(sections.taskSummaryLines);
  const appTaskRows = buildKeyValueRows(sections.appTaskSummaryLines);
  const rateRows = buildKeyValueRows(sections.rateLines);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Ops3 Load Test Report</title>
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
  <h1>Ops3 Load Test Report</h1>
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
    <h2>Flow Results</h2>
    <table class="mono">${flowRows}</table>
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

function buildIdPrefix() {
  return Math.floor(Math.random() * 46656)
    .toString(36)
    .toUpperCase()
    .padStart(3, "0")
    .slice(-3);
}

function pickFileField(fields) {
  const fileField = fields.find((field) => {
    const type = normalize(field.type);
    return type === "file" || type === "files";
  });
  return fileField?.api_name ?? null;
}

function buildRecordPayload({ objectApi, describe }) {
  const fields = Array.isArray(describe?.fields) ? describe.fields : [];
  const candidateFields = resolveCreateCandidateFields(describe, fields);
  const requiredFields = candidateFields.filter((field) => field.required);
  const payload = {};
  let ok = true;

  for (const field of requiredFields) {
    const value = resolveFieldValue(field);
    if (value === undefined) {
      ok = false;
      break;
    }
    payload[field.api_name] = value;
  }

  if (Object.keys(payload).length === 0) {
    const nameField = candidateFields.find((field) => normalize(field.api_name) === "name");
    if (nameField) {
      payload[nameField.api_name] = buildLoadText("Load");
    } else if (candidateFields.length > 0) {
      const value = resolveFieldValue(candidateFields[0]);
      if (value !== undefined) {
        payload[candidateFields[0].api_name] = value;
      } else {
        ok = false;
      }
    } else {
      ok = false;
    }
  }

  applyObjectDefaults(objectApi, fields, payload);
  return { __ok: ok, payload };
}

function resolveCreateCandidateFields(describe, fields) {
  const fieldMap = new Map(
    fields.map((field) => [normalize(field.api_name), field])
  );
  const orderedApiNames = [
    ...extractLayoutFieldApiNames(describe?.creation_layout),
    ...extractFormFieldApiNames(describe?.form)
  ];
  const selected = [];
  const seen = new Set();

  for (const apiName of orderedApiNames) {
    const normalizedApiName = normalize(apiName);
    const field = fieldMap.get(normalizedApiName);
    if (!field || seen.has(normalizedApiName) || shouldSkipCreateField(field)) {
      continue;
    }
    seen.add(normalizedApiName);
    selected.push(field);
  }

  if (selected.length > 0) {
    return selected;
  }

  return fields.filter((field) => !shouldSkipCreateField(field));
}

function extractLayoutFieldApiNames(layout) {
  const definition = layout?.definition_json;
  if (!definition) return [];
  const explicit = Array.isArray(definition.fields) ? definition.fields : [];
  const fromSections = Array.isArray(definition.sections)
    ? definition.sections.flatMap((section) => (Array.isArray(section?.fields) ? section.fields : []))
    : [];
  return [...explicit, ...fromSections]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length > 0);
}

function extractFormFieldApiNames(form) {
  const sections = Array.isArray(form?.definition_json?.sections) ? form.definition_json.sections : [];
  return sections
    .flatMap((section) => (Array.isArray(section?.fields) ? section.fields : []))
    .map((value) => String(value || "").trim())
    .filter((value) => value.length > 0);
}

function shouldSkipCreateField(field) {
  const apiName = normalize(field?.api_name);
  const type = normalize(field?.type);
  if (!apiName) return true;
  if (field?.is_masked) return true;
  if (field?.read_only) return true;
  if (SYSTEM_CREATE_EXCLUDED_FIELDS.has(apiName)) return true;
  if (type === "reference") return true;
  if (type === "file" || type === "files") return true;
  return false;
}

function applyObjectDefaults(objectApi, fields, payload) {
  const api = normalize(objectApi);
  if (api === "opportunity") {
    if (!Object.prototype.hasOwnProperty.call(payload, "amount")) payload.amount = 1;
    if (!Object.prototype.hasOwnProperty.call(payload, "probability")) payload.probability = 0.5;
  }
}

function resolveFieldValue(field) {
  if (field.default_value !== null && field.default_value !== undefined) {
    return field.default_value;
  }
  const type = normalize(field.type);
  if (type === "text" || type === "string" || type === "email") {
    return buildLoadText("Load");
  }
  if (type === "number" || type === "decimal" || type === "float") {
    return 1;
  }
  if (type === "int" || type === "integer") {
    return 1;
  }
  if (type === "boolean") {
    return true;
  }
  if (type === "date") {
    return new Date().toISOString().slice(0, 10);
  }
  if (type === "datetime") {
    return new Date().toISOString();
  }
  if (type === "picklist" || type === "enum") {
    const values = Array.isArray(field.picklist_values) ? field.picklist_values : [];
    const active = values.find((item) => item.active !== false);
    return active?.value ?? values[0]?.value ?? undefined;
  }
  return undefined;
}
