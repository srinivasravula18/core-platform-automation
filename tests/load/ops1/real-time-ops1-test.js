/// <reference types="k6" />
// VUs and actions in ops1 test:
// - Admin app VU (admin user): login, resolve app, list apps, list objects.
// - Shockwave admin VUs (admin user): login, app/tabs, list views, query list views.
// - Shockwave LIMS VUs (User01-User45): login, LIMS app/tabs, list views/query, then:
//   - User01-20 read-only (list records)
//   - User21-35 create+delete
//   - User36-45 update existing record
// - Shockwave CRM VUs (User51-User94): login, CRM app/tabs, list views/query, then:
//   - User51-70 read-only (list records)
//   - User71-85 create+delete
//   - User86-94 update existing record
// - Shockwave HR VUs (User46-50, User95-99): login, HR app/tabs, list views/query, then create+update.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 403, 404));

const http429Rate = new Rate("http_429_rate");
const http429Count = new Counter("http_429_count");
const TASK_NAMES = [
  "login",
  "list_apps",
  "list_tabs",
  "list_views",
  "query_list_view",
  "list_objects",
  "list_records",
  "create_record",
  "update_record",
  "delete_record",
  "search"
];
const APP_NAMES = ["LIMS", "CRM", "HR"];
const APP_TASK_NAMES = [
  "list_views",
  "query_list_view",
  "list_records",
  "create_record",
  "update_record",
  "delete_record",
  "search"
];
const taskCountMetrics = buildTaskCountCounters(TASK_NAMES);
const taskDurationMetrics = buildTaskTrends(TASK_NAMES);
const taskPassMetrics = buildTaskCounters(TASK_NAMES, "passed");
const taskFailMetrics = buildTaskCounters(TASK_NAMES, "failed");
const taskSlowMetrics = buildTaskCounters(TASK_NAMES, "over_5s");
const appTaskPassMetrics = buildAppTaskCounters(APP_NAMES, APP_TASK_NAMES, "passed");
const appTaskFailMetrics = buildAppTaskCounters(APP_NAMES, APP_TASK_NAMES, "failed");
const latencyBucketMetrics = buildLatencyBuckets();
const slowEndpointCounts = {};
const businessSuccessCount = new Counter("business_success_count");
const businessFailureCount = new Counter("business_failure_count");
const businessSuccessRate = new Rate("business_success_rate");
const adminFlowSuccessCount = new Counter("flow_admin_success_count");
const adminFlowFailureCount = new Counter("flow_admin_failure_count");
const shockwaveAdminFlowSuccessCount = new Counter("flow_shockwave_admin_success_count");
const shockwaveAdminFlowFailureCount = new Counter("flow_shockwave_admin_failure_count");
const shockwaveLimsFlowSuccessCount = new Counter("flow_shockwave_lims_success_count");
const shockwaveLimsFlowFailureCount = new Counter("flow_shockwave_lims_failure_count");
const shockwaveCrmFlowSuccessCount = new Counter("flow_shockwave_crm_success_count");
const shockwaveCrmFlowFailureCount = new Counter("flow_shockwave_crm_failure_count");
const shockwaveHrFlowSuccessCount = new Counter("flow_shockwave_hr_success_count");
const shockwaveHrFlowFailureCount = new Counter("flow_shockwave_hr_failure_count");

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
const LIMS_OBJECT_API = (__ENV.LIMS_OBJECT_API || "").trim();
const CRM_OBJECT_API = (__ENV.CRM_OBJECT_API || "").trim();
const HR_OBJECT_API = (__ENV.HR_OBJECT_API || "").trim();
const USER_POOL = parseUserPool(__ENV.USER_POOL || "");
const USE_POOL_FOR_SHOCKWAVE = String(__ENV.USE_POOL_FOR_SHOCKWAVE || "1") !== "0";
const USE_SEPARATE_USER_SCENARIOS = String(__ENV.USE_SEPARATE_USER_SCENARIOS || "0") !== "0";
const SKIP_LIST_TABS = String(__ENV.SKIP_LIST_TABS || "0") === "1";
const QUERY_LIST_VIEW_EVERY = Math.max(1, Number(__ENV.QUERY_LIST_VIEW_EVERY || 1));

