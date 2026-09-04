/// <reference types="k6" />
// Generic Core Platform load driver.
//
// Nothing about the tenant is hardcoded: the catalog of apps, objects and list
// views is discovered through the API during setup(), so the same script drives
// any install. Shape (constant / ramp / spike / soak / breakpoint) and the
// operation mix come from env, which is what lets the Observability Load Lab
// expose one script as many profiles.
import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 403, 404));

const API_BASE = (__ENV.API_BASE || __ENV.VITE_API_BASE || "http://localhost:5001").replace(/\/$/, "");
const ADMIN_USERNAME = __ENV.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || "admin";
const SCENARIO = (__ENV.SCENARIO || "constant").toLowerCase();
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || "1m";
const THINK_MS = Number(__ENV.THINK_MS || 500);
const MAX_APPS = Number(__ENV.MAX_APPS || 5);
const MAX_OBJECTS_PER_APP = Number(__ENV.MAX_OBJECTS_PER_APP || 4);
const PAGE_SIZE = Number(__ENV.PAGE_SIZE || 25);
const SETUP_WAIT_SECONDS = Number(__ENV.SETUP_WAIT_SECONDS || 0);
const FAIL_RATE_THRESHOLD = Number(__ENV.FAIL_RATE_THRESHOLD || 0.1);
const P95_THRESHOLD_MS = Number(__ENV.P95_THRESHOLD_MS || 40000);
const ABORT_ON_BREACH = String(__ENV.ABORT_ON_BREACH || "0") === "1";
const SESSION_REFRESH_EVERY = Math.max(0, Number(__ENV.SESSION_REFRESH_EVERY || 0));

const parseJsonEnv = (raw, fallback) => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
};

const OP_MIX = parseJsonEnv(__ENV.OP_MIX, {
  list_records: 5,
  query_list_view: 3,
  read_record: 2,
  describe_object: 1,
  search: 1
});

const USER_POOL = (__ENV.USER_POOL || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separator = entry.indexOf(":");
    return separator < 0
      ? { username: entry, password: `${entry}@123` }
      : { username: entry.slice(0, separator), password: entry.slice(separator + 1) };
  });

const opDuration = new Trend("op_duration", true);
const opFailures = new Counter("op_failures");
const loginFailures = new Counter("login_failures");
const authRateLimited = new Counter("auth_rate_limited");
const errorRate = new Rate("op_error_rate");
const bucket = {
  fast: new Counter("resp_under_100ms"),
  normal: new Counter("resp_100_1000ms"),
  slow: new Counter("resp_1000_3000ms"),
  verySlow: new Counter("resp_3000_10000ms"),
  critical: new Counter("resp_over_10000ms")
};

const recordBucket = (ms) => {
  if (ms < 100) bucket.fast.add(1);
  else if (ms < 1000) bucket.normal.add(1);
  else if (ms < 3000) bucket.slow.add(1);
  else if (ms < 10000) bucket.verySlow.add(1);
  else bucket.critical.add(1);
};

const buildStages = () => {
  const explicit = parseJsonEnv(__ENV.STAGES, null);
  if (Array.isArray(explicit) && explicit.length > 0) return explicit;
  if (SCENARIO === "ramp" || SCENARIO === "breakpoint") {
    const steps = Number(__ENV.RAMP_STEPS || 5);
    const stepDuration = __ENV.RAMP_STEP_DURATION || "1m";
    const stages = [];
    for (let step = 1; step <= steps; step += 1) {
      stages.push({ duration: __ENV.RAMP_UP || "20s", target: Math.round((VUS / steps) * step) });
      stages.push({ duration: stepDuration, target: Math.round((VUS / steps) * step) });
    }
    stages.push({ duration: "30s", target: 0 });
    return stages;
  }
  if (SCENARIO === "spike") {
    const baseline = Math.max(1, Math.round(VUS / 10));
    return [
      { duration: __ENV.SPIKE_BASELINE || "1m", target: baseline },
      { duration: __ENV.SPIKE_RISE || "10s", target: VUS },
      { duration: __ENV.SPIKE_HOLD || "1m", target: VUS },
      { duration: __ENV.SPIKE_FALL || "10s", target: baseline },
      { duration: __ENV.SPIKE_RECOVER || "2m", target: baseline }
    ];
  }
  return null;
};

const stages = buildStages();

export const options = {
  scenarios: stages
    ? {
        driver: {
          executor: "ramping-vus",
          startVUs: Number(__ENV.START_VUS || 1),
          stages,
          gracefulRampDown: "20s"
        }
      }
    : {
        driver: {
          executor: "constant-vus",
          vus: VUS,
          duration: DURATION
        }
      },
  setupTimeout: "3m",
  thresholds: {
    http_req_failed: [{ threshold: `rate<${FAIL_RATE_THRESHOLD}`, abortOnFail: ABORT_ON_BREACH }],
    http_req_duration: [{ threshold: `p(95)<${P95_THRESHOLD_MS}`, abortOnFail: ABORT_ON_BREACH }]
  }
};

const jsonHeaders = (token) => ({
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {})
});

const login = (username, password) => {
  const response = http.post(
    `${API_BASE}/auth/login`,
    JSON.stringify({ username, password }),
    { headers: { "Content-Type": "application/json" }, tags: { op: "login" } }
  );
  if (response.status === 429) authRateLimited.add(1);
  if (response.status !== 200) {
    loginFailures.add(1);
    return null;
  }
  const body = response.json();
  return body?.token ?? body?.access_token ?? body?.data?.token ?? null;
};

const getJson = (token, path, op) => {
  const started = Date.now();
  const response = http.get(`${API_BASE}${path}`, { headers: jsonHeaders(token), tags: { op } });
  const elapsed = Date.now() - started;
  opDuration.add(elapsed, { op });
  recordBucket(elapsed);
  const ok = response.status >= 200 && response.status < 400;
  errorRate.add(!ok, { op });
  if (!ok) opFailures.add(1, { op, status: String(response.status) });
  check(response, { [`${op} ok`]: () => ok });
  return ok ? response.json() : null;
};

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.results)) return value.results;
  return [];
};

export const setup = () => {
  if (SETUP_WAIT_SECONDS > 0) sleep(SETUP_WAIT_SECONDS);
  const token = login(ADMIN_USERNAME, ADMIN_PASSWORD);
  if (!token) throw new Error(`admin login failed against ${API_BASE}`);

  const catalog = [];
  const apps = asArray(getJson(token, "/api/apps", "list_apps")).slice(0, MAX_APPS);
  for (const app of apps) {
    const appId = app.id ?? app.app_id;
    if (!appId) continue;
    const objects = asArray(getJson(token, `/api/apps/${appId}/objects`, "list_objects")).slice(
      0,
      MAX_OBJECTS_PER_APP
    );
    const entries = [];
    for (const object of objects) {
      const objectApi = object.api_name ?? object.apiName ?? object.name;
      if (!objectApi) continue;
      const listViews = asArray(
        getJson(token, `/api/apps/${appId}/objects/${objectApi}/list-views`, "list_views")
      );
      entries.push({
        objectApi,
        listViewIds: listViews
          .map((view) => view.id ?? view.list_view_id)
          .filter(Boolean)
          .slice(0, 3)
      });
    }
    if (entries.length > 0) catalog.push({ appId, objects: entries });
  }
  if (catalog.length === 0) throw new Error("discovery found no apps with objects — seed the instance first");
  return { catalog };
};

const weightedOps = (() => {
  const expanded = [];
  for (const [op, weight] of Object.entries(OP_MIX)) {
    for (let index = 0; index < Number(weight || 0); index += 1) expanded.push(op);
  }
  return expanded.length > 0 ? expanded : ["list_records"];
})();

const vuState = { token: null, identity: null, retryAfter: 0, attempts: 0 };

const LOGIN_BACKOFF_BASE_MS = Number(__ENV.LOGIN_RETRY_BASE_MS || 2000);
const LOGIN_MAX_ATTEMPTS = Number(__ENV.LOGIN_MAX_ATTEMPTS || 8);

// A rate-limited login must back off. Retrying every iteration turns one
// throttled VU into a login storm that drowns out the workload being measured.
const ensureToken = () => {
  if (vuState.token) return vuState.token;
  if (Date.now() < vuState.retryAfter) return null;
  if (vuState.attempts >= LOGIN_MAX_ATTEMPTS) {
    vuState.retryAfter = Date.now() + 60_000;
    vuState.attempts = 0;
    return null;
  }

  const identity =
    USER_POOL.length > 0
      ? USER_POOL[(exec.vu.idInTest - 1) % USER_POOL.length]
      : { username: ADMIN_USERNAME, password: ADMIN_PASSWORD };
  vuState.identity = identity.username;
  vuState.attempts += 1;
  vuState.token = login(identity.username, identity.password);
  if (vuState.token) {
    vuState.attempts = 0;
    return vuState.token;
  }
  // Exponential backoff with a per-VU jitter so retries do not resynchronise.
  const backoff = LOGIN_BACKOFF_BASE_MS * Math.pow(2, vuState.attempts - 1);
  vuState.retryAfter = Date.now() + Math.min(backoff, 60_000) * (0.75 + Math.random() * 0.5);
  return null;
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export default function driver(data) {
  if (SESSION_REFRESH_EVERY > 0 && __ITER > 0 && __ITER % SESSION_REFRESH_EVERY === 0) {
    vuState.token = null;
  }
  const token = ensureToken();
  if (!token) {
    // Idle while backing off; do not count this as workload.
    sleep(1 + Math.random());
    return;
  }
  const app = pick(data.catalog);
  const target = pick(app.objects);
  const op = pick(weightedOps);
  const base = `/api/apps/${app.appId}/objects/${target.objectApi}`;

  switch (op) {
    case "describe_object":
      getJson(token, `${base}/describe`, "describe_object");
      break;
    case "query_list_view": {
      if (target.listViewIds.length === 0) {
        getJson(token, `${base}/records?page=1&page_size=${PAGE_SIZE}`, "list_records");
        break;
      }
      const listViewId = pick(target.listViewIds);
      getJson(token, `${base}/list-views/${listViewId}`, "query_list_view");
      break;
    }
    case "read_record": {
      const page = getJson(token, `${base}/records?page=1&page_size=5`, "list_records");
      const record = asArray(page)[0];
      const recordId = record?.id ?? record?.record_id;
      if (recordId) getJson(token, `${base}/records/${recordId}`, "read_record");
      break;
    }
    case "search":
      getJson(
        token,
        `/api/apps/${app.appId}/search?q=${encodeURIComponent(target.objectApi.slice(0, 3))}`,
        "search"
      );
      break;
    case "list_records":
    default:
      getJson(token, `${base}/records?page=1&page_size=${PAGE_SIZE}`, "list_records");
      break;
  }

  if (THINK_MS > 0) sleep(THINK_MS / 1000);
}