const VUS = Number(__ENV.VUS || 30);
const DURATION = __ENV.DURATION || "1m";
const SETUP_WAIT_SECONDS = Number(__ENV.SETUP_WAIT_SECONDS || 30);
const MIN_ITERATION_MS = Number(__ENV.MIN_ITERATION_MS || 1200);
const FAILURE_LOG_LIMIT = Number(__ENV.FAILURE_LOG_LIMIT || 50);

// Default split: 1 admin app VU, 2 shockwave admin VUs, 12 LIMS, 11 CRM, 5 HR.
const ADMIN_APP_VUS = Number(__ENV.ADMIN_APP_VUS || 1);
const SHOCKWAVE_ADMIN_VUS = Number(__ENV.SHOCKWAVE_ADMIN_VUS || 2);
const LIMS_VUS = Number(__ENV.LIMS_VUS || 12);
const CRM_VUS = Number(__ENV.CRM_VUS || 11);
const HR_VUS = Number(__ENV.HR_VUS || 5);
const SHOCKWAVE_VUS = Math.max(0, VUS - ADMIN_APP_VUS);

// Scenarios: admin flow + Shockwave flow (pool-based users).
export const options = {
  scenarios: buildScenarios(DURATION, USER_POOL),
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

// Session cache to avoid re-login on every iteration.
const sessions = {
  admin: {
    token: null,
    lastAuthAt: 0,
    appIdByLabel: {},
    lastAppLookupAt: 0,
    tabsByApp: {},
    objectsByApp: {}
  },
  pool: {
    token: null,
    lastAuthAt: 0,
    appIdByLabel: {},
    lastAppLookupAt: 0,
    tabsByApp: {},
    objectsByApp: {}
  }
};

const authHeaders = (token) => ({
  headers: { Authorization: `Bearer ${token}` }
});

// Track 429s so we can report them in the summary.
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

const recordBusinessResult = (success) => {
  if (success) {
    businessSuccessCount.add(1);
  } else {
    businessFailureCount.add(1);
  }
  businessSuccessRate.add(Boolean(success));
};

const recordFlowResult = (flow, success) => {
  const ok = Boolean(success);
  if (flow === "admin") {
    if (ok) adminFlowSuccessCount.add(1);
    else adminFlowFailureCount.add(1);
    return;
  }
  if (flow === "shockwave_admin") {
    if (ok) shockwaveAdminFlowSuccessCount.add(1);
    else shockwaveAdminFlowFailureCount.add(1);
    return;
  }
  if (flow === "shockwave_lims") {
    if (ok) shockwaveLimsFlowSuccessCount.add(1);
    else shockwaveLimsFlowFailureCount.add(1);
    return;
  }
  if (flow === "shockwave_crm") {
    if (ok) shockwaveCrmFlowSuccessCount.add(1);
    else shockwaveCrmFlowFailureCount.add(1);
    return;
  }
  if (flow === "shockwave_hr") {
    if (ok) shockwaveHrFlowSuccessCount.add(1);
    else shockwaveHrFlowFailureCount.add(1);
  }
};

const login = (username, password) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = http.post(
      `${API_BASE}/auth/login`,
      JSON.stringify({ username, password }),
      { headers: { "Content-Type": "application/json" } }
    );
    recordRateLimit(res);
    const ok = res.status === 200;
    recordTask("login", res, ok);
    if (res.status === 429) {
      sleep(0.2 + Math.random() * 0.5);
      continue;
    }
    check(res, { "login status is 200": (r) => r.status === 200 });
    if (!ok) return { ok: false, token: null };
    const body = res.json();
    return { ok: typeof body?.token === "string" && body.token.length > 0, token: body?.token ?? null };
  }
  return { ok: false, token: null };
};

const getSession = (key, username, password) => {
  const entry = sessions[key];
  const now = Date.now();
  if (!entry.token || now - entry.lastAuthAt > 20 * 60 * 1000) {
    const result = login(username, password);
    if (!result.ok || !result.token) return { ok: false, session: null };
    entry.token = result.token;
    entry.lastAuthAt = now;
  }
  return { ok: true, session: entry };
};

const listApps = (token) => {
  const res = http.get(`${API_BASE}/api/apps`, authHeaders(token));
  recordRateLimit(res);
  recordTask("list_apps", res, res.status === 200);
  check(res, { "apps list status is 200": (r) => r.status === 200 });
  if (res.status !== 200) return { ok: false, items: [] };
  try {
    const body = res.json();
    return { ok: true, items: Array.isArray(body?.items) ? body.items : [] };
  } catch {
    return { ok: false, items: [] };
  }
};

const listRecords = (token, appId, objectApi) => {
  const res = http.get(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records?page=1&page_size=10`,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("list_records", res, res.status === 200);
  check(res, { "record list status is 200": (r) => r.status === 200 || r.status === 403 });
  if (res.status !== 200) return { ok: false, items: [] };
  try {
    const body = res.json();
    return { ok: true, items: Array.isArray(body?.items) ? body.items : [] };
  } catch {
    return { ok: false, items: [] };
  }
};

const listObjects = (token, appId) => {
  const res = http.get(`${API_BASE}/api/apps/${appId}/objects`, authHeaders(token));
  recordRateLimit(res);
  recordTask("list_objects", res, res.status === 200);
  check(res, { "objects list status is 200": (r) => r.status === 200 || r.status === 403 });
  if (res.status !== 200) return { ok: false, items: [] };
  try {
    const body = res.json();
    return { ok: true, items: Array.isArray(body?.items) ? body.items : [] };
  } catch {
    return { ok: false, items: [] };
  }
};

const listObjectsCached = (session, appId) => {
  const cached = session.objectsByApp?.[appId];
  if (cached) return { ok: true, items: cached };
  const result = listObjects(session.token, appId);
  if (result.ok) session.objectsByApp[appId] = result.items;
  return result;
};

const createRecord = (token, appId, objectApi) => {
  const res = http.post(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records`,
    JSON.stringify({ name: `Load ${Date.now()}` }),
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
  recordRateLimit(res);
  recordTask("create_record", res, res.status === 201);
  check(res, { "record create status is 201": (r) => r.status === 201 || r.status === 403 });
  if (res.status !== 201) return { ok: false, recordId: null };
  try {
    const body = res.json();
    const recordId = body?.id || body?.record_id || body?.recordId || null;
    return { ok: Boolean(recordId), recordId };
  } catch {
    return { ok: false, recordId: null };
  }
};

const updateRecord = (token, appId, objectApi, recordId) => {
  const res = http.patch(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/records/${recordId}`,
    JSON.stringify({ name: `Updated ${Date.now()}` }),
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
  recordRateLimit(res);
  recordTask("update_record", res, res.status === 200);
  check(res, { "record update status is 200": (r) => r.status === 200 || r.status === 403 });
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
  check(res, { "record delete status is 200": (r) => r.status === 200 || r.status === 403 });
  return { ok: res.status === 200 };
};

const searchApp = (token, appId, query) => {
  const res = http.get(
    `${API_BASE}/api/apps/${appId}/search?q=${encodeURIComponent(query)}`,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("search", res, res.status === 200);
  check(res, { "search status is 200": (r) => r.status === 200 || r.status === 403 });
  return { ok: res.status === 200 };
};

// Cache app resolution to reduce repeated /api/apps calls.
const resolveAppIdCached = (session, labelOrApi) => {
  const now = Date.now();
  const key = normalize(labelOrApi || "__default__");
  const cached = session.appIdByLabel?.[key];
  if (cached && now - session.lastAppLookupAt < 2 * 60 * 1000) {
    return { ok: true, appId: cached };
  }
  const appsResult = listApps(session.token);
  if (!appsResult.ok) {
    return { ok: false, appId: null };
  }
  const apps = appsResult.items;
  const target = normalize(labelOrApi);
  const match = apps.find(
    (app) => normalize(app.label) === target || normalize(app.api_name) === target
  );
  const appId = match?.id ?? apps[0]?.id ?? null;
  session.appIdByLabel[key] = appId;
  session.lastAppLookupAt = now;
  return { ok: Boolean(appId), appId };
};

// Cache tab list per app to reduce repeated /tabs calls.
const listTabsCached = (session, appId) => {
  const cached = session.tabsByApp?.[appId];
  if (cached) return { ok: true, items: cached };
  const res = http.get(`${API_BASE}/api/apps/${appId}/tabs`, authHeaders(session.token));
  recordRateLimit(res);
  recordTask("list_tabs", res, res.status === 200);
  check(res, { "tabs list status is 200": (r) => r.status === 200 || r.status === 403 });
  if (res.status !== 200) return { ok: false, items: [] };
  try {
    const body = res.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    session.tabsByApp[appId] = items;
    return { ok: true, items };
  } catch {
    return { ok: false, items: [] };
  }
};

// List views and query a small page to simulate real usage.
const listViews = (token, appId, objectApi) => {
  const res = http.get(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/list-views`,
    authHeaders(token)
  );
  recordRateLimit(res);
  recordTask("list_views", res, res.status === 200);
  check(res, { "list views status is 200": (r) => r.status === 200 || r.status === 403 });
  return { ok: res.status === 200 };
};

const queryListView = (token, appId, objectApi) => {
  const res = http.post(
    `${API_BASE}/api/apps/${appId}/objects/${objectApi}/list-views/query`,
    JSON.stringify({ pagination: { page: 1, page_size: 10 }, sort: [], filters: [] }),
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
  recordRateLimit(res);
  recordTask("query_list_view", res, res.status === 200);
  check(res, { "list view query status is 200": (r) => r.status === 200 || r.status === 403 });
  return { ok: res.status === 200 };
};

// Admin app flow: login, list apps, list objects.
const adminLightFlow = () => {
  const startedAt = Date.now();
  let flowSuccess = true;
  const sessionResult = getSession("admin", ADMIN_USERNAME, ADMIN_PASSWORD);
  if (!sessionResult.ok || !sessionResult.session?.token) flowSuccess = false;
  const session = sessionResult.session;
  if (!flowSuccess) {
    recordBusinessResult(false);
    return pace(startedAt);
  }
  const appResult = resolveAppIdCached(session, "");
  if (!appResult.ok || !appResult.appId) flowSuccess = false;
  if (!flowSuccess) {
    recordBusinessResult(false);
    return pace(startedAt);
  }
  const appsResult = listApps(session.token);
  if (!appsResult.ok) flowSuccess = false;
  const objectsResult = listObjectsCached(session, appResult.appId);
  if (!objectsResult.ok) flowSuccess = false;
  recordBusinessResult(flowSuccess);
  recordFlowResult("admin", flowSuccess);
  pace(startedAt);
};

// Shockwave flow: tabs + list views + query for one object, plus app-specific tasks.
const shockwaveLightFlow = (sessionKey, username, password, appLabel, allowedTabs, profile) => {
  const startedAt = Date.now();
  let flowSuccess = true;
  const sessionResult = getSession(sessionKey, username, password);
  if (!sessionResult.ok || !sessionResult.session?.token) flowSuccess = false;
  const session = sessionResult.session;
  if (!flowSuccess) {
    recordBusinessResult(false);
    return pace(startedAt);
  }
  const appResult = resolveAppIdCached(session, appLabel);
  if (!appResult.ok || !appResult.appId) flowSuccess = false;
  if (!flowSuccess) {
    recordBusinessResult(false);
    return pace(startedAt);
  }
  const allowedSet = new Set(allowedTabs.map((label) => normalize(label)));
  let objectApi = null;
  if (SKIP_LIST_TABS) {
    objectApi = resolveObjectApiOverride(appLabel);
    if (!objectApi) {
      const objectsResult = listObjectsCached(session, appResult.appId);
      if (!objectsResult.ok) flowSuccess = false;
      const objects = objectsResult.items;
      const target =
        objects.find(
          (object) =>
            allowedSet.has(normalize(object.label)) || allowedSet.has(normalize(object.api_name))
        ) ?? objects[0];
      objectApi = target?.api_name ?? null;
    }
  } else {
    const tabsResult = listTabsCached(session, appResult.appId);
    if (!tabsResult.ok) flowSuccess = false;
    const tabs = tabsResult.items;
    const target = tabs.find((tab) => allowedSet.has(normalize(tab.label))) ?? tabs[0];
    objectApi = target?.object_api_name ?? null;
  }
  if (objectApi) {
    const listViewsResult = listViews(session.token, appResult.appId, objectApi);
    if (!listViewsResult.ok) flowSuccess = false;
    recordAppTask(appLabel, "list_views", listViewsResult.ok);
    if (shouldQueryListView()) {
      const queryResult = queryListView(session.token, appResult.appId, objectApi);
      if (!queryResult.ok) flowSuccess = false;
      recordAppTask(appLabel, "query_list_view", queryResult.ok);
    }
    if (profile === "read") {
      const listResult = listRecords(session.token, appResult.appId, objectApi);
      if (!listResult.ok) flowSuccess = false;
      recordAppTask(appLabel, "list_records", listResult.ok);
    } else if (profile === "create") {
      const created = createRecord(session.token, appResult.appId, objectApi);
      if (!created.ok) flowSuccess = false;
      recordAppTask(appLabel, "create_record", created.ok);
      if (created.recordId) {
        const del = deleteRecord(session.token, appResult.appId, objectApi, created.recordId);
        if (!del.ok) flowSuccess = false;
        recordAppTask(appLabel, "delete_record", del.ok);
      }
    } else if (profile === "update") {
      const listResult = listRecords(session.token, appResult.appId, objectApi);
      if (!listResult.ok) flowSuccess = false;
      recordAppTask(appLabel, "list_records", listResult.ok);
      const recordId = listResult.items[0]?.id || listResult.items[0]?.record_id || listResult.items[0]?.recordId;
      if (recordId) {
        const updated = updateRecord(session.token, appResult.appId, objectApi, recordId);
        if (!updated.ok) flowSuccess = false;
        recordAppTask(appLabel, "update_record", updated.ok);
      } else {
        flowSuccess = false;
      }
    } else if (profile === "create_update") {
      const created = createRecord(session.token, appResult.appId, objectApi);
      if (!created.ok) flowSuccess = false;
      recordAppTask(appLabel, "create_record", created.ok);
      if (created.recordId) {
        const updated = updateRecord(session.token, appResult.appId, objectApi, created.recordId);
        if (!updated.ok) flowSuccess = false;
        recordAppTask(appLabel, "update_record", updated.ok);
      } else {
        flowSuccess = false;
      }
    } else if (profile === "search") {
      const searchResult = searchApp(session.token, appResult.appId, "load");
      if (!searchResult.ok) flowSuccess = false;
      recordAppTask(appLabel, "search", searchResult.ok);
    }
  } else {
    flowSuccess = false;
  }
  recordBusinessResult(flowSuccess);
  recordFlowResult(profileToFlow(profile, appLabel), flowSuccess);
  pace(startedAt);
};

export const adminFlow = () => adminLightFlow();
export const shockwaveAdminFlow = () => {
  shockwaveLightFlow("admin", ADMIN_USERNAME, ADMIN_PASSWORD, "", [], "admin");
};
export const shockwaveLimsFlow = () => {
  const creds = resolveGroupCredentials("LIMS");
  const scope = resolveUserScope(creds.username);
  const profile = resolveLimsProfile(creds.username);
  shockwaveLightFlow("pool", creds.username, creds.password, scope.appLabel, scope.tabs, profile);
};
export const shockwaveCrmFlow = () => {
  const creds = resolveGroupCredentials("CRM");
  const scope = resolveUserScope(creds.username);
  const profile = resolveCrmProfile(creds.username);
  shockwaveLightFlow("pool", creds.username, creds.password, scope.appLabel, scope.tabs, profile);
};
export const shockwaveHrFlow = () => {
  const creds = resolveGroupCredentials("HR");
  const scope = resolveUserScope(creds.username);
  const profile = resolveHrProfile(creds.username);
  shockwaveLightFlow("pool", creds.username, creds.password, scope.appLabel, scope.tabs, profile);
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

// Resolve pool credential for this VU; fallback if pool is missing.
function resolvePoolCredentials(pool, fallbackUsername, fallbackPassword) {
  if (!USE_POOL_FOR_SHOCKWAVE || !pool || pool.length === 0) {
    return { username: fallbackUsername, password: fallbackPassword };
  }
  const index = (__VU - 1) % pool.length;
  return pool[index] ?? { username: fallbackUsername, password: fallbackPassword };
}

// Map UserNN to app/tab scope (must match tests/load/README.md).
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

function resolveLimsProfile(username) {
  const num = extractUserNumber(username);
  if (!Number.isFinite(num)) return "read";
  if (num <= 20) return "read";
  if (num <= 35) return "create";
  return "update";
}

function resolveCrmProfile(username) {
  const num = extractUserNumber(username);
  if (!Number.isFinite(num)) return "read";
  if (num <= 70) return "read";
  if (num <= 85) return "create";
  return "update";
}

function resolveHrProfile(username) {
  const num = extractUserNumber(username);
  if (!Number.isFinite(num)) return "read";
  return "create_update";
}

function profileToFlow(profile, appLabel) {
  if (appLabel === LIMS_APP_LABEL) return "shockwave_lims";
  if (appLabel === CRM_APP_LABEL) return "shockwave_crm";
  if (appLabel === "HR") return "shockwave_hr";
  if (profile === "admin") return "shockwave_admin";
  return "shockwave_lims";
}

function extractUserNumber(username) {
  const match = /^User(\d{2})$/i.exec(String(username));
  return match ? Number(match[1]) : NaN;
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

// Build scenarios using fixed VU counts: admin + pool Shockwave.
function buildScenarios(duration, userPool) {
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
  const p95 = duration["p(95)"] ?? 0;
  const vusMax = data.metrics?.vus_max?.values?.max ?? 0;
  const vusCurrent = data.metrics?.vus?.values?.value ?? 0;
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
  const shockwaveLimsSuccess =
    data.metrics?.flow_shockwave_lims_success_count?.values?.count ?? 0;
  const shockwaveLimsFailure =
    data.metrics?.flow_shockwave_lims_failure_count?.values?.count ?? 0;
  const shockwaveCrmSuccess =
    data.metrics?.flow_shockwave_crm_success_count?.values?.count ?? 0;
  const shockwaveCrmFailure =
    data.metrics?.flow_shockwave_crm_failure_count?.values?.count ?? 0;
  const shockwaveHrSuccess =
    data.metrics?.flow_shockwave_hr_success_count?.values?.count ?? 0;
  const shockwaveHrFailure =
    data.metrics?.flow_shockwave_hr_failure_count?.values?.count ?? 0;
  const usersUsed = computeUsersUsed();
  const adminIterations = adminSuccess + adminFailure;
  const shockwaveAdminIterations = shockwaveAdminSuccess + shockwaveAdminFailure;
  const shockwaveLimsIterations = shockwaveLimsSuccess + shockwaveLimsFailure;
  const shockwaveCrmIterations = shockwaveCrmSuccess + shockwaveCrmFailure;
  const shockwaveHrIterations = shockwaveHrSuccess + shockwaveHrFailure;
  const taskSummaryLines = buildTaskSummaryLines(data);
  const slowSummaryLines = buildSlowSummaryLines(data);
  const slowEndpointLines = buildSlowEndpointLines();
  const appTaskSummaryLines = buildAppTaskSummaryLines(data);
  const latencyLines = buildLatencyBucketLines(data);
  const summaryLines = [
    `requests_per_second: ${reqRate.toFixed(2)}`,
    `http_req_duration_avg_ms: ${(duration.avg ?? 0).toFixed(2)}`,
    `http_req_duration_min_ms: ${(duration.min ?? 0).toFixed(2)}`,
    `http_req_duration_max_ms: ${(duration.max ?? 0).toFixed(2)}`,
    `http_req_duration_p95_ms: ${p95.toFixed(2)}`,
    `vus_max: ${vusMax}`,
    `vus_current: ${vusCurrent}`,
    `users_used: ${usersUsed}`,
    `business_success_count: ${businessSuccess}`,
    `business_failure_count: ${businessFailure}`,
    `business_success_rate: ${(businessRate * 100).toFixed(2)}%`,
    `http_req_failed_rate: ${(httpFailedRate * 100).toFixed(2)}%`
  ];
  const flowLines = [
    `admin_iterations: ${adminIterations}`,
    `admin_failed: ${adminFailure}`,
    `shockwave_admin_iterations: ${shockwaveAdminIterations}`,
    `shockwave_admin_failed: ${shockwaveAdminFailure}`,
    `shockwave_lims_iterations: ${shockwaveLimsIterations}`,
    `shockwave_lims_failed: ${shockwaveLimsFailure}`,
    `shockwave_crm_iterations: ${shockwaveCrmIterations}`,
    `shockwave_crm_failed: ${shockwaveCrmFailure}`,
    `shockwave_hr_iterations: ${shockwaveHrIterations}`,
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
    "Latency Buckets",
    ...latencyLines,
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
    latencyLines,
    slowSummaryLines,
    slowEndpointLines,
    flowLines,
    taskSummaryLines,
    appTaskSummaryLines,
    rateLines
  });
  return {
    stdout: `${lines.join("\n")}\n`,
    "ops1-summary.html": html
  };
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
  <title>Ops1 Load Test Report</title>
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
  <h1>Ops1 Load Test Report</h1>
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

function computeUsersUsed() {
  const adminUsed = ADMIN_APP_VUS > 0 ? 1 : 0;
  if (USE_SEPARATE_USER_SCENARIOS && USER_POOL.length > 0) {
    return USER_POOL.length + adminUsed;
  }
  if (!USE_POOL_FOR_SHOCKWAVE || USER_POOL.length === 0) {
    const shockwaveUsers = SHOCKWAVE_ADMIN_VUS + LIMS_VUS + CRM_VUS + HR_VUS;
    return adminUsed + (shockwaveUsers > 0 ? 1 : 0);
  }
  const unique = new Set(USER_POOL.map((entry) => entry.username));
  return adminUsed + unique.size;
}

function buildTaskCountCounters(names) {
  const metrics = {};
  for (const name of names) {
    metrics[name] = new Counter(`task_${name}_count`);
  }
  return metrics;
}

function buildTaskCounters(names, suffix) {
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

function resolveObjectApiOverride(appLabel) {
  const key = normalize(appLabel);
  if (key === normalize(LIMS_APP_LABEL) && LIMS_OBJECT_API) return LIMS_OBJECT_API;
  if (key === normalize(CRM_APP_LABEL) && CRM_OBJECT_API) return CRM_OBJECT_API;
  if (key === "hr" && HR_OBJECT_API) return HR_OBJECT_API;
  return "";
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
      if (passMetric > 0 || failMetric > 0) {
        lines.push(`${app}_${task}_passed: ${passMetric}`, `${app}_${task}_failed: ${failMetric}`);
      }
    }
  }
  return lines;
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
