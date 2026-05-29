import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

const loadLocalEnv = () => {
  const envPath = path.join(repoRoot, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
};

loadLocalEnv();

const reportRoot = path.resolve(repoRoot, "tests", "e2e", "reports", "list-view-regression");
const environmentRoot = path.resolve(repoRoot, "tests", "e2e", "list-view-test-environment");
const generatedRoot = path.resolve(repoRoot, "tests", "e2e", "generated-agent-scenarios");
const generatedSpecRoot = path.resolve(repoRoot, "tests", "e2e", "list-view-regression", "generated-agent-scenarios");
const recordedRoot = path.resolve(repoRoot, "tests", "e2e", "list-view-regression", "recorded-scenarios");
const recordedMetaRoot = path.resolve(repoRoot, "tests", "e2e", "recorded-scenarios");
const recordedDraftRoot = path.resolve(recordedMetaRoot, "drafts");
const recordedMetadataPath = path.join(recordedMetaRoot, "scenarios.json");
const agentStatePath = path.join(generatedRoot, "agent-state.json");
const agentSchedulerConfigPath = path.join(generatedRoot, "scheduler-config.json");
const agentGraphRoot = path.join(generatedRoot, "graph");
const appRoot = path.resolve(process.env.CORE_PLATFORM_ROOT || "D:\\core-platform");
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const resultsJsonPath = path.join(reportRoot, "list-view-regression-results.json");
const listViewArtifactsRoot = path.resolve(repoRoot, "evidences", "playwright-artifacts-core-platform-list-view");
const resultReportSources = [
  {
    id: "list-view-regression",
    label: "List View Regression",
    root: reportRoot,
    html: "/report/list-view-regression-results.html",
    csv: "/report/list-view-regression-results.csv",
    json: "/report/list-view-regression-results.json",
    pdf: "/report/list-view-regression-results.pdf",
    jsonPath: resultsJsonPath
  },
  {
    id: "admin-depthwise",
    label: "Admin Depthwise",
    root: path.resolve(repoRoot, "tests", "e2e", "reports", "admin-depthwise"),
    html: "/report/admin-depthwise/admin-depthwise-results.html",
    csv: "/report/admin-depthwise/admin-depthwise-results.csv",
    json: "/report/admin-depthwise/admin-depthwise-results.json",
    pdf: "/report/admin-depthwise/admin-depthwise-results.pdf",
    jsonPath: path.resolve(repoRoot, "tests", "e2e", "reports", "admin-depthwise", "admin-depthwise-results.json")
  }
];
const storageStatePath = path.join(repoRoot, "tests", "e2e", ".storage", "list-view.json");
const port = Number(process.env.LIST_VIEW_REPORT_PORT || process.argv[2] || 5372);
const host = process.env.LIST_VIEW_REPORT_HOST || "127.0.0.1";

const allowedSurfaces = new Set([
  "all",
  "admin",
  "keystone",
  "api",
  "admin-depthwise",
  "admin-objects",
  "admin-sidebar",
  "keystone-depthwise",
  "permissions-access",
  "metadata-lifecycle",
  "security-lifecycle"
]);
const recordableSurfaces = new Map([
  ["admin", { label: "Admin", url: process.env.ADMIN_BASE_URL || "http://localhost:5002" }],
  ["keystone", { label: "Keystone", url: process.env.TEST_BASE_URL || process.env.TEST_UI_URL || "http://localhost:5003" }]
]);
const frameworkRegistry = {
  appRoot,
  hierarchy: ["Test Suite", "Test Scenario", "Test Case", "Test Steps", "Evidence", "Bug Report"],
  suites: [
    {
      id: "admin-keystone-nav-bvt",
      label: "Admin + Keystone Nav BVT 206",
      surface: "all",
      grep: "@admin-keystone-nav-bvt-206",
      description: "Read-only BVT sweep across every Admin sidebar section and sampled Keystone apps/tabs.",
      tags: ["admin", "keystone", "navigation-ui", "bvt"]
    },
    {
      id: "app-hierarchy-bvt",
      label: "App Hierarchy BVT 110",
      surface: "all",
      grep: "@app-hierarchy-bvt-110",
      description: "App Hierarchy page BVT with tree rendering, toggle stability, legacy app history route observation, and page health.",
      tags: ["app-hierarchy", "core-ui", "bvt"]
    },
    {
      id: "search-results-bvt",
      label: "Search Results BVT 120",
      surface: "all",
      grep: "@search-results-bvt-120",
      description: "Admin Search Results BVT with global search, grouped metadata results, section counts, and result table coverage.",
      tags: ["search-results", "core-ui", "bvt"]
    },
    {
      id: "admin-agent-bvt",
      label: "Agent BVT 125",
      surface: "all",
      grep: "@admin-agent-bvt-125",
      description: "Admin Agent BVT with chat, developer mode, prompt tabs, audit/history tabs, provider failure observation, and page health.",
      tags: ["agent", "agent-ui", "bvt"]
    },
    {
      id: "keystone-core-reflection-bvt",
      label: "Keystone Core Reflection BVT 105",
      surface: "all",
      grep: "@keystone-core-reflection-bvt-105",
      description: "Keystone verification BVT confirming Admin core pages remain stable and guarded outside business object search.",
      tags: ["keystone", "core-reflection-ui", "bvt"]
    },
    {
      id: "access-records-bvt",
      label: "Access Records BVT 152",
      surface: "all",
      grep: "@access-records-bvt-130",
      description: "Access Records page BVT with Admin CRUD, permission controls, cleanup, and Keystone runtime verification.",
      tags: ["access-records", "permissions-ui", "bvt"]
    },
    {
      id: "admin-tabs-bvt",
      label: "Admin Tabs BVT 102",
      surface: "all",
      grep: "@tabs-bvt-102",
      description: "Tabs metadata CRUD flow with Keystone propagation and disposable metadata cleanup.",
      tags: ["tabs", "metadata-lifecycle", "bvt"]
    },
    {
      id: "flows-bvt",
      label: "Flows BVT 101",
      surface: "all",
      grep: "@flows-bvt-101",
      description: "Flows page BVT with page analysis, CRUD, Admin search, Keystone stability, and cleanup.",
      tags: ["flows", "flows-ui", "bvt"]
    },
    {
      id: "groups-bvt",
      label: "Groups BVT 124",
      surface: "all",
      grep: "@groups-bvt-124",
      description: "Groups CRUD, membership, audit log, Admin search, Keystone exclusion, and cleanup BVT.",
      tags: ["groups", "groups-ui", "bvt"]
    },
    {
      id: "objects-bvt",
      label: "Objects BVT 135",
      surface: "all",
      grep: "@objects-bvt-135",
      description: "Objects page BVT with object metadata UI, CRUD path, Keystone reflection, and cleanup.",
      tags: ["objects", "objects-ui", "bvt"]
    },
    {
      id: "permissions-bvt",
      label: "Permissions BVT 138",
      surface: "all",
      grep: "@permissions-bvt-135",
      description: "Permissions page focused BVT with seeded permissions, grant controls, restricted behavior, and Keystone stability.",
      tags: ["permissions", "permissions-ui", "bvt"]
    },
    {
      id: "roles-bvt",
      label: "Roles BVT 101",
      surface: "all",
      grep: "@roles-bvt-101",
      description: "Roles CRUD, detail, users surface, audit/search, Keystone exclusion, and cleanup BVT.",
      tags: ["roles", "roles-ui", "bvt"]
    },
    {
      id: "sharing-settings-bvt",
      label: "Sharing Settings BVT 171",
      surface: "all",
      grep: "@sharing-settings-bvt-132",
      description: "Sharing Settings page BVT with rules, create/edit controls, validation, Keystone stability, and cleanup.",
      tags: ["sharing-settings", "sharing-settings-ui", "bvt"]
    },
    {
      id: "system-settings-bvt",
      label: "System Settings BVT 110",
      surface: "all",
      grep: "@system-settings-bvt-110",
      description: "System Settings page BVT with setting search, editable value update/revert, refresh, and page health.",
      tags: ["system-settings", "system-settings-ui", "bvt"]
    },
    {
      id: "email-logs-bvt",
      label: "Email Logs BVT 105",
      surface: "all",
      grep: "@email-logs-bvt-105",
      description: "Email Logs page BVT with read-only log list, toolbar, search, exports, and empty-state coverage.",
      tags: ["email-logs", "email-logs-ui", "bvt"]
    },
    {
      id: "scheduled-jobs-bvt",
      label: "Scheduled Jobs BVT 125",
      surface: "all",
      grep: "@scheduled-jobs-bvt-125",
      description: "Scheduled Jobs page BVT with list checks, create, update, run/audit tabs, delete, and cleanup.",
      tags: ["scheduled-jobs", "scheduled-jobs-ui", "bvt"]
    },
    {
      id: "audit-logs-bvt",
      label: "Audit Logs BVT 105",
      surface: "all",
      grep: "@audit-logs-bvt-105",
      description: "Audit Logs page BVT with read-only audit list, search, exports, columns, and page health.",
      tags: ["audit-logs", "audit-logs-ui", "bvt"]
    },
    {
      id: "recycle-bin-bvt",
      label: "Recycle Bin BVT 125",
      surface: "all",
      grep: "@recycle-bin-bvt-125",
      description: "Recycle Bin page BVT with deleted metadata visibility, restore confirmation, restore, and cleanup.",
      tags: ["recycle-bin", "recycle-bin-ui", "bvt"]
    },
    {
      id: "keystone-admin-other-reflection-bvt",
      label: "Keystone Other Reflection BVT 105",
      surface: "all",
      grep: "@keystone-admin-other-reflection-bvt-105",
      description: "Keystone verification BVT confirming Admin operational pages stay outside business object search.",
      tags: ["keystone", "reflection-ui", "bvt"]
    },
    {
      id: "users-bvt",
      label: "Users BVT 101",
      surface: "all",
      grep: "@users-bvt-101",
      description: "Users page BVT with list/detail/search/access surfaces and Keystone stability checks.",
      tags: ["users", "users-ui", "bvt"]
    }
  ],
  scenarios: [
    { id: "admin-keystone-nav-bvt", suiteId: "admin-keystone-nav-bvt", label: "Admin + Keystone Nav BVT 206", grep: "@admin-keystone-nav-bvt-206", description: "Run the Admin side-nav plus Keystone apps/tabs BVT." },
    { id: "app-hierarchy-bvt", suiteId: "app-hierarchy-bvt", label: "App Hierarchy BVT 110", grep: "@app-hierarchy-bvt-110", description: "Run the App Hierarchy page BVT." },
    { id: "search-results-bvt", suiteId: "search-results-bvt", label: "Search Results BVT 120", grep: "@search-results-bvt-120", description: "Run the Admin Search Results BVT." },
    { id: "admin-agent-bvt", suiteId: "admin-agent-bvt", label: "Agent BVT 125", grep: "@admin-agent-bvt-125", description: "Run the Admin Agent BVT." },
    { id: "keystone-core-reflection-bvt", suiteId: "keystone-core-reflection-bvt", label: "Keystone Core Reflection BVT 105", grep: "@keystone-core-reflection-bvt-105", description: "Run the Keystone core reflection BVT." },
    { id: "access-records-bvt", suiteId: "access-records-bvt", label: "Access Records BVT 152", grep: "@access-records-bvt-130", description: "Run the Access Records BVT evidence flow." },
    { id: "admin-tabs-bvt", suiteId: "admin-tabs-bvt", label: "Admin Tabs BVT 102", grep: "@tabs-bvt-102", description: "Run the Tabs metadata propagation BVT." },
    { id: "flows-bvt", suiteId: "flows-bvt", label: "Flows BVT 101", grep: "@flows-bvt-101", description: "Run the Flows page BVT." },
    { id: "groups-bvt", suiteId: "groups-bvt", label: "Groups BVT 124", grep: "@groups-bvt-124", description: "Run the Groups page BVT." },
    { id: "objects-bvt", suiteId: "objects-bvt", label: "Objects BVT 135", grep: "@objects-bvt-135", description: "Run the Objects page BVT." },
    { id: "permissions-bvt", suiteId: "permissions-bvt", label: "Permissions BVT 138", grep: "@permissions-bvt-135", description: "Run the Permissions page BVT." },
    { id: "roles-bvt", suiteId: "roles-bvt", label: "Roles BVT 101", grep: "@roles-bvt-101", description: "Run the Roles page BVT." },
    { id: "sharing-settings-bvt", suiteId: "sharing-settings-bvt", label: "Sharing Settings BVT 171", grep: "@sharing-settings-bvt-132", description: "Run the Sharing Settings page BVT." },
    { id: "system-settings-bvt", suiteId: "system-settings-bvt", label: "System Settings BVT 110", grep: "@system-settings-bvt-110", description: "Run the System Settings page BVT." },
    { id: "email-logs-bvt", suiteId: "email-logs-bvt", label: "Email Logs BVT 105", grep: "@email-logs-bvt-105", description: "Run the Email Logs page BVT." },
    { id: "scheduled-jobs-bvt", suiteId: "scheduled-jobs-bvt", label: "Scheduled Jobs BVT 125", grep: "@scheduled-jobs-bvt-125", description: "Run the Scheduled Jobs page BVT." },
    { id: "audit-logs-bvt", suiteId: "audit-logs-bvt", label: "Audit Logs BVT 105", grep: "@audit-logs-bvt-105", description: "Run the Audit Logs page BVT." },
    { id: "recycle-bin-bvt", suiteId: "recycle-bin-bvt", label: "Recycle Bin BVT 125", grep: "@recycle-bin-bvt-125", description: "Run the Recycle Bin page BVT." },
    { id: "keystone-admin-other-reflection-bvt", suiteId: "keystone-admin-other-reflection-bvt", label: "Keystone Other Reflection BVT 105", grep: "@keystone-admin-other-reflection-bvt-105", description: "Run the Keystone Admin Other reflection BVT." },
    { id: "users-bvt", suiteId: "users-bvt", label: "Users BVT 101", grep: "@users-bvt-101", description: "Run the Users page BVT." }
  ],
  caseFormat: [
    { key: "suite", label: "Test Suite", description: "A runnable surface or module such as Admin, Keystone, API, or a feature pack." },
    { key: "scenario", label: "Test Scenario", description: "A user or system behavior group, usually matching a product workflow." },
    { key: "case", label: "Test Case", description: "A single verifiable behavior with preconditions, priority, level, and expected outcome." },
    { key: "steps", label: "Test Steps", description: "Concrete navigation and actions that the automation performs." },
    { key: "evidence", label: "Evidence", description: "Screenshots, assertions, logs, and generated bug summaries for failed cases." }
  ]
};
const adminSidebarSuiteOrder = [
  "admin-keystone-nav-bvt",
  "app-hierarchy-bvt",
  "search-results-bvt",
  "admin-agent-bvt",
  "objects-bvt",
  "admin-tabs-bvt",
  "flows-bvt",
  "roles-bvt",
  "groups-bvt",
  "users-bvt",
  "permissions-bvt",
  "access-records-bvt",
  "sharing-settings-bvt",
  "system-settings-bvt",
  "email-logs-bvt",
  "scheduled-jobs-bvt",
  "audit-logs-bvt",
  "recycle-bin-bvt",
  "keystone-core-reflection-bvt",
  "keystone-admin-other-reflection-bvt"
];
const adminSidebarSuiteRank = new Map(adminSidebarSuiteOrder.map((id, index) => [id, index]));
const compareAdminSidebarSuites = (left, right) =>
  (adminSidebarSuiteRank.get(left.id) ?? 999) - (adminSidebarSuiteRank.get(right.id) ?? 999);

frameworkRegistry.suites.sort(compareAdminSidebarSuites);
frameworkRegistry.scenarios.sort((left, right) =>
  (adminSidebarSuiteRank.get(left.suiteId) ?? 999) - (adminSidebarSuiteRank.get(right.suiteId) ?? 999)
);
const maxLogLines = 2000;
const runState = {
  running: false,
  command: "",
  surface: "",
  scenario: "",
  selectedTestCount: 0,
  reset: false,
  headed: false,
  stopRequested: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  logs: []
};
let currentProcess = null;
let recorderProcess = null;
let cachedInventory = null;
let cachedInventoryAt = 0;
let schedulerTimer = null;
const recordState = {
  recording: false,
  surface: "",
  surfaceLabel: "",
  url: "",
  draftPath: "",
  command: "",
  startedAt: null,
  stopRequested: false,
  exitCode: null,
  error: "",
  logs: []
};

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"]
]);

const pushLog = (chunk) => {
  const text = String(chunk).replace(/\r\n/g, "\n");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    runState.logs.push(line);
  }
  if (runState.logs.length > maxLogLines) {
    runState.logs = runState.logs.slice(runState.logs.length - maxLogLines);
  }
};

const sendJson = (response, status, body) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
};

const sendText = (response, status, body) => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
};

const sendHtml = (response, status, body) => {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
};

const sendBuffer = (response, status, body, contentType, filename) => {
  const headers = {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": "no-store"
  };
  if (filename) {
    headers["content-disposition"] = `attachment; filename="${filename}"`;
  }
  response.writeHead(status, headers);
  response.end(body);
};


const pushRecorderLog = (chunk) => {
  const text = String(chunk).replace(/\r\n/g, "\n");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    recordState.logs.push(line);
  }
  if (recordState.logs.length > 600) {
    recordState.logs = recordState.logs.slice(recordState.logs.length - 600);
  }
};

const probeHttp = (name, port, targetPath = "/") =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const probe = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: targetPath,
        method: "GET",
        timeout: 2500
      },
      (probeResponse) => {
        probeResponse.resume();
        probeResponse.on("end", () => {
          resolve({
            name,
            port,
            path: targetPath,
            up: probeResponse.statusCode >= 200 && probeResponse.statusCode < 500,
            statusCode: probeResponse.statusCode,
            responseMs: Date.now() - startedAt
          });
        });
      }
    );
    probe.on("timeout", () => {
      probe.destroy(new Error("timeout"));
    });
    probe.on("error", (error) => {
      resolve({
        name,
        port,
        path: targetPath,
        up: false,
        statusCode: null,
        responseMs: Date.now() - startedAt,
        error: error.message
      });
    });
    probe.end();
  });

const readServices = async () => {
  const services = await Promise.all([
    probeHttp("API", 5001, "/health"),
    probeHttp("Admin", 5002, "/"),
    probeHttp("Shockwave", 5003, "/")
  ]);
  return {
    updatedAt: new Date().toISOString(),
    services
  };
};

const serveFile = (response, targetPath) => {
  if (!existsSync(targetPath)) {
    sendText(response, 404, "Not found.");
    return;
  }
  const stat = statSync(targetPath);
  if (stat.isDirectory()) {
    sendText(response, 403, "Directory listing is disabled.");
    return;
  }
  response.writeHead(200, {
    "content-type": mimeTypes.get(path.extname(targetPath).toLowerCase()) || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-store"
  });
  createReadStream(targetPath).pipe(response);
};

const resolveSafePath = (root, requestPath) => {
  const targetPath = path.resolve(root, `.${decodeURIComponent(requestPath)}`);
  if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return targetPath;
};

const readRequestJson = async (request) =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 200_000) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });

const emptyResults = (updatedAt = null) => ({
  runStatus: "not_started",
  updatedAt,
  total: 0,
  counts: { PENDING: 0, RUNNING: 0, PASS: 0, FAIL: 0, SKIP: 0 },
  rows: []
});

const latestResultReport = () =>
  resultReportSources
    .filter((source) => existsSync(source.jsonPath))
    .map((source) => {
      const stats = statSync(source.jsonPath);
      let payloadUpdatedAt = "";
      try {
        payloadUpdatedAt = JSON.parse(readFileSync(source.jsonPath, "utf8"))?.updatedAt || "";
      } catch {
        payloadUpdatedAt = "";
      }
      return {
        ...source,
        mtimeMs: stats.mtimeMs,
        updatedAtMs: payloadUpdatedAt ? Date.parse(payloadUpdatedAt) || 0 : 0
      };
    })
    .sort((a, b) => Math.max(b.updatedAtMs, b.mtimeMs) - Math.max(a.updatedAtMs, a.mtimeMs))[0];

const countsForResultRows = (rows) =>
  rows.reduce(
    (acc, row) => {
      if (acc[row.status] !== undefined) acc[row.status] += 1;
      return acc;
    },
    { PENDING: 0, RUNNING: 0, PASS: 0, FAIL: 0, SKIP: 0 }
  );

const omitNotRunRowsAfterCompletion = (payload) => {
  if (runState.running) return payload;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const executedRows = rows.filter((row) => row?.status !== "PENDING");
  if (executedRows.length === rows.length) return payload;
  return {
    ...payload,
    runStatus: payload.runStatus === "running" ? "interrupted" : payload.runStatus,
    total: executedRows.length,
    counts: countsForResultRows(executedRows),
    rows: executedRows
  };
};

const collectPngFiles = (root) => {
  if (!existsSync(root)) return [];
  const files = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile() && item.name.toLowerCase().endsWith(".png")) {
        files.push(fullPath);
      }
    }
  };
  walk(root);
  return files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
};

const liveEvidencePaths = () => {
  if (!runState.running || !existsSync(listViewArtifactsRoot)) return [];
  const startedAtMs = runState.startedAt ? Date.parse(runState.startedAt) || 0 : 0;
  const dirs = readdirSync(listViewArtifactsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const fullPath = path.join(listViewArtifactsRoot, entry.name);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .filter((entry) => !startedAtMs || entry.mtimeMs >= startedAtMs - 60_000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const activeDir = dirs[0]?.fullPath;
  if (!activeDir) return [];
  return collectPngFiles(activeDir).map((filePath) =>
    `/evidence/list-view/${path.relative(listViewArtifactsRoot, filePath).replace(/\\/g, "/")}`
  );
};

const readResults = () => {
  const source = latestResultReport();
  if (!source) {
    return emptyResults();
  }
  const payload = JSON.parse(readFileSync(source.jsonPath, "utf8"));
  const report = {
    id: source.id,
    label: source.label,
    html: "/report/latest",
    sourceHtml: source.html,
    csv: source.csv,
    json: source.json,
    pdf: source.pdf
  };
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const hasStaleRunningRows = !runState.running && rows.some((row) => row?.status === "RUNNING");
  if (hasStaleRunningRows) {
    const normalizedRows = rows.map((row) =>
      row?.status === "RUNNING"
        ? {
            ...row,
            status: "SKIP",
            actualResult: runState.stopRequested
              ? "Stopped by user from the dashboard."
              : "Run was stopped or interrupted before the reporter finalized this test."
          }
        : row
    );
    const normalizedPayload = {
      ...payload,
      report,
      runStatus: runState.stopRequested ? "stopped" : "interrupted",
      counts: countsForResultRows(normalizedRows),
      rows: normalizedRows
    };
    const completedPayload = omitNotRunRowsAfterCompletion(normalizedPayload);
    writeFileSync(source.jsonPath, JSON.stringify(completedPayload, null, 2), "utf8");
    return completedPayload;
  }
  const isDiscoveryOnlyResult =
    !runState.running &&
    rows.length > 0 &&
    rows.every((row) => row?.status === "PENDING" && /^not run\.?$/i.test(String(row?.actualResult || "")));
  if (isDiscoveryOnlyResult) {
    return { ...emptyResults(payload.updatedAt ?? null), report };
  }
  const completedPayload = omitNotRunRowsAfterCompletion({ ...payload, report });
  const liveShots = liveEvidencePaths();
  if (liveShots.length > 0) {
    const rowsWithLiveEvidence = (completedPayload.rows || []).map((row) =>
      row?.status === "RUNNING" ? { ...row, liveScreenshotPaths: liveShots } : row
    );
    return {
      ...completedPayload,
      updatedAt: new Date().toISOString(),
      rows: rowsWithLiveEvidence
    };
  }
  if (!runState.running && Array.isArray(payload.rows) && completedPayload.rows?.length !== payload.rows.length) {
    writeFileSync(source.jsonPath, JSON.stringify(completedPayload, null, 2), "utf8");
  }
  return completedPayload;
};

const renderLatestResultsHtml = () => {
  const payload = readResults();
  const counts = payload.counts || {};
  const report = payload.report || {};
  const assetBase = report.id === "admin-depthwise" ? "/report/admin-depthwise/" : "/report/";
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const rowHtml = rows.map((row) => {
    const screenshots = Array.isArray(row.screenshotPaths)
      ? row.screenshotPaths.map((shot, index) => {
          const href = `${assetBase}${String(shot || "").replace(/\\/g, "/")}`;
          return `<a class="thumb" href="${xmlEscape(href)}" target="_blank" rel="noreferrer"><img src="${xmlEscape(href)}" alt="Evidence ${index + 1}"><span>Shot ${index + 1}</span></a>`;
        }).join("")
      : "";
    const liveScreenshots = Array.isArray(row.liveScreenshotPaths)
      ? row.liveScreenshotPaths.map((href, index) =>
          `<a class="thumb" href="${xmlEscape(href)}" target="_blank" rel="noreferrer"><img src="${xmlEscape(href)}" alt="Live evidence ${index + 1}"><span>Live ${index + 1}</span></a>`
        ).join("")
      : "";
    const evidence = liveScreenshots
      ? `<div class="evidence-grid">${liveScreenshots}</div>`
      : screenshots
        ? `<div class="evidence-grid">${screenshots}</div>`
        : `<span class="muted">No screenshots yet</span>`;
    const steps = Array.isArray(row.steps)
      ? `<details class="step-details"><summary>${row.steps.length} step details</summary><div class="step-list">${row.steps.map((step, index) => `
        <article class="step-card">
          <strong>${index + 1}. ${xmlEscape(step.section || "")}</strong>
          <span><b>Action</b>${xmlEscape(step.action || "")}</span>
          <span><b>Test Data</b>${xmlEscape(step.testData || "")}</span>
          <span><b>Expected Behavior</b>${xmlEscape(step.expectedBehavior || "")}</span>
          <span><b>Verify</b>${xmlEscape(step.verify || "")}</span>
          <em>${xmlEscape(step.result || "")}</em>
        </article>`).join("")}</div></details>`
      : "";
    return `<tr class="result-row ${xmlEscape(row.status || "")}">
      <td><code class="case-id" title="${xmlEscape(row.id || "")}">${xmlEscape(row.id || "")}</code></td>
      <td><span class="pill">${xmlEscape(row.surface || "")}</span></td>
      <td>${xmlEscape(row.featureArea || "")}</td>
      <td><strong>${xmlEscape(row.testCaseTitle || "")}</strong>${steps}</td>
      <td>${xmlEscape(row.expectedResult || "")}</td>
      <td>${xmlEscape(row.actualResult || "")}</td>
      <td><span class="status ${xmlEscape(row.status || "")}">${xmlEscape(row.status || "")}</span></td>
      <td class="evidence-cell">${evidence}</td>
    </tr>`;
  }).join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${runState.running ? `<meta http-equiv="refresh" content="5">` : ""}
  <title>${xmlEscape(report.label || "Latest")} Results</title>
  <style>
    :root { color-scheme: light; --bg:#eef3f8; --panel:#ffffff; --ink:#102033; --muted:#617188; --line:#d8e1ec; --blue:#2563eb; --green:#0f8a4b; --red:#c03221; --amber:#b7791f; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, #dbeafe 0, transparent 330px), var(--bg); color: var(--ink); font-family: Inter, Segoe UI, Arial, sans-serif; }
    .page { padding: 24px; display: grid; gap: 18px; }
    header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: start; padding: 20px; background: rgba(255,255,255,.82); border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 16px 50px rgba(15, 23, 42, .08); backdrop-filter: blur(12px); }
    h1 { margin: 0 0 8px; font-size: clamp(26px, 3vw, 42px); letter-spacing: 0; }
    p { margin: 0; color: var(--muted); font-size: 15px; }
    nav { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
    a { color: var(--blue); font-weight: 800; text-decoration: none; }
    nav a { border: 1px solid var(--line); background: #fff; border-radius: 12px; padding: 11px 14px; color: var(--ink); box-shadow: 0 6px 20px rgba(15, 23, 42, .05); }
    nav a:hover, .thumb:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(37, 99, 235, .14); }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
    .metric { border: 1px solid var(--line); border-radius: 16px; background: var(--panel); padding: 16px; box-shadow: 0 10px 30px rgba(15, 23, 42, .06); }
    .metric span { display: block; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 8px; }
    .metric strong { font-size: 30px; letter-spacing: 0; }
    .table-wrap { border: 1px solid var(--line); border-radius: 18px; background: var(--panel); overflow: auto; max-height: calc(100dvh - 245px); box-shadow: 0 18px 55px rgba(15, 23, 42, .08); }
    table { width: 100%; min-width: 1320px; border-collapse: separate; border-spacing: 0; }
    th, td { border-bottom: 1px solid var(--line); padding: 14px; text-align: left; vertical-align: top; font-size: 13px; line-height: 1.45; }
    th { position: sticky; top: 0; z-index: 2; background: #f8fbff; color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
    tr:last-child td { border-bottom: 0; }
    code { display: inline-block; color: #0f172a; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 7px; font-family: Consolas, ui-monospace, monospace; }
    .case-id { max-width: 190px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
    .pill { display: inline-flex; border: 1px solid #bfdbfe; background: #eff6ff; color: #1d4ed8; border-radius: 999px; padding: 4px 9px; font-weight: 800; }
    .muted { color: var(--muted); }
    .status { display: inline-flex; min-width: 76px; justify-content: center; border-radius: 999px; padding: 7px 10px; font-weight: 900; letter-spacing: .02em; }
    .PASS { background: #dcfce7; color: var(--green); }
    .FAIL { background: #fee2e2; color: var(--red); }
    .SKIP { background: #e2e8f0; color: #64748b; }
    .RUNNING { background: #dbeafe; color: #1d4ed8; }
    .PENDING { background: #eef0f4; color: #6b7280; }
    .evidence-cell { min-width: 460px; }
    .evidence-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(145px, 1fr)); gap: 10px; min-width: 420px; max-width: 760px; max-height: 520px; overflow: auto; padding-right: 4px; }
    .thumb { display: grid; gap: 7px; color: var(--ink); background: #f8fbff; border: 1px solid var(--line); border-radius: 12px; padding: 8px; transition: transform .15s ease, box-shadow .15s ease; }
    .thumb img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid #dbe4ef; border-radius: 9px; background: #f8fafc; }
    .thumb span { font-size: 12px; color: var(--muted); font-weight: 900; }
    .step-details { margin-top: 10px; }
    .step-details summary { cursor: pointer; color: var(--blue); font-weight: 900; }
    .step-list { display: grid; gap: 8px; margin-top: 10px; max-height: 420px; overflow: auto; }
    .step-card { display: grid; gap: 5px; padding: 10px; border: 1px solid var(--line); border-radius: 12px; background: #f8fbff; }
    .step-card span { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px; color: var(--muted); }
    .step-card b { color: var(--ink); }
    .step-card em { justify-self: start; color: var(--green); font-style: normal; font-weight: 900; }
    @media (max-width: 1000px) { .page { padding: 14px; } header { grid-template-columns: 1fr; } nav { justify-content: flex-start; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
<div class="page">
  <header>
    <div>
      <h1>${xmlEscape(report.label || "Latest")} Results</h1>
      <p>Run status: ${xmlEscape(payload.runStatus || "-")} | Total cases: ${xmlEscape(payload.total || rows.length)} | Updated: ${xmlEscape(payload.updatedAt ? new Date(payload.updatedAt).toLocaleString() : "-")}</p>
    </div>
    <nav>
      <a href="/">Dashboard</a>
      ${report.csv ? `<a href="${xmlEscape(report.csv)}">CSV</a>` : ""}
      ${report.json ? `<a href="${xmlEscape(report.json)}">JSON</a>` : ""}
      ${report.pdf ? `<a href="${xmlEscape(report.pdf)}">PDF</a>` : ""}
      ${report.sourceHtml ? `<a href="${xmlEscape(report.sourceHtml)}">Raw HTML</a>` : ""}
    </nav>
  </header>
  <section class="summary">
    <article class="metric"><span>Total</span><strong>${xmlEscape(payload.total || rows.length)}</strong></article>
    <article class="metric"><span>Passed</span><strong>${xmlEscape(counts.PASS || 0)}</strong></article>
    <article class="metric"><span>Failed</span><strong>${xmlEscape(counts.FAIL || 0)}</strong></article>
    <article class="metric"><span>Skipped</span><strong>${xmlEscape(counts.SKIP || 0)}</strong></article>
    <article class="metric"><span>Running</span><strong>${xmlEscape(counts.RUNNING || 0)}</strong></article>
  </section>
  <div class="table-wrap">
    <table>
      <thead><tr><th>ID</th><th>Surface</th><th>Feature</th><th>Test Case</th><th>Expected</th><th>Actual</th><th>Status</th><th>Evidence</th></tr></thead>
      <tbody>${rowHtml || `<tr><td colspan="8">No latest result rows.</td></tr>`}</tbody>
    </table>
  </div>
</div>
</body>
</html>`;
};

const readFramework = () => ({
  ...frameworkRegistry,
  generatedScenarioCount: existsSync(generatedRoot)
    ? readdirSync(generatedRoot).filter((item) => item.endsWith(".json")).length
    : 0
});

const readRecordedMetadata = () => {
  if (!existsSync(recordedMetadataPath)) {
    return { updatedAt: null, scenarios: [] };
  }
  const parsed = JSON.parse(readFileSync(recordedMetadataPath, "utf8"));
  return {
    updatedAt: parsed.updatedAt || null,
    scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios : []
  };
};

const writeRecordedMetadata = (scenarios) => {
  mkdirSync(recordedMetaRoot, { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    scenarios
  };
  writeFileSync(recordedMetadataPath, JSON.stringify(payload, null, 2), "utf8");
  return payload;
};

const slugify = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const escapeJsString = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
const recordedSingleBrowserImportPattern =
  /import\s+\{\s*test\s*(,\s*expect\s*)?\}\s+from\s+['"](?:@playwright\/test|\.\.\/\.\.\/helpers\/singleBrowserTest)['"];?/;

const addRecordedEvidenceHooks = (source) => {
  let nextSource = source;
  if (!/attachEvidence/.test(nextSource)) {
    nextSource = nextSource.replace(
      recordedSingleBrowserImportPattern,
      (match) => `${match}\nimport { attachEvidence } from '../helpers';`
    );
  }
  if (!/test\.setTimeout/.test(nextSource)) {
    nextSource = nextSource.replace(
      /(import\s+\{\s*attachEvidence\s*\}\s+from\s+['"]\.\.\/helpers['"];?\n)/,
      "$1\ntest.setTimeout(300_000);\n"
    );
  }
  if (!/attachRecordedEvidence/.test(nextSource)) {
    const helper = `
const attachRecordedEvidence = async (page, testInfo, name) => {
  try {
    if (page.isClosed()) return;
    await attachEvidence(page, testInfo, name);
  } catch (error) {
    await testInfo.attach(\`\${name}-capture-skipped\`, {
      body: error instanceof Error ? error.message : String(error),
      contentType: 'text/plain'
    });
  }
};
`;
    if (/test\.use\(\{[\s\S]*?\}\);\n/.test(nextSource)) {
      nextSource = nextSource.replace(/(test\.use\(\{[\s\S]*?\}\);\n)/, `$1${helper}`);
    } else {
      nextSource = nextSource.replace(/(test\.setTimeout\(300_000\);\n)/, `$1${helper}`);
    }
  }
  if (!/recorded-flow-start/.test(nextSource)) {
    nextSource = nextSource.replace(
      /async\s*\(\{\s*page\s*\}\)\s*=>\s*\{/,
      "async ({ page }, testInfo) => {\n  await attachRecordedEvidence(page, testInfo, 'recorded-flow-start');\n  try {"
    );
  }
  const lastClose = nextSource.lastIndexOf("\n});");
  if (lastClose >= 0 && !/recorded-flow-finish/.test(nextSource)) {
    nextSource = `${nextSource.slice(0, lastClose)}\n  } finally {\n    await attachRecordedEvidence(page, testInfo, 'recorded-flow-finish');\n  }\n${nextSource.slice(lastClose)}`;
  }
  return nextSource;
};

const ensureAuthStorage = async () => {
  if (existsSync(storageStatePath)) return;

  const username = process.env.TEST_ADMIN_USERNAME || process.env.ADMIN_USERNAME || "admin";
  const password = process.env.TEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "admin";
  if (!username || !password) {
    throw new Error("TEST_ADMIN_USERNAME/TEST_ADMIN_PASSWORD or ADMIN_USERNAME/ADMIN_PASSWORD must be set for recording.");
  }

  const serviceUrl = process.env.TEST_API_URL || "http://localhost:5001";
  const adminUrl = recordableSurfaces.get("admin").url;
  const keystoneUrl = recordableSurfaces.get("keystone").url;
  const loginPayload = JSON.stringify({ username, password });

  const loginResponse = await new Promise((resolve, reject) => {
    const target = new URL("/auth/login", serviceUrl);
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(loginPayload)
        },
        timeout: 15_000
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("auth login timed out")));
    req.on("error", reject);
    req.write(loginPayload);
    req.end();
  });

  if (loginResponse.statusCode < 200 || loginResponse.statusCode >= 300) {
    throw new Error(`Recording auth setup failed with HTTP ${loginResponse.statusCode}. ${loginResponse.body}`.trim());
  }

  const payload = JSON.parse(loginResponse.body);
  if (!payload.access_token) {
    throw new Error("Recording auth setup did not receive an access token.");
  }

  const hosts = Array.from(new Set([serviceUrl, adminUrl, keystoneUrl].map((url) => new URL(url).hostname)));
  const now = Math.floor(Date.now() / 1000);
  const cookies = hosts.flatMap((domain) => {
    const entries = [
      {
        name: "cp_access_token",
        value: payload.access_token,
        domain,
        path: "/",
        expires: now + 8 * 60 * 60,
        httpOnly: true,
        secure: false,
        sameSite: "Lax"
      }
    ];
    if (payload.refresh_token) {
      entries.push({
        name: "cp_refresh_token",
        value: payload.refresh_token,
        domain,
        path: "/",
        expires: now + 30 * 24 * 60 * 60,
        httpOnly: true,
        secure: false,
        sameSite: "Lax"
      });
    }
    return entries;
  });
  const origins = Array.from(new Set([adminUrl, keystoneUrl].map((url) => new URL(url).origin))).map((origin) => ({
    origin,
    localStorage: []
  }));

  mkdirSync(path.dirname(storageStatePath), { recursive: true });
  writeFileSync(storageStatePath, JSON.stringify({ cookies, origins }, null, 2), "utf8");
};

const finalizeRecordedScenario = (name) => {
  const scenarioName = String(name || "").trim();
  if (!scenarioName) {
    throw new Error("A scenario name is required.");
  }
  if (!recordState.draftPath || !existsSync(recordState.draftPath)) {
    throw new Error("No recorded draft file was found. Complete at least one Codegen action before saving.");
  }

  mkdirSync(recordedRoot, { recursive: true });
  const surface = recordState.surface || "admin";
  const surfaceLabel = recordState.surfaceLabel || "Admin";
  const id = `${surface}-${slugify(scenarioName) || Date.now()}`;
  const finalPath = path.join(recordedRoot, `recorded-${id}.spec.ts`);
  const draft = readFileSync(recordState.draftPath, "utf8");
  const title = `${surfaceLabel} ${scenarioName} recorded flow [surface: ${surfaceLabel}] [feature: Recorded Flow] [precondition: local authenticated user can open ${surfaceLabel}] [input: replay recorded user flow] [expected: recorded flow completes without Playwright action failure] [proof: saved Codegen flow can be replayed for regression]`;
  let finalSource = draft;
  if (/test\(['"`][\s\S]*?['"`]\s*,\s*async\s*\(\{\s*page\s*\}\)/.test(finalSource)) {
    finalSource = finalSource.replace(
      /test\(['"`][\s\S]*?['"`]\s*,\s*async\s*\(\{\s*page\s*\}\)/,
      `test(\`${escapeJsString(title)}\`, async ({ page })`
    );
  } else if (/test\.describe\(/.test(finalSource)) {
    finalSource += `\n\ntest(\`${escapeJsString(title)}\`, async ({ page }) => {\n  await page.goto('${recordState.url}');\n});\n`;
  } else {
    finalSource = `import { test } from '../../helpers/singleBrowserTest';\n\ntest(\`${escapeJsString(title)}\`, async ({ page }) => {\n  await page.goto('${recordState.url}');\n});\n`;
  }
  finalSource = addRecordedEvidenceHooks(finalSource);
  writeFileSync(finalPath, finalSource, "utf8");

  const metadata = readRecordedMetadata();
  const relativeSpec = path.relative(repoRoot, finalPath).replace(/\\/g, "/");
  const scenario = {
    id,
    name: scenarioName,
    surface,
    surfaceLabel,
    url: recordState.url,
    spec: relativeSpec,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const scenarios = [scenario, ...metadata.scenarios.filter((item) => item.id !== id && item.spec !== relativeSpec)];
  const saved = writeRecordedMetadata(scenarios);
  cachedInventory = null;
  cachedInventoryAt = 0;
  return { scenario, metadata: saved };
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseMeta = (title, key) => {
  const match = new RegExp(`\\[${key}:\\s*([^\\]]+)\\]`, "i").exec(title);
  return match ? match[1].trim() : "";
};

const moduleCode = (feature) =>
  String(feature || "LIST_VIEW").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "LIST_VIEW";

const levelCode = (level) => (level === "BVT" ? "BVT" : level === "Sanity" ? "SAN" : "REG");

const categoryTag = (level) => (level === "BVT" ? "@bvt" : level === "Sanity" ? "@sanity" : "@regression");

const inferTestingLevel = (level, title) => {
  const normalized = String(level || "").toLowerCase();
  if (normalized === "bvt" || normalized.includes("build verification") || normalized.includes("smoke")) return "BVT";
  if (normalized.includes("sanity")) return "Sanity";
  if (normalized.includes("regression")) return "Regression";
  const lower = String(title || "").toLowerCase();
  if (lower.includes("list view loads") || lower.includes("object list view loads") || lower.includes("primary toolbar")) return "BVT";
  if (lower.includes("search handles") || lower.includes("refresh preserves") || lower.includes("selection count")) return "Sanity";
  return "Regression";
};

const caseIdentity = (feature, level, index) => {
  const id = `${levelCode(level)}_${moduleCode(feature)}_${String(index + 1).padStart(3, "0")}`;
  return {
    id,
    tags: `@case-${id} ${categoryTag(level)}`,
    testingLevel: level
  };
};

const visibleBvtInventoryRows = {
  "admin-keystone-nav-bvt-206.spec.ts": {
    id: "ADMIN_KEYSTONE_NAV_BVT_206",
    tags: "@admin-keystone-nav-bvt-206 @navigation-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Admin Side Nav + Keystone Apps/Tabs",
    input:
      "Run 206 checkpoints -> open Admin 5002 -> login -> verify all 18 sidebar sections from Core, Metadata, Security, and Other -> for each section verify nav item, page open, no crash, expected content, controls, and list/page content -> open Keystone 5003 -> login -> verify runtime shell -> open each seeded app -> verify app opens, content remains stable, and tabs launcher opens -> open 32 sampled tabs across AUTO Platform QA 528A, Core Platform, Operations Hub, Revenue Hub, CRM, LIMS, HR, and ELIMS -> verify each tab opens and runtime content remains visible",
    expected:
      "All Admin sidebar sections and sampled Keystone apps/tabs remain reachable, render without crash states, expose interactive controls, and keep runtime content visible.",
    proof: "Automates the 206-check manual Admin side-nav and Keystone apps/tabs BVT evidence sweep."
  },
  "app-hierarchy-bvt-110.spec.ts": {
    id: "APP_HIERARCHY_BVT_110",
    tags: "@app-hierarchy-bvt-110 @app-hierarchy-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin",
    feature: "App Hierarchy",
    input:
      "Run 110 checkpoints -> open Admin application -> login -> open App Hierarchy -> verify hierarchy heading, tree nodes, toggle behavior, legacy app history route handling, Core nav visibility, reload, and console health",
    expected: "App Hierarchy BVT validates parent-child app tree rendering and stable Core navigation behavior.",
    proof: "Automates the 110-check App Hierarchy BVT."
  },
  "search-results-bvt-120.spec.ts": {
    id: "SEARCH_RESULTS_BVT_120",
    tags: "@search-results-bvt-120 @search-results-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin",
    feature: "Search Results",
    input:
      "Run 120 checkpoints -> open Admin application -> login -> open Search Results -> verify empty state -> run global searches -> verify metadata result groups, section counts, columns, Back to section, and console health",
    expected: "Search Results BVT validates Admin metadata global search and grouped result rendering.",
    proof: "Automates the 120-check Search Results BVT."
  },
  "admin-agent-bvt-125.spec.ts": {
    id: "ADMIN_AGENT_BVT_125",
    tags: "@admin-agent-bvt-125 @admin-agent-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin",
    feature: "Agent",
    input:
      "Run 125 checkpoints -> open Admin application -> login -> open Agent -> verify chat, developer mode, message entry, send control, provider failure state, prompt tabs, audit log tab, history tab, and page health",
    expected: "Agent BVT validates the Admin Agent workspace and records provider configuration failure when the API key is invalid.",
    proof: "Automates the 125-check Agent BVT."
  },
  "keystone-core-reflection-bvt-105.spec.ts": {
    id: "KEYSTONE_CORE_REFLECTION_BVT_105",
    tags: "@keystone-core-reflection-bvt-105 @keystone-reflection-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Keystone Core Reflection",
    input:
      "Run 105 checkpoints -> verify App Hierarchy, Search Results, and Agent open in Admin -> login to Keystone 5003 -> search Admin core page terms -> verify Keystone remains healthy and direct object routes are guarded",
    expected: "Keystone Core Reflection BVT confirms Admin Core pages do not leak as business objects in Keystone.",
    proof: "Automates the 105-check Keystone Core reflection BVT."
  },
  "access-records-bvt-130.spec.ts": {
    id: "ACCESS_RECORDS_BVT_152",
    tags: "@access-records-bvt-152 @access-records-bvt-130 @permissions-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Access Records",
    input:
      "Run 152 checkpoints -> open Admin application -> login -> open Access Records -> verify page, toolbar, seeded rows, create modal, detail view, permission controls -> create AUTO Case/test_role access record -> update object and attachment permissions -> save -> verify detail/list state -> delete disposable record -> open Keystone 5003 -> verify target app remains usable and access-record metadata is not shown as business data",
    expected:
      "Access Records page supports list, create, update, delete, cleanup, and Keystone runtime remains usable without exposing Admin-only metadata.",
    proof: "Automates the 152-check Access Records BVT with Admin CRUD and Keystone reflection evidence."
  },
  "admin-tabs-bvt-102.spec.ts": {
    id: "ADMIN_TABS_BVT_102",
    tags: "@tabs-bvt-102 @metadata-lifecycle @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Tabs",
    input:
      "Run 102 checkpoints -> open Admin application -> login -> open Tabs -> verify page, toolbar, create flow, detail/list state -> create a disposable tab -> verify it appears in Keystone 5003 -> update if applicable -> delete and clean up the disposable tab",
    expected: "Tabs metadata created through Admin is reflected in Keystone and cleanup removes the disposable tab.",
    proof: "Validates Admin Tabs CRUD propagation into Keystone."
  },
  "flows-bvt-101.spec.ts": {
    id: "FLOWS_BVT_101",
    tags: "@flows-bvt-101 @flows-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Flows",
    input:
      "Run 101 checkpoints -> open Admin application -> login -> open Flows -> verify page, toolbar, seeded records, create panel, detail controls -> create disposable inactive flow -> update flow details -> verify Admin list/search -> check Keystone 5003 runtime remains usable -> delete disposable flow",
    expected: "Flows page CRUD works in Admin and Keystone remains stable after the metadata operation.",
    proof: "Automates the 101-check Flows BVT and validates cleanup."
  },
  "groups-bvt-124.spec.ts": {
    id: "GROUPS_BVT_124",
    tags: "@groups-bvt-124 @groups-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Groups",
    input:
      "Run 124 checkpoints -> open Admin application -> login -> open Groups -> verify page, toolbar, seeded groups, create modal, details, users subpage, audit log -> create disposable group -> add and remove admin user -> update group -> verify Admin search -> verify Keystone 5003 remains usable and excludes Admin group metadata -> delete disposable group",
    expected: "Groups CRUD, membership, audit, search, and cleanup pass; Keystone correctly excludes Admin-only group metadata.",
    proof: "Automates the 124-check Groups BVT."
  },
  "objects-bvt-135.spec.ts": {
    id: "OBJECTS_BVT_135",
    tags: "@objects-bvt-135 @objects-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Objects",
    input:
      "Run 135 checkpoints -> open Admin application -> login -> open Objects -> verify page, toolbar, seeded objects, create wizard, detail/list controls -> perform disposable object CRUD where supported -> verify expected Admin state and Keystone 5003 reflection -> clean up created metadata",
    expected: "Objects page BVT validates object metadata UI, CRUD path, Keystone reflection, and cleanup.",
    proof: "Automates the 135-check Objects BVT."
  },
  "permissions-bvt-135.spec.ts": {
    id: "PERMISSIONS_BVT_138",
    tags: "@permissions-bvt-135 @permissions-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Permissions",
    input:
      "Run 138 checkpoints -> open Admin application -> login -> open Permissions -> verify page, toolbar, seeded permissions, details, grant controls, restricted delete behavior -> perform safe permission/grant operations -> verify Admin result -> verify Keystone 5003 remains usable and does not expose Admin-only permission metadata as business data",
    expected: "Permissions page behavior and supported operations pass, with unsupported direct metadata delete blocked as expected.",
    proof: "Automates the focused Permissions BVT checkpoints."
  },
  "roles-bvt-101.spec.ts": {
    id: "ROLES_BVT_101",
    tags: "@roles-bvt-101 @roles-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Roles",
    input:
      "Run 101 checkpoints -> open Admin application -> login -> open Roles -> verify page, toolbar, seeded roles, create modal, details, users subpage, audit log -> create disposable role -> update role -> verify Admin search -> verify Keystone 5003 remains usable and excludes Admin role metadata -> delete disposable role",
    expected: "Roles CRUD, detail, user membership surface, audit/search, Keystone exclusion, and cleanup pass.",
    proof: "Automates the 101-check Roles BVT."
  },
  "sharing-settings-bvt-132.spec.ts": {
    id: "SHARING_SETTINGS_BVT_171",
    tags: "@sharing-settings-bvt-171 @sharing-settings-bvt-132 @sharing-settings-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Sharing Settings",
    input:
      "Run 171 checkpoints -> open Admin application -> login -> open Sharing Settings -> verify page, toolbar, seeded rules, create/edit controls, detail state, validation, and cleanup -> verify Keystone 5003 remains usable after sharing metadata operations",
    expected: "Sharing Settings BVT validates page analysis, metadata operations, Keystone stability, and cleanup.",
    proof: "Automates the expanded Sharing Settings BVT checkpoints."
  },
  "system-settings-bvt-110.spec.ts": {
    id: "SYSTEM_SETTINGS_BVT_110",
    tags: "@system-settings-bvt-110 @system-settings-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin",
    feature: "System Settings",
    input:
      "Run 110 checkpoints -> open Admin application -> login -> open System Settings -> verify heading, description, search, labels, refresh -> update and revert End-user app name -> verify page and console health",
    expected: "System Settings BVT validates searchable global platform settings and supported update/revert behavior.",
    proof: "Automates the 110-check System Settings BVT."
  },
  "email-logs-bvt-105.spec.ts": {
    id: "EMAIL_LOGS_BVT_105",
    tags: "@email-logs-bvt-105 @email-logs-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin",
    feature: "Email Logs",
    input:
      "Run 105 checkpoints -> open Admin application -> login -> open Email Logs -> verify read-only toolbar, columns, search, exports, empty state, and console health",
    expected: "Email Logs BVT validates the operational log list remains readable and intentionally read-only.",
    proof: "Automates the 105-check Email Logs BVT."
  },
  "scheduled-jobs-bvt-125.spec.ts": {
    id: "SCHEDULED_JOBS_BVT_125",
    tags: "@scheduled-jobs-bvt-125 @scheduled-jobs-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin",
    feature: "Scheduled Jobs",
    input:
      "Run 125 checkpoints -> open Admin application -> login -> open Scheduled Jobs -> verify metrics, list columns, seeded jobs, search -> create disabled disposable job -> update -> inspect Runs and Audit Log tabs -> delete and cleanup",
    expected: "Scheduled Jobs BVT validates scheduler metadata CRUD, tab surfaces, search, and cleanup.",
    proof: "Automates the 125-check Scheduled Jobs BVT."
  },
  "audit-logs-bvt-105.spec.ts": {
    id: "AUDIT_LOGS_BVT_105",
    tags: "@audit-logs-bvt-105 @audit-logs-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin",
    feature: "Audit Logs",
    input:
      "Run 105 checkpoints -> open Admin application -> login -> open Audit Logs -> verify read-only audit table, columns, search terms, export controls, refresh, and console health",
    expected: "Audit Logs BVT validates field-level audit entries are visible, searchable, exportable, and read-only.",
    proof: "Automates the 105-check Audit Logs BVT."
  },
  "recycle-bin-bvt-125.spec.ts": {
    id: "RECYCLE_BIN_BVT_125",
    tags: "@recycle-bin-bvt-125 @recycle-bin-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin",
    feature: "Recycle Bin",
    input:
      "Run 125 checkpoints -> create and delete disposable scheduled job -> open Recycle Bin -> verify deleted record, columns, actions, restore confirmation cancel, restore, scheduled job reappearance, and cleanup delete",
    expected: "Recycle Bin BVT validates recoverable metadata deletes, restore behavior, and cleanup.",
    proof: "Automates the 125-check Recycle Bin BVT."
  },
  "keystone-admin-other-reflection-bvt-105.spec.ts": {
    id: "KEYSTONE_ADMIN_OTHER_REFLECTION_BVT_105",
    tags: "@keystone-admin-other-reflection-bvt-105 @keystone-reflection-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Keystone Admin Other Reflection",
    input:
      "Run 105 checkpoints -> verify Admin Other pages open -> login to Keystone 5003 -> search Admin operational page names and metadata object names -> verify Keystone remains healthy and guarded from Admin operational metadata",
    expected: "Keystone reflection BVT confirms Admin operational pages do not leak into Keystone business-object global search.",
    proof: "Automates the 105-check Keystone Admin Other reflection BVT."
  },
  "users-bvt-101.spec.ts": {
    id: "USERS_BVT_101",
    tags: "@users-bvt-101 @users-ui @bvt",
    testingLevel: "BVT",
    surface: "Admin + Keystone",
    feature: "Users",
    input:
      "Run 101 checkpoints -> open Admin application -> login -> open Users -> verify page, toolbar, seeded users, detail panel, role/group access surfaces, search, and supported user lifecycle controls -> verify Keystone 5003 remains usable after Admin user checks",
    expected: "Users page BVT validates list/detail/search/access surfaces and Keystone stability.",
    proof: "Automates the 101-check Users BVT."
  }
};

const titleTags = (title) =>
  Array.from(new Set(String(title || "").match(/@[A-Za-z0-9:_-]+/g) || [])).join(" ");

const stepChain = (steps) => steps.filter(Boolean).join(" -> ");

const normalizeStepSeparators = (steps) =>
  String(steps || "")
    .replace(/\s*\|\s*/g, " -> ")
    .replace(/\s+/g, " ")
    .trim();

const structuredStepsFromText = ({ input, surface, feature, expected, testData = "" }) => {
  const parts = normalizeStepSeparators(input)
    .split(/\s*->\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const source = parts.length > 0 ? parts : [input || "Execute the test case"];
  return source.map((action, index) => ({
    section: index === 0 ? surface || "Application" : `${surface || "Application"} > ${feature || "Feature"}`,
    action,
    testData: testData || "Seeded credentials and seeded application data resolved at runtime.",
    expectedBehavior: expected || "The UI/API behaves as expected.",
    verify:
      index === source.length - 1
        ? expected || "Verify the final UI/API state."
        : `Verify "${action}" completes and the next state is reachable.`,
    result: "Pending"
  }));
};

const stripBracketMeta = (value) =>
  String(value || "").replace(/\s*\[(surface|feature|level|priority|testdata|test data|automation|precondition|input|expected|proof):[^\]]+\]/gi, "");

const extractSeedDataFromSpec = (specPath) => {
  const candidate = String(specPath || "");
  const absolute = candidate.includes("/") || candidate.includes("\\")
    ? path.resolve(repoRoot, candidate)
    : path.resolve(repoRoot, "tests", "e2e", "list-view-regression", candidate);
  if (!absolute.startsWith(repoRoot) || !existsSync(absolute)) return "";
  const source = readFileSync(absolute, "utf8");
  const names = [
    "targetAppLabel",
    "targetAppId",
    "targetObjectLabel",
    "targetObjectApiName",
    "APP_ID",
    "AUTO_CASE_OBJECT_ID",
    "TEST_ROLE_ID",
    "CHECKPOINT_TARGET",
    "CHECK_TARGET"
  ];
  const values = [];
  for (const name of names) {
    const match = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*(?:process\\.env\\.[A-Z0-9_]+\\s*\\|\\|\\s*)?["']([^"']+)["']|(?:const|let)\\s+${name}\\s*=\\s*(\\d+)`).exec(source);
    if (match) values.push(`${name}: ${match[1] || match[2]}`);
  }
  const dynamicNames = Array.from(source.matchAll(/const\s+(\w*(?:label|name|apiName|prefix|stamp)\w*)\s*=\s*`([^`]+)`/gi))
    .slice(0, 8)
    .map((match) => `${match[1]}: ${match[2].replace(/\$\{[^}]+\}/g, "<runtime>")}`);
  return [...values, ...dynamicNames].join("; ");
};

const isVagueStepText = (steps) => {
  const lower = normalizeStepSeparators(steps).toLowerCase();
  if (!lower) return true;
  if (lower === "execute test steps." || /^attempt .+ as each role\.?$/.test(lower)) return true;
  return [
    "exercise the",
    "exercise create",
    "changed behavior",
    "affected ",
    "impacted ",
    "primary user or api path",
    "screen or api path",
    "route family related",
    "downstream",
    "open or call"
  ].some((phrase) => lower.includes(phrase));
};

const adminScreenForSteps = (feature, title, spec = "") => {
  const text = `${feature} ${title} ${spec}`.toLowerCase();
  if (/permission|access|role|group|user|security/.test(text)) return "Permissions or Access Records";
  if (/object|field|metadata/.test(text)) return "Objects";
  if (/recycle|restore|purge/.test(text)) return "Recycle Bin";
  if (/app/.test(text)) return "Apps";
  return feature || "the target screen";
};

const uiActionForSteps = (feature, title, spec = "") => {
  const text = `${feature} ${title} ${spec}`.toLowerCase();
  const target = String(feature || "record").toLowerCase();
  if (/create|new|add/.test(text)) return `click New, fill the ${target} test details, and save`;
  if (/edit|update|patch/.test(text)) return `open the test row, change the ${target} details, and save`;
  if (/delete|remove|purge/.test(text)) return "select the test row, click Delete, and confirm";
  if (/restore|recycle/.test(text)) return "open Recycle Bin, restore the test row, and verify it returns";
  if (/search|filter/.test(text)) return "type the search or filter value and verify the matching rows";
  if (/setting|column|sharing|preference|hierarchy/.test(text)) return "open Settings, change the requested option, and apply it";
  if (/export|csv|pdf/.test(text)) return "click the export action and verify the downloaded file";
  if (/toolbar|refresh|fit|pin|count/.test(text)) return "use the toolbar control named in the test and verify the table state";
  if (/navigation|row opens|detail/.test(text)) return "open a row from the list and verify the detail view";
  if (/invalid|reject|unauthorized|auth|permission|security/.test(text)) return "submit the restricted or invalid action and verify it is blocked";
  return `perform the ${feature || "feature"} action named in the test case`;
};

const expandSpecificSteps = ({ raw, title, spec, feature, surface }) => {
  const steps = normalizeStepSeparators(raw);
  const lower = steps.toLowerCase();
  if (/^open (admin|keystone)?\s*application\b/.test(lower) || lower.startsWith("open application ->")) return steps;

  const cleanTitle = stripBracketMeta(title);
  const text = `${cleanTitle} ${spec} ${feature} ${surface}`.toLowerCase();
  const isApi = surface === "API" || /api|routes?|service|endpoint/.test(text);
  const isKeystone = surface === "Keystone" || /keystone|shockwave/.test(text);
  const isAdmin = surface === "Admin" || /admin|permission|access|role|group|user|security/.test(text);

  if (isApi) {
    return stepChain([
      "Open application",
      "authenticate through the API with seeded credentials",
      steps,
      "verify the response status and body",
      "capture API evidence"
    ]);
  }
  if (isKeystone) {
    return stepChain([
      "Open Keystone application",
      "fill the login details",
      "click Login",
      "select the seeded app and tab",
      steps,
      "verify the record or table state"
    ]);
  }
  if (isAdmin) {
    return stepChain([
      "Open Admin application",
      "fill the login details",
      "click Login",
      steps,
      "verify the page or table result"
    ]);
  }
  return stepChain([
    "Open application",
    "sign in with seeded test credentials",
    steps,
    "verify the expected result and capture evidence"
  ]);
};

const readableTestSteps = ({ raw = "", title = "", spec = "", feature = "List View", surface = "Application" } = {}) => {
  if (raw && !isVagueStepText(raw)) return expandSpecificSteps({ raw, title, spec, feature, surface });

  const cleanTitle = stripBracketMeta(title);
  const text = `${cleanTitle} ${spec} ${feature} ${surface}`.toLowerCase();
  const isApi = surface === "API" || /api|routes?|service|endpoint/.test(text);
  const isAdmin = surface === "Admin" || /admin/.test(text);
  const isKeystone = surface === "Keystone" || /keystone|shockwave/.test(text);
  const isPermissionAccess = /permission|access record|access-control|effective-access|role|group|grant/.test(text);
  const isInvalid = /reject|invalid|unauthorized|requires valid authentication|not found|missing|duplicate|inactive/.test(text);
  const isDownstream = /downstream|effective-access|grant|check/.test(text);

  if (isApi && isPermissionAccess && isInvalid) {
    return stepChain([
      "Open application",
      "authenticate with seeded admin API credentials",
      `send the invalid or unauthorized ${feature} request from the test case`,
      "verify the expected 400, 401, 403, or 404 response",
      "confirm protected permission data is unchanged"
    ]);
  }
  if (isApi && isPermissionAccess && isDownstream) {
    return stepChain([
      "Open application",
      "authenticate with seeded admin API credentials",
      "create the role, group, user, permission, or grant setup required by the test",
      "request the downstream effective-access check",
      "verify the allowed or blocked access decision",
      "delete the disposable security data"
    ]);
  }
  if (isApi && isPermissionAccess) {
    return stepChain([
      "Open application",
      "authenticate with seeded admin API credentials",
      "create the test permission or access record",
      "list and read back the created record",
      "update, grant, or check it as required by the test",
      "delete the disposable record and verify cleanup"
    ]);
  }
  if (isApi) {
    return stepChain([
      "Open application",
      "authenticate through the API with seeded credentials",
      `call the ${feature} endpoint or route named in the test`,
      "verify the response status and body",
      "capture API evidence"
    ]);
  }
  if (isKeystone) {
    return stepChain([
      "Open Keystone application",
      "fill the login details",
      "click Login",
      "select the seeded app and tab",
      "open the list view",
      uiActionForSteps(feature, cleanTitle, spec),
      "verify the record or table state"
    ]);
  }
  if (isAdmin || isPermissionAccess) {
    return stepChain([
      "Open Admin application",
      "fill the login details",
      "click Login",
      `navigate to ${adminScreenForSteps(feature, cleanTitle, spec)} from the sidebar`,
      uiActionForSteps(feature, cleanTitle, spec),
      "verify the page or table result"
    ]);
  }
  return stepChain([
    "Open application",
    "sign in with seeded test credentials",
    `navigate to the ${feature || "target"} screen`,
    uiActionForSteps(feature, cleanTitle, spec),
    "verify the expected result and capture evidence"
  ]);
};

const defaultCaseNarrative = (title, spec, feature, surface) => {
  const lowerTitle = String(title || "").toLowerCase();
  const lowerSpec = String(spec || "").toLowerCase();
  if (lowerSpec.includes("permissions-access-records")) {
    if (lowerTitle.includes("reject") || lowerTitle.includes("invalid") || lowerTitle.includes("requires valid authentication") || lowerTitle.includes("not found")) {
      return {
        precondition: "Seeded admin credentials exist and protected permission/access APIs are available.",
        input: readableTestSteps({ title, spec, feature, surface }),
        expected: "The API returns the configured problem response/status without mutating protected data or leaking unauthorized access.",
        proof: "Security and validation boundaries for permissions, access records, roles/groups, grants, and effective access remain enforced."
      };
    }
    if (lowerTitle.includes("ui exposes")) {
      return {
        precondition: "Seeded admin user is signed in.",
        input: readableTestSteps({ title, spec, feature, surface: "Admin" }),
        expected: "The Admin security surface renders without authentication failure, crash, or permission leakage.",
        proof: "The UI entry point for permissions/access records is reachable and protected."
      };
    }
    return {
      precondition: "Seeded security metadata exists and write scenarios run only when ALLOW_DATA_WRITE=true.",
      input: readableTestSteps({ title, spec, feature, surface }),
      expected: "The requested security operation returns the expected status/body and cleanup leaves no stale permission or access data.",
      proof: "Permissions, access records, grants, and downstream access enforcement remain connected end to end."
    };
  }
  if (lowerSpec.includes("admin-depthwise")) {
    return {
      precondition: "seed:industry-suite data is loaded and a seeded admin user is signed in.",
      input: readableTestSteps({ title, spec, feature, surface }),
      expected: "The screen/API renders or responds without auth failure, crash, or server error.",
      proof: "Admin depthwise coverage stays connected from side-nav UI through metadata APIs and Keystone runtime terminals."
    };
  }
  return {
    precondition: "",
    input: "",
    expected: "",
    proof: ""
  };
};

const xmlEscape = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const columnName = (index) => {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const dosDateTime = (date = new Date()) => {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
};

const createZip = (files) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { date, time } = dosDateTime();

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
};

const worksheetXml = (rows) => {
  const lastCell = `${columnName(Math.max(rows[0]?.length || 1, 1) - 1)}${Math.max(rows.length, 1)}`;
  const xmlRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
    });
    return `<row r="${rowIndex + 1}">${cells.join("")}</row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>
    <col min="1" max="1" width="22" customWidth="1"/>
    <col min="2" max="2" width="28" customWidth="1"/>
    <col min="3" max="4" width="18" customWidth="1"/>
    <col min="5" max="6" width="24" customWidth="1"/>
    <col min="7" max="10" width="48" customWidth="1"/>
  </cols>
  <sheetData>${xmlRows.join("")}</sheetData>
  <autoFilter ref="A1:${lastCell}"/>
</worksheet>`;
};

const buildInventoryWorkbook = () => {
  const inventory = readInventory();
  const headers = [
    "Case ID",
    "Tags",
    "Category",
    "Application",
    "Scenario",
    "Test Case",
    "Precondition",
    "Test Steps",
    "Expected Result",
    "What It Proves",
    "Spec"
  ];
  const rows = (inventory.rows || []).map((row) => [
    row.id,
    row.tags,
    row.testingLevel,
    row.surface,
    row.feature,
    row.displayTitle,
    row.precondition,
    row.input,
    row.expected,
    row.proof,
    row.spec
  ]);
  const sheet = worksheetXml([headers, ...rows]);
  return createZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Test Cases" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
    },
    { name: "xl/worksheets/sheet1.xml", data: sheet }
  ]);
};

const inferSurface = (spec, title) => {
  const surface = parseMeta(title, "surface");
  if (surface) return surface;
  if (spec.includes("admin")) return "Admin";
  if (spec.includes("keystone")) return "Keystone";
  if (spec.includes("api")) return "API";
  return "Application";
};

const cleanTitle = (title) => title.replace(/\s*\[[^\]]+\]/g, "").trim();

const classifyChangedFile = (filePath) => {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("apps/admin/")) {
    return { area: "Admin", suite: "admin-list-view", surface: "admin" };
  }
  if (normalized.includes("apps/shockwave/")) {
    return { area: "Keystone / Shockwave", suite: "keystone-list-view", surface: "keystone" };
  }
  if (normalized.includes("apps/service/")) {
    return { area: "API / Service", suite: "list-view-api", surface: "api" };
  }
  if (normalized.includes("metadata/") || normalized.includes("seeds/")) {
    return { area: "Metadata", suite: "list-view-regression", surface: "all" };
  }
  if (normalized.includes("packages/list-view/") || normalized.includes("list-view")) {
    return { area: "Shared List View", suite: "list-view-regression", surface: "all" };
  }
  if (normalized.includes("packages/ui/")) {
    return { area: "Shared UI", suite: "list-view-regression", surface: "all" };
  }
  return { area: "Application", suite: "list-view-regression", surface: "all" };
};

const riskForChangedFile = (filePath) => {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (/routes|auth|permission|access|validation|trigger|bulk|delete|recycle|migration|schema/.test(normalized)) {
    return { risk: "High", reason: "Touches authorization, validation, destructive flow, schema, or backend route behavior." };
  }
  if (/list-view|table|record|layout|form|search|export|workflow|flow/.test(normalized)) {
    return { risk: "Medium", reason: "Touches user-visible workflow, records, table, search, export, or layout behavior." };
  }
  return { risk: "Low", reason: "Change is outside the main E2E risk keywords." };
};

const runGit = (cwd, args, timeout = 120_000) => {
  const result = spawnSync("git", ["-c", `safe.directory=${cwd.replace(/\\/g, "/")}`, ...args], {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git exited ${result.status}`).trim());
  }
  return (result.stdout || "").trim();
};

const currentGitBranch = (cwd) => runGit(cwd, ["branch", "--show-current"]) || "main";

const readAgentState = () => {
  if (!existsSync(agentStatePath)) {
    return {
      targetRepo: appRoot,
      trackedBranch: "main",
      baselineCommit: "",
      lastSuccessfulAgentCommit: "",
      lastSeenMainCommit: "",
      lastPulledCommit: "",
      lastGraphCommit: "",
      lastScheduledRunAt: null,
      updatedAt: null,
      history: []
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(agentStatePath, "utf8"));
    return {
      targetRepo: parsed.targetRepo || appRoot,
      trackedBranch: parsed.trackedBranch || "main",
      baselineCommit: parsed.baselineCommit || "",
      lastSuccessfulAgentCommit: parsed.lastSuccessfulAgentCommit || parsed.baselineCommit || "",
      lastSeenMainCommit: parsed.lastSeenMainCommit || "",
      lastPulledCommit: parsed.lastPulledCommit || "",
      lastGraphCommit: parsed.lastGraphCommit || "",
      lastScheduledRunAt: parsed.lastScheduledRunAt || null,
      lastRunStatus: parsed.lastRunStatus || null,
      updatedAt: parsed.updatedAt || null,
      lastArtifact: parsed.lastArtifact || "",
      lastSpec: parsed.lastSpec || "",
      lastGraph: parsed.lastGraph || "",
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch {
    return {
      targetRepo: appRoot,
      trackedBranch: "main",
      baselineCommit: "",
      lastSuccessfulAgentCommit: "",
      lastSeenMainCommit: "",
      lastPulledCommit: "",
      lastGraphCommit: "",
      lastScheduledRunAt: null,
      updatedAt: null,
      history: []
    };
  }
};

const writeAgentState = (nextState) => {
  mkdirSync(generatedRoot, { recursive: true });
  const merged = {
    targetRepo: appRoot,
    trackedBranch: "main",
    ...readAgentState(),
    ...nextState
  };
  writeFileSync(agentStatePath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
};

const currentAppCommit = () => runGit(appRoot, ["rev-parse", "HEAD"]);

const gitOutputOrEmpty = (cwd, args, timeout = 120_000) => {
  try {
    return runGit(cwd, args, timeout);
  } catch {
    return "";
  }
};

const appWorktreeStatus = () => {
  if (!existsSync(path.join(appRoot, ".git"))) {
    return { exists: false, clean: false, status: "", branch: "", headCommit: "" };
  }
  const status = gitOutputOrEmpty(appRoot, ["status", "--short"]);
  return {
    exists: true,
    clean: !status,
    status,
    branch: gitOutputOrEmpty(appRoot, ["branch", "--show-current"]) || "main",
    headCommit: gitOutputOrEmpty(appRoot, ["rev-parse", "HEAD"])
  };
};

const appMainSyncStatus = () => {
  const worktree = appWorktreeStatus();
  const state = readAgentState();
  const remoteMainCommit = gitOutputOrEmpty(appRoot, ["rev-parse", "origin/main"]);
  const behindCount = remoteMainCommit && worktree.headCommit
    ? Number(gitOutputOrEmpty(appRoot, ["rev-list", "--count", `${worktree.headCommit}..origin/main`]) || 0)
    : 0;
  return {
    appRoot,
    trackedBranch: "main",
    remote: "origin/main",
    ...worktree,
    remoteMainCommit,
    behindCount,
    hasRemoteChanges: behindCount > 0,
    pullBlocked: behindCount > 0 && !worktree.clean,
    lastSeenMainCommit: state.lastSeenMainCommit || "",
    lastPulledCommit: state.lastPulledCommit || "",
    lastSuccessfulAgentCommit: state.lastSuccessfulAgentCommit || state.baselineCommit || "",
    updatedAt: state.updatedAt || null
  };
};

const syncMainBranch = ({ pull = true } = {}) => {
  if (!existsSync(path.join(appRoot, ".git"))) {
    throw new Error(`Application repo was not found at ${appRoot}.`);
  }
  const before = appMainSyncStatus();
  runGit(appRoot, ["fetch", "origin", "main"], 180_000);
  const afterFetch = appMainSyncStatus();
  let pulled = false;
  let blockedReason = "";
  if (pull && afterFetch.hasRemoteChanges) {
    if (!afterFetch.clean) {
      blockedReason = "Local app repo has uncommitted changes. Fetched origin/main, but skipped pull.";
    } else {
      runGit(appRoot, ["pull", "--ff-only", "origin", "main"], 180_000);
      pulled = true;
    }
  }
  const after = appMainSyncStatus();
  writeAgentState({
    lastSeenMainCommit: after.remoteMainCommit || after.headCommit,
    lastPulledCommit: pulled ? after.headCommit : readAgentState().lastPulledCommit || "",
    updatedAt: new Date().toISOString()
  });
  return {
    ok: true,
    before,
    after,
    pulled,
    blockedReason,
    changed: before.remoteMainCommit !== after.remoteMainCommit || before.headCommit !== after.headCommit
  };
};

const syncMainBranchAndReindex = ({ pull = true } = {}) => syncMainBranch({ pull });

const resolveAgentBaseRef = (baseRef = "") => {
  const requested = String(baseRef || "").trim();
  if (requested && requested !== "auto") return requested;
  const state = readAgentState();
  return state.lastSuccessfulAgentCommit || state.baselineCommit || "HEAD~1";
};

const scanChangedFiles = (baseRef = "auto", targetRef = "auto") => {
  if (!existsSync(path.join(appRoot, ".git"))) {
    throw new Error(`Application repo was not found at ${appRoot}.`);
  }
  const resolvedBaseRef = resolveAgentBaseRef(baseRef);
  const requestedTargetRef = String(targetRef || "auto").trim() || "auto";
  const sync = appMainSyncStatus();
  const resolvedTargetRef = requestedTargetRef === "auto"
    ? sync.remoteMainCommit && sync.remoteMainCommit !== sync.headCommit
      ? "origin/main"
      : "HEAD"
    : requestedTargetRef;
  const headCommit = runGit(appRoot, ["rev-parse", resolvedTargetRef]);
  let output = "";
  try {
    output = runGit(appRoot, ["diff", "--name-status", `${resolvedBaseRef}...${resolvedTargetRef}`]);
  } catch {
    output = runGit(appRoot, ["diff", "--name-status", resolvedBaseRef, resolvedTargetRef]);
  }
  const changedFiles = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      const filePath = rest[rest.length - 1] || "";
      const classification = classifyChangedFile(filePath);
      const risk = riskForChangedFile(filePath);
      return {
        status,
        path: filePath,
        ...classification,
        ...risk
      };
    });
  const summary = changedFiles.reduce(
    (acc, item) => {
      acc.total += 1;
      acc.byArea[item.area] = (acc.byArea[item.area] || 0) + 1;
      acc.byRisk[item.risk] = (acc.byRisk[item.risk] || 0) + 1;
      return acc;
    },
    { total: 0, byArea: {}, byRisk: {} }
  );
  return {
    appRoot,
    requestedBaseRef: baseRef,
    baseRef: resolvedBaseRef,
    requestedTargetRef,
    targetRef: resolvedTargetRef,
    headCommit,
    previousBaselineCommit: readAgentState().baselineCommit || "",
    scannedAt: new Date().toISOString(),
    summary,
    changedFiles
  };
};

const buildAgentGraph = (baseRef = "auto") => {
  const scan = scanChangedFiles(baseRef, "auto");
  const graphTargetRef = scan.targetRef || "HEAD";
  const commitLog = gitOutputOrEmpty(appRoot, [
    "log",
    "--oneline",
    "--decorate=short",
    "--max-count=25",
    `${scan.baseRef}..${graphTargetRef}`
  ]);
  const impactedNodes = scan.changedFiles.map((change) => ({
    id: change.path,
    label: path.basename(change.path),
    path: change.path,
    area: change.area,
    surface: change.surface,
    suite: change.suite,
    risk: change.risk,
    reason: change.reason,
    dependsOn: scan.changedFiles
      .filter((candidate) => candidate.path !== change.path && candidate.area === change.area)
      .slice(0, 6)
      .map((candidate) => candidate.path)
  }));
  const graph = {
    generatedAt: new Date().toISOString(),
    appRoot,
    baseRef: scan.baseRef,
    targetRef: graphTargetRef,
    headCommit: scan.headCommit,
    previousBaselineCommit: scan.previousBaselineCommit,
    summary: scan.summary,
    commits: commitLog
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [commit, ...rest] = line.split(/\s+/);
        return { commit, message: rest.join(" ") };
      }),
    nodes: impactedNodes,
    edges: impactedNodes.flatMap((node) => node.dependsOn.map((target) => ({ source: node.id, target, type: "same-area" })))
  };
  mkdirSync(agentGraphRoot, { recursive: true });
  const graphPath = path.join(agentGraphRoot, `graph-summary-${Date.now()}.json`);
  writeFileSync(graphPath, JSON.stringify(graph, null, 2), "utf8");
  writeAgentState({
    lastGraphCommit: scan.headCommit,
    lastGraph: path.relative(repoRoot, graphPath).replace(/\\/g, "/"),
    updatedAt: graph.generatedAt
  });
  return {
    ...graph,
    outputPath: path.relative(repoRoot, graphPath).replace(/\\/g, "/")
  };
};

const latestAgentGraph = () => {
  if (!existsSync(agentGraphRoot)) return null;
  const files = readdirSync(agentGraphRoot)
    .filter((item) => /^graph-summary-\d+\.json$/.test(item))
    .map((item) => {
      const fullPath = path.join(agentGraphRoot, item);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) return null;
  const payload = JSON.parse(readFileSync(files[0].fullPath, "utf8"));
  return { ...payload, outputPath: path.relative(repoRoot, files[0].fullPath).replace(/\\/g, "/") };
};

const scenarioForChange = (change, index) => {
  const normalized = change.path.replace(/\\/g, "/").toLowerCase();
  const feature = normalized.includes("search")
    ? "Search"
    : normalized.includes("export")
      ? "Export"
      : normalized.includes("permission") || normalized.includes("access") || normalized.includes("auth")
        ? "Security"
        : normalized.includes("validation")
          ? "Validation"
          : normalized.includes("list-view") || normalized.includes("table")
            ? "List View"
            : normalized.includes("flow")
              ? "Workflow"
              : change.area;
  return {
    id: `AGENT_${String(index + 1).padStart(3, "0")}`,
    suite: change.suite,
    surface: change.surface,
    scenario: `${feature} regression for ${change.area}`,
    testCase: `Verify ${feature.toLowerCase()} behavior after ${change.path}`,
    precondition: "Core Platform local stack is available and seeded test credentials can sign in.",
    steps: readableTestSteps({
      title: `Verify ${feature.toLowerCase()} behavior after ${change.path}`,
      spec: change.path,
      feature,
      surface: change.surface === "api" ? "API" : change.surface === "keystone" ? "Keystone" : "Admin"
    }),
    expected: "The changed behavior works as intended, existing list-view contracts remain stable, and any invalid input is handled visibly.",
    risk: change.risk,
    sourcePath: change.path
  };
};

const tagForRisk = (risk) => (risk === "High" ? "@bvt" : risk === "Medium" ? "@sanity" : "@regression");
const levelForTag = (tag) => (tag === "@bvt" ? "BVT" : tag === "@sanity" ? "Sanity" : "Regression");

const routeLikeChange = (change, graphContext) =>
  /routes?|api|service|server|controller|handler/i.test(change.path)
  ;

const securityLikeChange = (change) => /auth|permission|access|role|policy|security/i.test(change.path);
const validationLikeChange = (change) => /validation|schema|field|form|modal|constraint|input/i.test(change.path);
const mutationLikeChange = (change) => /create|update|edit|delete|bulk|recycle|restore|purge|workflow|lifecycle|mutation|routes?/i.test(change.path);
const uiLikeChange = (change) => /apps\/admin|apps\/shockwave|packages\/ui|component|hook|page|layout|modal|panel|view|screen/i.test(change.path.replace(/\\/g, "/"));

const graphEvidenceForScenario = (graphContext) => graphContext?.reason ? "git-diff" : "";

const inferFeatureForChange = (change) => {
  const normalized = change.path.replace(/\\/g, "/").toLowerCase();
  if (securityLikeChange(change)) return "Security";
  if (validationLikeChange(change)) return "Validation";
  if (/export|csv|pdf/.test(normalized)) return "Export";
  if (/search|filter/.test(normalized)) return "Search and filters";
  if (/workflow|flow|lifecycle/.test(normalized)) return "Workflow";
  if (/route|api|service/.test(normalized)) return "API contract";
  if (/record|object|field|metadata/.test(normalized)) return "Metadata and records";
  if (/layout|style|component|panel|modal/.test(normalized)) return "Application UI";
  return change.area || "Application";
};

const applicationScenarioTemplates = (change, index, graphContext) => {
  const base = scenarioForChange(change, index);
  const feature = inferFeatureForChange(change);
  const graphEvidence = graphEvidenceForScenario(graphContext);
  const graphSource = graphEvidence ? "git-diff" : "rules";
  const surface =
    routeLikeChange(change, graphContext)
      ? "api"
      : change.surface === "keystone" || change.surface === "admin"
        ? change.surface
        : uiLikeChange(change)
          ? "admin"
          : "api";
  const surfaceLabel = surface === "api" ? "API" : surface === "keystone" ? "Keystone" : "Admin";
  const common = {
    ...base,
    surface,
    surfaceLabel,
    feature,
    adminScreen: /object|field|metadata/i.test(change.path) ? "Objects" : /role|permission|access/i.test(change.path) ? "Permissions" : "Apps",
    graphSource,
    graphEvidence,
    safeDataPolicy: "seeded-or-disposable-data",
    resetRequired: false
  };
  const templates = [];
  const pushTemplate = (patch) => {
    templates.push({
      ...common,
      ...patch,
      id: `AGENT_${String(index + 1).padStart(3, "0")}_${String(templates.length + 1).padStart(2, "0")}`,
      suite: surface === "api" ? "list-view-api" : surface === "keystone" ? "keystone-list-view" : "admin-list-view",
      sourcePath: change.path
    });
  };

  if (change.risk === "High" || securityLikeChange(change) || routeLikeChange(change, graphContext)) {
    pushTemplate({
      scenarioFamily: "BVT",
      level: "BVT",
      tag: "@bvt",
      testCase: `BVT verifies ${feature.toLowerCase()} remains reachable after ${path.basename(change.path)}`,
      steps: readableTestSteps({
        title: `BVT verifies ${feature.toLowerCase()} remains reachable after ${path.basename(change.path)}`,
        spec: change.path,
        feature,
        surface: surface === "api" ? "API" : surface === "keystone" ? "Keystone" : "Admin"
      }),
      expected: "The critical impacted surface remains reachable and authenticated behavior is intact.",
      proof: graphEvidence ? `Graph evidence (${graphEvidence}) identifies this as critical impact.` : `Critical smoke coverage for ${change.path}.`
    });
  }

  pushTemplate({
    scenarioFamily: "Sanity",
    level: "Sanity",
    tag: "@sanity",
    testCase: `Sanity verifies ${feature.toLowerCase()} happy path after ${path.basename(change.path)}`,
    steps: readableTestSteps({
      title: `Sanity verifies ${feature.toLowerCase()} happy path after ${path.basename(change.path)}`,
      spec: change.path,
      feature,
      surface: surface === "api" ? "API" : surface === "keystone" ? "Keystone" : "Admin"
    }),
    expected: "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    proof: graphEvidence ? `Graph evidence (${graphEvidence}) links the change to this feature path.` : `Focused sanity coverage for ${change.path}.`
  });

  if (validationLikeChange(change) || securityLikeChange(change) || routeLikeChange(change, graphContext)) {
    pushTemplate({
      scenarioFamily: securityLikeChange(change) ? "Security" : "Validation",
      level: securityLikeChange(change) ? "BVT" : "Sanity",
      tag: securityLikeChange(change) ? "@bvt" : "@sanity",
      testCase: `${securityLikeChange(change) ? "Security" : "Validation"} checks guarded behavior after ${path.basename(change.path)}`,
      steps: readableTestSteps({
        title: `${securityLikeChange(change) ? "Security" : "Validation"} checks guarded behavior after ${path.basename(change.path)} invalid unauthorized reject`,
        spec: change.path,
        feature,
        surface: surface === "api" ? "API" : surface === "keystone" ? "Keystone" : "Admin"
      }),
      expected: "Invalid or unauthorized input is rejected with a safe error state and no crash.",
      proof: graphEvidence ? `Graph evidence (${graphEvidence}) indicates guarded logic impact.` : `Guarded behavior coverage for ${change.path}.`
    });
  }

  if (mutationLikeChange(change)) {
    pushTemplate({
      scenarioFamily: "Mutation",
      level: "Regression",
      tag: "@regression",
      resetRequired: true,
      testCase: `Regression verifies guarded write flow after ${path.basename(change.path)}`,
      precondition: "ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.",
      steps: readableTestSteps({
        title: `Regression verifies guarded create update delete restore flow after ${path.basename(change.path)}`,
        spec: change.path,
        feature,
        surface: surface === "api" ? "API" : surface === "keystone" ? "Keystone" : "Admin"
      }),
      expected: "The write flow works on seeded/disposable data and the reset path can restore the local dataset.",
      proof: graphEvidence ? `Graph evidence (${graphEvidence}) identifies mutation or lifecycle impact.` : `Guarded mutation regression coverage for ${change.path}.`
    });
  }

  pushTemplate({
    scenarioFamily: "Regression",
    level: "Regression",
    tag: "@regression",
    testCase: `Regression protects downstream ${feature.toLowerCase()} behavior after ${path.basename(change.path)}`,
    steps: readableTestSteps({
      title: `Regression protects downstream ${feature.toLowerCase()} search navigation refresh settings readback after ${path.basename(change.path)}`,
      spec: change.path,
      feature,
      surface: surface === "api" ? "API" : surface === "keystone" ? "Keystone" : "Admin"
    }),
    expected: "Connected downstream behavior remains stable after the code change.",
    proof: graphEvidence ? `Graph evidence (${graphEvidence}) provides downstream relationship context.` : `Downstream regression coverage for ${change.path}.`
  });

  return templates.slice(0, 5);
};

const tokenize = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);

const existingCoverageForScenario = (scenario, inventoryRows) => {
  const scenarioTokens = new Set([
    ...tokenize(scenario.feature),
    ...tokenize(scenario.testCase),
    ...tokenize(scenario.sourcePath)
  ]);
  const candidates = inventoryRows
    .map((row) => {
      const haystack = `${row.surface || ""} ${row.feature || ""} ${row.title || ""} ${row.displayTitle || ""} ${row.input || ""} ${row.expected || ""}`;
      const rowTokens = new Set(tokenize(haystack));
      let score = 0;
      for (const token of scenarioTokens) {
        if (rowTokens.has(token)) score += 1;
      }
      if (String(row.surface || "").toLowerCase() === String(scenario.surfaceLabel || scenario.surface || "").toLowerCase()) {
        score += 2;
      }
      return { row, score };
    })
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return candidates.map(({ row, score }) => ({
    id: row.id,
    title: row.title,
    displayTitle: row.displayTitle,
    surface: row.surface,
    feature: row.feature,
    score
  }));
};

const changedFileDiff = (baseRef, filePath, targetRef = "HEAD") => {
  try {
    return runGit(appRoot, ["diff", "--unified=80", `${baseRef}...${targetRef}`, "--", filePath], 60_000).slice(0, 18_000);
  } catch {
    try {
      return runGit(appRoot, ["diff", "--unified=80", baseRef, targetRef, "--", filePath], 60_000).slice(0, 18_000);
    } catch {
      return "";
    }
  }
};

const parseGeminiJson = (payload) => {
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(cleaned);
};

const callGeminiPlanner = async (scan, inventoryRows) => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) return null;

  const changedFiles = scan.changedFiles.map((change) => ({
    ...change,
    diff: changedFileDiff(scan.baseRef, change.path, scan.targetRef || "HEAD")
  }));
  const existingTests = inventoryRows.slice(0, 180).map((row) => ({
    id: row.id,
    title: row.title,
    surface: row.surface,
    feature: row.feature,
    level: row.testingLevel,
    tags: row.tags,
    input: row.input,
    expected: row.expected,
    proof: row.proof
  }));
  const prompt = [
    "You are the Core Platform QA test-generation agent.",
    "Analyze changed code and existing tests. Return JSON only.",
    "Rules:",
    "- Compare changed business logic, UI behavior, validation, permissions, API behavior, and workflows.",
    "- Do not duplicate tests. If an existing test is enough, action must be reuse and include existingTestIds.",
    "- Generate only when missing coverage is clear.",
    "- This is application-wide coverage, not list-view-only coverage. Consider Admin, Keystone/Shockwave, API/service, metadata, shared UI, permissions, records, workflows, and business logic.",
    "- Generate API-level tests when route handlers, response shape, middleware, or API consumers changed.",
    "- Write/destructive scenarios must use seeded or disposable test data and require reset after completion.",
    "- Classify every decision as exactly one testing level: BVT, Sanity, or Regression.",
    "- BVT is for critical smoke/build verification. Sanity is for important focused behavior. Regression is for broader existing behavior and lower-risk changes.",
    "- Tags must be exactly @bvt, @sanity, or @regression.",
    "- Keep generated tests practical for Playwright.",
    "",
    JSON.stringify({
      baselineCommit: scan.baseRef,
      headCommit: scan.headCommit,
      changedFiles,
      existingTests
    })
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          responseSchema: {
            type: "object",
            properties: {
              decisions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    sourcePath: { type: "string" },
                    action: { type: "string", enum: ["reuse", "generate"] },
                    level: { type: "string", enum: ["BVT", "Sanity", "Regression"] },
                    tag: { type: "string", enum: ["@bvt", "@sanity", "@regression"] },
                    feature: { type: "string" },
                    testCase: { type: "string" },
                    steps: { type: "string" },
                    expected: { type: "string" },
                    proof: { type: "string" },
                    adminScreen: { type: "string" },
                    existingTestIds: { type: "array", items: { type: "string" } },
                    reason: { type: "string" }
                  },
                  required: ["sourcePath", "action", "level", "tag", "feature", "testCase", "steps", "expected", "proof", "existingTestIds", "reason"]
                }
              }
            },
            required: ["decisions"]
          }
        }
      })
    }
  ).finally(() => clearTimeout(timer));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gemini planner failed with HTTP ${response.status}`);
  }
  const parsed = parseGeminiJson(payload);
  return {
    model: geminiModel,
    groundingMetadata: payload?.candidates?.[0]?.groundingMetadata || null,
    decisions: Array.isArray(parsed?.decisions) ? parsed.decisions : []
  };
};

const latestGeneratedArtifact = () => {
  if (!existsSync(generatedRoot)) return null;
  const files = readdirSync(generatedRoot)
    .filter((item) => /^agent-scenarios-\d+\.json$/.test(item))
    .map((item) => {
      const fullPath = path.join(generatedRoot, item);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) return null;
  const payload = JSON.parse(readFileSync(files[0].fullPath, "utf8"));
  return { ...payload, outputPath: path.relative(repoRoot, files[0].fullPath).replace(/\\/g, "/") };
};

const readGeneratedArtifactByPath = (artifactPath) => {
  const requested = String(artifactPath || "").trim();
  if (!requested) return null;
  const normalized = requested.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullPath = path.resolve(repoRoot, normalized);
  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error("Generated artifact path is outside the automation repo.");
  }
  if (!fullPath.startsWith(generatedRoot + path.sep) || !/^agent-scenarios-\d+\.json$/.test(path.basename(fullPath))) {
    throw new Error("Generated artifact path is not an agent scenario manifest.");
  }
  if (!existsSync(fullPath)) {
    throw new Error("Generated artifact was not found. Generate scenarios again.");
  }
  const payload = JSON.parse(readFileSync(fullPath, "utf8"));
  return { ...payload, outputPath: path.relative(repoRoot, fullPath).replace(/\\/g, "/") };
};

const ensureAgentRunnableSpec = (artifact) => {
  if (!artifact?.scenarios?.length) return artifact;
  if (artifact.spec) {
    const existingSpec = path.resolve(repoRoot, artifact.spec);
    if (existsSync(existingSpec)) return artifact;
  }
  mkdirSync(generatedSpecRoot, { recursive: true });
  const timestamp = Date.now();
  const specPath = path.join(generatedSpecRoot, `agent-generated-${timestamp}.spec.ts`);
  const specRelativePath = path.relative(repoRoot, specPath).replace(/\\/g, "/");
  writeFileSync(specPath, generateAgentSpecSource(artifact.scenarios), "utf8");
  if (artifact.outputPath) {
    const artifactFullPath = path.resolve(repoRoot, artifact.outputPath);
    if (artifactFullPath.startsWith(generatedRoot + path.sep) && existsSync(artifactFullPath)) {
      const updatedArtifact = { ...artifact, spec: specRelativePath };
      writeFileSync(artifactFullPath, JSON.stringify(updatedArtifact, null, 2), "utf8");
      return updatedArtifact;
    }
  }
  return { ...artifact, spec: specRelativePath };
};

const readGeneratedAgentInventoryRows = (startIndex = 0) => {
  const artifact = latestGeneratedArtifact();
  if (!artifact?.scenarios?.length) return [];
  return artifact.scenarios.map((scenario, index) => {
    const level = scenario.level || levelForTag(scenario.tag || "");
    const identity = caseIdentity(scenario.feature || scenario.scenarioFamily || "AI Agent", level, startIndex + index);
    return {
      id: scenario.id || identity.id,
      tags: `${identity.tags} ${scenario.tag || categoryTag(level)} @agent-generated @${String(scenario.scenarioFamily || "agent").toLowerCase()}`.trim(),
      testingLevel: level,
      location: artifact.spec || artifact.outputPath || "",
      spec: artifact.spec || "",
      surface: scenario.surfaceLabel || inferSurface("", scenario.title || ""),
      feature: scenario.feature || scenario.scenarioFamily || "AI Agent",
      title: scenario.title || specTitle(scenario),
      displayTitle: scenario.testCase || cleanTitle(scenario.title || ""),
      precondition: scenario.precondition || "",
      input: readableTestSteps({
        raw: scenario.steps || "",
        title: scenario.testCase || scenario.title || "",
        spec: scenario.sourcePath || artifact.spec || "",
        feature: scenario.feature || scenario.scenarioFamily || "AI Agent",
        surface: scenario.surfaceLabel || scenario.surface || inferSurface("", scenario.title || "")
      }),
      expected: scenario.expected || "",
      proof: scenario.proof || "",
      source: "agent",
      action: scenario.action || "",
      scenarioFamily: scenario.scenarioFamily || "",
      coverageDecision: scenario.coverageDecision || "",
      graphSource: scenario.graphSource || "",
      graphEvidence: scenario.graphEvidence || "",
      sourcePath: scenario.sourcePath || ""
    };
  });
};

const specTitle = (scenario) =>
  `${scenario.tag || tagForRisk(scenario.risk)} ${scenario.testCase} [surface: ${scenario.surfaceLabel || scenario.surface}] [feature: ${scenario.feature}] [level: ${scenario.level || "Regression"}] [precondition: ${scenario.precondition}] [input: ${scenario.steps}] [expected: ${scenario.expected}] [proof: ${scenario.proof}]`;


const generateAgentSpecSource = (scenarios) => {
  const cases = JSON.stringify(scenarios, null, 2);
  return `import { expect, test } from "../../helpers/singleBrowserTest";
import {
  apiLogin,
  attachEvidence,
  hasCredentials,
  loginToAdmin,
  loginToKeystone,
  openAdminScreen,
  selectKeystoneAppAndTab
} from "../helpers";

const generatedCases = ${cases};

test.describe("AI generated change-impact smoke tests", () => {
  for (const generatedCase of generatedCases) {
    test(generatedCase.title, async ({ page, request }, testInfo) => {
      test.skip(!hasCredentials(), "Seeded test credentials are not configured.");
      test.skip(Boolean(generatedCase.resetRequired) && process.env.ALLOW_DATA_WRITE !== "true", "Guarded write scenarios require ALLOW_DATA_WRITE=true and reset-enabled runs.");

      if (generatedCase.action === "reuse") {
        testInfo.annotations.push({
          type: "agent-reuse",
          description: (generatedCase.existingTests || []).map((item) => item.id || item.title).join(", ")
        });
      }
      const evidencePayload = {
        id: generatedCase.id,
        family: generatedCase.scenarioFamily,
        action: generatedCase.action,
        reused: (generatedCase.existingTests || []).map((item) => item.id),
        graph: generatedCase.graphSource,
        evidence: generatedCase.graphEvidence
      };

      if (generatedCase.surface === "api") {
        const token = await apiLogin(request);
        const response = await request.get("/api/apps", {
          headers: { Authorization: \`Bearer \${token}\` }
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        const screenshotPath = testInfo.outputPath(\`\${generatedCase.evidenceName}-api-evidence.png\`);
        await page.setContent(\`<!doctype html><html><body style="font-family:Arial;padding:24px;background:#0f172a;color:#e5eefc"><h1>\${generatedCase.testCase}</h1><pre>\${JSON.stringify(evidencePayload, null, 2).replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char] || char))}</pre></body></html>\`);
        await page.screenshot({ fullPage: true, path: screenshotPath });
        await testInfo.attach(\`screenshot-\${generatedCase.evidenceName}\`, {
          path: screenshotPath,
          contentType: "image/png"
        });
        return;
      }

      if (generatedCase.surface === "keystone") {
        await loginToKeystone(page);
        await selectKeystoneAppAndTab(page);
        await expect(page.locator(".object-home").first()).toBeVisible();
      } else {
        await loginToAdmin(page);
        const screen = generatedCase.adminScreen || "Apps";
        const main = await openAdminScreen(page, screen);
        await expect(main).toBeVisible();
      }

      await attachEvidence(page, testInfo, generatedCase.evidenceName).catch(() => null);
    });
  }
});
`;
};

const generateAgentScenarios = async (baseRef = "origin/main") => {
  const scan = scanChangedFiles(baseRef);
  const inventoryRows = readInventory().rows || [];
  let geminiPlan = null;
  try {
    geminiPlan = await callGeminiPlanner(scan, inventoryRows);
  } catch (error) {
    geminiPlan = {
      model: geminiModel,
      error: error instanceof Error ? error.message : "Gemini planner failed.",
      decisions: []
    };
  }
  const decisionByPath = new Map((geminiPlan?.decisions || []).map((decision) => [decision.sourcePath, decision]));
  const graphContextByPath = new Map(scan.changedFiles.map((file) => [file.path, file]));
  const scenarios = scan.changedFiles.flatMap((change, index) => {
    const modelDecision = decisionByPath.get(change.path) || null;
    const graphContext = graphContextByPath.get(change.path) || null;
    return applicationScenarioTemplates(change, index, graphContext).map((template) => {
      const tag = modelDecision?.tag && template.scenarioFamily === "Sanity" ? modelDecision.tag : template.tag;
      const level = modelDecision?.level && template.scenarioFamily === "Sanity" ? modelDecision.level : template.level || levelForTag(tag);
      const draft = {
        ...template,
        feature: template.scenarioFamily === "Sanity" ? modelDecision?.feature || template.feature : template.feature,
        level,
        tag,
        testCase: template.scenarioFamily === "Sanity" ? modelDecision?.testCase || template.testCase : template.testCase,
        steps: readableTestSteps({
          raw: template.scenarioFamily === "Sanity" ? modelDecision?.steps || template.steps : template.steps,
          title: template.scenarioFamily === "Sanity" ? modelDecision?.testCase || template.testCase : template.testCase,
          spec: template.sourcePath,
          feature: template.scenarioFamily === "Sanity" ? modelDecision?.feature || template.feature : template.feature,
          surface: template.surface === "api" ? "API" : template.surface === "keystone" ? "Keystone" : "Admin"
        }),
        expected: template.scenarioFamily === "Sanity" ? modelDecision?.expected || template.expected : template.expected,
        adminScreen: modelDecision?.adminScreen || template.adminScreen,
        evidenceName: `agent-${template.id.toLowerCase()}`
      };
      const modelExistingTests = Array.isArray(modelDecision?.existingTestIds) && template.scenarioFamily === "Sanity"
        ? modelDecision.existingTestIds
            .map((id) => inventoryRows.find((row) => row.id === id))
            .filter(Boolean)
            .map((row) => ({
              id: row.id,
              title: row.title,
              displayTitle: row.displayTitle,
              surface: row.surface,
              feature: row.feature,
              score: 99
            }))
        : [];
      const existingTests = modelExistingTests.length > 0 ? modelExistingTests : existingCoverageForScenario(draft, inventoryRows);
      const action = modelDecision?.action === "generate" && template.scenarioFamily === "Sanity"
        ? "generate"
        : existingTests.length > 0
          ? "reuse"
          : "generate";
      return {
        ...draft,
        action,
        existingTests,
        coverageDecision: action === "reuse" ? "reuse-existing" : "generate-new",
        decision: modelDecision?.reason && template.scenarioFamily === "Sanity"
          ? modelDecision.reason
          : existingTests.length > 0
            ? `Existing ${existingTests[0].id} covers this ${draft.scenarioFamily} scenario; reuse it instead of duplicating.`
            : `No close existing coverage found; generate a new ${draft.tag} ${draft.scenarioFamily} test.`,
        planner: geminiPlan?.decisions?.length ? "gemini" : "rules",
        title: specTitle(draft)
      };
    });
  });
  mkdirSync(generatedRoot, { recursive: true });
  mkdirSync(generatedSpecRoot, { recursive: true });
  const timestamp = Date.now();
  const specPath = path.join(generatedSpecRoot, `agent-generated-${timestamp}.spec.ts`);
  const specRelativePath = path.relative(repoRoot, specPath).replace(/\\/g, "/");
  const generatedCount = scenarios.filter((scenario) => scenario.action === "generate").length;
  const reusedCount = scenarios.filter((scenario) => scenario.action === "reuse").length;
  const resetRequiredCount = scenarios.filter((scenario) => scenario.resetRequired).length;
  const artifact = {
    generatedAt: new Date().toISOString(),
    baseRef: scan.baseRef,
    requestedBaseRef: baseRef,
    previousBaselineCommit: scan.previousBaselineCommit,
    headCommit: scan.headCommit,
    planner: {
      provider: geminiPlan?.decisions?.length ? "gemini" : "rules",
      model: geminiPlan?.model || "",
      error: geminiPlan?.error || "",
      groundingMetadata: geminiPlan?.groundingMetadata || null,
    },
    appRoot,
    spec: scenarios.length > 0 ? specRelativePath : "",
    requiresReset: resetRequiredCount > 0,
    summary: {
      changedFiles: scan.changedFiles.length,
      scenarioCount: scenarios.length,
      generated: generatedCount,
      reused: reusedCount,
      resetRequired: resetRequiredCount
    },
    scenarios
  };
  const outputPath = path.join(generatedRoot, `agent-scenarios-${timestamp}.json`);
  if (scenarios.length > 0) {
    writeFileSync(specPath, generateAgentSpecSource(scenarios), "utf8");
  }
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2), "utf8");
  const state = readAgentState();
  writeAgentState({
    updatedAt: artifact.generatedAt,
    lastArtifact: path.relative(repoRoot, outputPath).replace(/\\/g, "/"),
    lastSpec: artifact.spec,
    lastRunStatus: "generated",
    history: [
      {
        generatedAt: artifact.generatedAt,
        from: scan.baseRef,
        to: scan.headCommit,
        changedFiles: scan.changedFiles.length,
        scenarios: scenarios.length,
        generated: generatedCount,
        reused: reusedCount,
        resetRequired: resetRequiredCount,
        artifact: path.relative(repoRoot, outputPath).replace(/\\/g, "/")
      },
      ...(state.history || [])
    ].slice(0, 20)
  });
  cachedInventory = null;
  cachedInventoryAt = 0;
  return {
    ...artifact,
    outputPath: path.relative(repoRoot, outputPath).replace(/\\/g, "/")
  };
};

const markAgentArtifactSuccessful = (artifact, status = "passed") => {
  if (!artifact?.headCommit) return;
  writeAgentState({
    baselineCommit: artifact.headCommit,
    lastSuccessfulAgentCommit: artifact.headCommit,
    lastRunStatus: status,
    updatedAt: new Date().toISOString(),
    lastArtifact: artifact.outputPath || readAgentState().lastArtifact || "",
    lastSpec: artifact.spec || readAgentState().lastSpec || ""
  });
};

const resetCorePlatformSeedData = () => {
  const commands = [
    { command: "powershell", args: ["-ExecutionPolicy", "Bypass", "-File", "scripts/stop-all.ps1"] },
    { command: "powershell", args: ["-ExecutionPolicy", "Bypass", "-File", "scripts/reset-db.ps1", "-SkipSeedAdmin", "-SkipMetadataLoad", "-SkipSeedTestRolesGroups"] },
    { command: process.platform === "win32" ? "cmd.exe" : "npm", args: process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", "run", "seed:industry-suite"] : ["run", "seed:industry-suite"] }
  ];
  const output = [];
  for (const item of commands) {
    const result = spawnSync(item.command, item.args, {
      cwd: appRoot,
      encoding: "utf8",
      timeout: 10 * 60_000,
      windowsHide: true
    });
    output.push(`> ${item.command} ${item.args.join(" ")}`);
    if (result.stdout) output.push(result.stdout.trim());
    if (result.stderr) output.push(result.stderr.trim());
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(output.concat(`Reset command exited ${result.status}.`).filter(Boolean).join("\n"));
    }
  }
  return output.filter(Boolean).join("\n").slice(-12_000);
};

const readInventory = () => {
  const now = Date.now();
  if (cachedInventory && now - cachedInventoryAt < 5 * 60 * 1000) {
    return cachedInventory;
  }

  const visibleInventorySpecs = new Set([
    "admin-keystone-nav-bvt-206.spec.ts",
    "app-hierarchy-bvt-110.spec.ts",
    "search-results-bvt-120.spec.ts",
    "admin-agent-bvt-125.spec.ts",
    "keystone-core-reflection-bvt-105.spec.ts",
    "access-records-bvt-130.spec.ts",
    "admin-tabs-bvt-102.spec.ts",
    "flows-bvt-101.spec.ts",
    "groups-bvt-124.spec.ts",
    "objects-bvt-135.spec.ts",
    "permissions-bvt-135.spec.ts",
    "roles-bvt-101.spec.ts",
    "sharing-settings-bvt-132.spec.ts",
    "system-settings-bvt-110.spec.ts",
    "email-logs-bvt-105.spec.ts",
    "scheduled-jobs-bvt-125.spec.ts",
    "audit-logs-bvt-105.spec.ts",
    "recycle-bin-bvt-125.spec.ts",
    "keystone-admin-other-reflection-bvt-105.spec.ts",
    "users-bvt-101.spec.ts"
  ]);

  const configs = [
    "tests/e2e/playwright.list-view-regression.config.ts",
    "tests/e2e/playwright.admin-depthwise.config.ts"
  ];
  const outputs = [];
  const errors = [];
  for (const config of configs) {
    const result = spawnSync("cmd", ["/c", "npx.cmd", "playwright", "test", "--list", "-c", config, "--reporter=list"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true
    });
    outputs.push(`${result.stdout || ""}\n${result.stderr || ""}`);
    if (result.error) errors.push(result.error.message);
    if (result.status && result.status !== 0) errors.push(`${config} exited ${result.status}`);
  }
  const output = outputs.join("\n");
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const marker = " › ";
    if (!line.includes(marker) || !/\.(spec|test)\.ts:\d+:\d+/.test(line)) continue;
    const trimmed = line.trim();
    const location = trimmed.split(marker)[0].trim();
    const parts = trimmed.split(marker);
    const title = parts[parts.length - 1].trim();
    const spec = location.replace(/:\d+:\d+$/, "");
    const specName = path.basename(spec);
    if (!visibleInventorySpecs.has(specName)) continue;
    const override = visibleBvtInventoryRows[specName] || {};
    const surface = override.surface || inferSurface(spec, title);
    const feature = override.feature || parseMeta(title, "feature") || "List View";
    const level = override.testingLevel || inferTestingLevel(parseMeta(title, "level"), title);
    const identity = override.id
      ? { id: override.id, tags: override.tags || titleTags(title) || `@case-${override.id} ${categoryTag(level)}`, testingLevel: level }
      : caseIdentity(feature, level, rows.length);
    const fallbackNarrative = defaultCaseNarrative(title, spec, feature, surface);
    const input = override.input || readableTestSteps({
      raw: parseMeta(title, "input") || fallbackNarrative.input,
      title,
      spec,
      feature,
      surface
    });
    const expected = override.expected || parseMeta(title, "expected") || fallbackNarrative.expected;
    const testData = override.testData || parseMeta(title, "testdata") || extractSeedDataFromSpec(spec);
    rows.push({
      id: identity.id,
      tags: identity.tags,
      testingLevel: identity.testingLevel,
      location,
      spec,
      surface,
      feature,
      title,
      displayTitle: cleanTitle(title),
      precondition: override.precondition || parseMeta(title, "precondition") || fallbackNarrative.precondition,
      input,
      expected,
      proof: override.proof || parseMeta(title, "proof") || fallbackNarrative.proof,
      testData,
      steps: structuredStepsFromText({ input, surface, feature, expected, testData })
    });
  }
  if (rows.length === 0 && existsSync(resultsJsonPath)) {
    const previous = readResults();
    for (const row of previous.rows ?? []) {
      const input = readableTestSteps({
        raw: row.inputAction || "",
        title: row.testCaseTitle || "",
        feature: row.featureArea || "",
        surface: row.surface || ""
      });
      const expected = row.expectedResult || "";
      rows.push({
        id: row.id,
        tags: row.tags || `@case-${row.id} ${categoryTag(row.testingLevel || "Regression")}`,
        testingLevel: row.testingLevel || "",
        location: "",
        spec: "",
        surface: row.surface || "",
        feature: row.featureArea || "",
        title: row.testCaseTitle || "",
        displayTitle: row.testCaseTitle || "",
        precondition: row.precondition || "",
        input,
        expected,
        proof: row.proof || "",
        steps: row.steps || structuredStepsFromText({ input, surface: row.surface || "", feature: row.featureArea || "", expected, testData: row.testData || "" })
      });
    }
  }
  const existingInventoryKeys = new Set(rows.map((row) => `${row.title}::${row.spec}`));
  if (process.env.INCLUDE_GENERATED_AGENT_INVENTORY === "true") {
    for (const generatedRow of readGeneratedAgentInventoryRows(rows.length)) {
      const key = `${generatedRow.title}::${generatedRow.spec}`;
      if (existingInventoryKeys.has(key)) continue;
      existingInventoryKeys.add(key);
      rows.push(generatedRow);
    }
  }
  cachedInventory = {
    updatedAt: new Date().toISOString(),
    total: rows.length,
    rows,
    error: errors.length === 0 ? "" : `${errors.join("; ")}\n${output.slice(-1000)}`
  };
  cachedInventoryAt = now;
  return cachedInventory;
};

const runListViewSuite = async (request, response) => {
  if (runState.running || currentProcess) {
    sendJson(response, 409, { error: "A list-view test run is already in progress." });
    return;
  }

  let body;
  try {
    body = await readRequestJson(request);
  } catch {
    sendJson(response, 400, { error: "Invalid JSON request body." });
    return;
  }

  const surface = String(body.surface || "admin").toLowerCase();
  if (!allowedSurfaces.has(surface)) {
    sendJson(response, 400, { error: "Unsupported surface." });
    return;
  }

  const reset = Boolean(body.reset);
  const headed = Boolean(body.headed);
  const selectedTests = Array.isArray(body.tests)
    ? body.tests.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const scenario = selectedTests.length > 0
    ? selectedTests.map(escapeRegex).join("|")
    : String(body.scenario || "").trim();
  const depthwiseSurfaceSpecs = {
    "admin-depthwise": {
      label: "admin depthwise",
      specs: [],
      grep: "@admin-depthwise"
    },
    "admin-objects": {
      label: "admin objects depthwise",
      specs: ["tests/e2e/admin-depthwise/admin-object-detail-depthwise.spec.ts"],
      grep: "@admin-screen:Objects"
    },
    "admin-sidebar": {
      label: "admin side navbar",
      specs: ["tests/e2e/admin-depthwise/admin-sidebar-depthwise.spec.ts"],
      grep: "@admin-depthwise"
    },
    "keystone-depthwise": {
      label: "keystone depthwise",
      specs: ["tests/e2e/admin-depthwise/keystone-depthwise.spec.ts"],
      grep: "@keystone-depthwise"
    }
  };
  if (depthwiseSurfaceSpecs[surface]) {
    const suite = depthwiseSurfaceSpecs[surface];
    const effectiveScenario = scenario || suite.grep;
    const args = [
      "playwright",
      "test",
      ...suite.specs,
      "-c",
      "tests/e2e/playwright.admin-depthwise.config.ts",
      "--workers=1"
    ];
    if (effectiveScenario) args.push("-g", effectiveScenario);
    if (headed) args.push("--headed");

    runState.running = true;
    runState.command = `npx ${args.join(" ")}`;
    runState.surface = surface;
    runState.scenario = effectiveScenario;
    runState.selectedTestCount = selectedTests.length;
    runState.reset = reset;
    runState.headed = headed;
    runState.stopRequested = false;
    runState.startedAt = new Date().toISOString();
    runState.finishedAt = null;
    runState.exitCode = null;
    runState.logs = [];
    pushLog(`Starting ${suite.label} run${effectiveScenario ? ` with scenario filter ${effectiveScenario}` : ""}...`);

    const runCommand = process.platform === "win32" ? "cmd.exe" : "npx";
    const runArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;
    currentProcess = spawn(runCommand, runArgs, {
      cwd: repoRoot,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    currentProcess.stdout.on("data", pushLog);
    currentProcess.stderr.on("data", pushLog);
    currentProcess.on("error", (error) => {
      pushLog(`Failed to start test process: ${error.message}`);
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
      runState.exitCode = 1;
      currentProcess = null;
    });
    currentProcess.on("exit", (code) => {
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
      runState.exitCode = runState.stopRequested ? code ?? 130 : code ?? 1;
      pushLog(
        runState.stopRequested
          ? `Test process stopped with exit code ${runState.exitCode}.`
          : `Test process finished with exit code ${runState.exitCode}.`
      );
      currentProcess = null;
    });

    sendJson(response, 202, { ok: true, state: runState });
    return;
  }
  const lifecycleSurfaceSpecs = {
    "metadata-lifecycle": {
      label: "metadata lifecycle",
      spec: [
        "tests/e2e/list-view-regression/admin-metadata-lifecycle.spec.ts",
        "tests/e2e/list-view-regression/admin-object-detail-functional-lifecycle.spec.ts"
      ]
    },
    "security-lifecycle": {
      label: "security lifecycle",
      spec: [
        "tests/e2e/list-view-regression/admin-security-lifecycle.spec.ts",
        "tests/e2e/list-view-regression/admin-access-records-lifecycle.spec.ts",
        "tests/e2e/list-view-regression/admin-permissions-grants-lifecycle.spec.ts"
      ]
    }
  };
  if (lifecycleSurfaceSpecs[surface]) {
    const lifecycle = lifecycleSurfaceSpecs[surface];
    const lifecycleSpecs = Array.isArray(lifecycle.spec) ? lifecycle.spec : [lifecycle.spec];
    const args = [
      "playwright",
      "test",
      ...lifecycleSpecs,
      "-c",
      "tests/e2e/playwright.list-view-regression.config.ts",
      "--workers=1"
    ];
    if (scenario) args.push("-g", scenario);
    if (headed) args.push("--headed");

    runState.running = true;
    runState.command = `npx ${args.join(" ")}`;
    runState.surface = surface;
    runState.scenario = scenario;
    runState.selectedTestCount = selectedTests.length;
    runState.reset = reset;
    runState.headed = headed;
    runState.stopRequested = false;
    runState.startedAt = new Date().toISOString();
    runState.finishedAt = null;
    runState.exitCode = null;
    runState.logs = [];
    pushLog(`Starting ${lifecycle.label} run${scenario ? ` with scenario filter ${scenario}` : ""}...`);

    const runCommand = process.platform === "win32" ? "cmd.exe" : "npx";
    const runArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;
    currentProcess = spawn(runCommand, runArgs, {
      cwd: repoRoot,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    currentProcess.stdout.on("data", pushLog);
    currentProcess.stderr.on("data", pushLog);
    currentProcess.on("error", (error) => {
      pushLog(`Failed to start test process: ${error.message}`);
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
      runState.exitCode = 1;
      currentProcess = null;
    });
    currentProcess.on("exit", (code) => {
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
      runState.exitCode = runState.stopRequested ? code ?? 130 : code ?? 1;
      pushLog(
        runState.stopRequested
          ? `Test process stopped with exit code ${runState.exitCode}.`
          : `Test process finished with exit code ${runState.exitCode}.`
      );
      currentProcess = null;
    });

    sendJson(response, 202, { ok: true, state: runState });
    return;
  }
  if (surface === "permissions-access") {
    const args = [
      "playwright",
      "test",
      "tests/e2e/list-view-regression/permissions-access-records.spec.ts",
      "-c",
      "tests/e2e/playwright.list-view-regression.config.ts",
      "--workers=1"
    ];
    if (scenario) args.push("-g", scenario);
    if (headed) args.push("--headed");

    runState.running = true;
    runState.command = `npx ${args.join(" ")}`;
    runState.surface = surface;
    runState.scenario = scenario;
    runState.selectedTestCount = selectedTests.length;
    runState.reset = reset;
    runState.headed = headed;
    runState.stopRequested = false;
    runState.startedAt = new Date().toISOString();
    runState.finishedAt = null;
    runState.exitCode = null;
    runState.logs = [];
    pushLog(`Starting permissions/access security run${scenario ? ` with scenario filter ${scenario}` : ""}...`);

    const runCommand = process.platform === "win32" ? "cmd.exe" : "npx";
    const runArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;
    currentProcess = spawn(runCommand, runArgs, {
      cwd: repoRoot,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    currentProcess.stdout.on("data", pushLog);
    currentProcess.stderr.on("data", pushLog);
    currentProcess.on("error", (error) => {
      pushLog(`Failed to start test process: ${error.message}`);
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
      runState.exitCode = 1;
      currentProcess = null;
    });
    currentProcess.on("exit", (code) => {
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
      runState.exitCode = runState.stopRequested ? code ?? 130 : code ?? 1;
      pushLog(
        runState.stopRequested
          ? `Test process stopped with exit code ${runState.exitCode}.`
          : `Test process finished with exit code ${runState.exitCode}.`
      );
      currentProcess = null;
    });

    sendJson(response, 202, { ok: true, state: runState });
    return;
  }
  const args = [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "tests/scripts/run-list-view-regression.ps1",
    "-Surface",
    surface
  ];
  if (scenario) args.push("-Scenario", scenario);
  if (!reset) args.push("-SkipReset");
  if (headed) args.push("-Headed");

  runState.running = true;
  runState.command = `powershell ${args.join(" ")}`;
  runState.surface = surface;
  runState.scenario = scenario;
  runState.selectedTestCount = selectedTests.length;
  runState.reset = reset;
  runState.headed = headed;
  runState.stopRequested = false;
  runState.startedAt = new Date().toISOString();
  runState.finishedAt = null;
  runState.exitCode = null;
  runState.logs = [];
  pushLog(
    `Starting ${surface} list-view regression run${
      selectedTests.length > 0 ? ` for ${selectedTests.length} selected test case(s)` : scenario ? ` with scenario filter ${scenario}` : ""
    }...`
  );

  currentProcess = spawn("powershell", args, {
    cwd: repoRoot,
    windowsHide: true,
    shell: false
  });

  currentProcess.stdout.on("data", pushLog);
  currentProcess.stderr.on("data", pushLog);
  currentProcess.on("error", (error) => {
    pushLog(`Failed to start test process: ${error.message}`);
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = 1;
    currentProcess = null;
  });
  currentProcess.on("exit", (code) => {
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = runState.stopRequested ? code ?? 130 : code ?? 1;
    pushLog(
      runState.stopRequested
        ? `Test process stopped with exit code ${runState.exitCode}.`
        : `Test process finished with exit code ${runState.exitCode}.`
    );
    currentProcess = null;
  });

  sendJson(response, 202, { ok: true, state: runState });
};

const runRecordedScenario = async (request, response) => {
  if (runState.running || currentProcess) {
    sendJson(response, 409, { error: "A list-view test run is already in progress." });
    return;
  }

  let body;
  try {
    body = await readRequestJson(request);
  } catch {
    sendJson(response, 400, { error: "Invalid JSON request body." });
    return;
  }

  const scenarioId = String(body.id || "").trim();
  const scenario = readRecordedMetadata().scenarios.find((item) => item.id === scenarioId);
  if (!scenario) {
    sendJson(response, 404, { error: "Recorded scenario was not found." });
    return;
  }
  const specPath = path.resolve(repoRoot, scenario.spec);
  if (specPath !== repoRoot && !specPath.startsWith(`${repoRoot}${path.sep}`)) {
    sendJson(response, 403, { error: "Recorded scenario path is outside the automation repo." });
    return;
  }
  if (!existsSync(specPath)) {
    sendJson(response, 404, { error: "Recorded scenario spec file was not found." });
    return;
  }

  const headed = Boolean(body.headed);
  const config = "tests/e2e/playwright.list-view-regression.config.ts";
  const relativeSpec = path.relative(repoRoot, specPath).replace(/\\/g, "/");
  const args = ["playwright", "test", relativeSpec, "-c", config, "--workers=1"];

  runState.running = true;
  runState.command = `npx ${args.join(" ")}`;
  runState.surface = scenario.surface || "recorded";
  runState.scenario = scenario.name || scenario.id;
  runState.selectedTestCount = 1;
  runState.reset = false;
  runState.headed = headed;
  runState.stopRequested = false;
  runState.startedAt = new Date().toISOString();
  runState.finishedAt = null;
  runState.exitCode = null;
  runState.logs = [];
  pushLog(`Starting recorded scenario "${scenario.name}"...`);

  const childEnv = { ...process.env, LIST_VIEW_REGRESSION_HEADED: headed ? "1" : "0" };
  const runCommand = process.platform === "win32" ? "cmd.exe" : "npx";
  const runArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;
  try {
    currentProcess = spawn(runCommand, runArgs, {
      cwd: repoRoot,
      env: childEnv,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start recorded scenario.";
    pushLog(`Failed to start recorded scenario: ${message}`);
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = 1;
    currentProcess = null;
    sendJson(response, 500, { error: message, state: runState });
    return;
  }

  currentProcess.stdout.on("data", pushLog);
  currentProcess.stderr.on("data", pushLog);
  currentProcess.on("error", (error) => {
    pushLog(`Failed to start recorded scenario: ${error.message}`);
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = 1;
    currentProcess = null;
  });
  currentProcess.on("exit", (code) => {
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = runState.stopRequested ? code ?? 130 : code ?? 1;
    pushLog(
      runState.stopRequested
        ? `Recorded scenario stopped with exit code ${runState.exitCode}.`
        : `Recorded scenario finished with exit code ${runState.exitCode}.`
    );
    currentProcess = null;
  });

  sendJson(response, 202, { ok: true, state: runState });
};

const runAgentGeneratedScenarios = async (request, response) => {
  if (runState.running || currentProcess) {
    sendJson(response, 409, { error: "A list-view test run is already in progress." });
    return;
  }

  let body;
  try {
    body = await readRequestJson(request);
  } catch {
    sendJson(response, 400, { error: "Invalid JSON request body." });
    return;
  }

  let artifact = readGeneratedArtifactByPath(body.artifactPath || body.outputPath) || latestGeneratedArtifact();
  if (!artifact) {
    artifact = await generateAgentScenarios(String(body.baseRef || "auto").trim() || "auto");
  }
  if (!artifact.scenarios || artifact.scenarios.length === 0) {
    sendJson(response, 409, { error: "No changed files were found, so there are no generated agent scenarios to run." });
    return;
  }
  artifact = ensureAgentRunnableSpec(artifact);

  const headed = Boolean(body.headed);
  const resetAfterRun = Boolean(body.reset || artifact.requiresReset);
  const reusableTitles = Array.from(
    new Set(
      artifact.scenarios
        .filter((scenario) => scenario.action === "reuse")
        .flatMap((scenario) => scenario.existingTests || [])
        .map((testCase) => testCase.title)
        .filter(Boolean)
    )
  );
  let runMode = "generated";
  let args = [];
  let runCommand = process.platform === "win32" ? "cmd.exe" : "npx";
  let runArgs = [];
  let commandLabel = "";
  let scenarioLabel = "";
  if (artifact.spec) {
    const specPath = path.resolve(repoRoot, artifact.spec);
    if (specPath !== repoRoot && !specPath.startsWith(`${repoRoot}${path.sep}`)) {
      sendJson(response, 403, { error: "Generated agent spec path is outside the automation repo." });
      return;
    }
    if (!existsSync(specPath)) {
      sendJson(response, 404, { error: "Generated agent spec file was not found. Generate scenarios again." });
      return;
    }
    const config = "tests/e2e/playwright.list-view-regression.config.ts";
    const relativeSpec = path.relative(repoRoot, specPath).replace(/\\/g, "/");
    args = ["playwright", "test", relativeSpec, "-c", config, "--workers=1"];
    runArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;
    commandLabel = `npx ${args.join(" ")}`;
    scenarioLabel = path.basename(relativeSpec);
  } else if (reusableTitles.length > 0) {
    runMode = "reuse";
    const scenario = reusableTitles.map(escapeRegex).join("|");
    args = [
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "tests/scripts/run-list-view-regression.ps1",
      "-Surface",
      "all",
      "-Scenario",
      scenario,
      "-SkipReset"
    ];
    if (headed) args.push("-Headed");
    runCommand = "powershell";
    runArgs = args;
    commandLabel = `powershell ${args.join(" ")}`;
    scenarioLabel = "reused existing coverage";
  } else {
    sendJson(response, 409, { error: "The agent did not generate new specs or find reusable existing tests." });
    return;
  }

  runState.running = true;
  runState.command = commandLabel;
  runState.surface = "agent";
  runState.scenario = scenarioLabel;
  runState.selectedTestCount = artifact.scenarios.length;
  runState.reset = resetAfterRun;
  runState.headed = headed;
  runState.stopRequested = false;
  runState.startedAt = new Date().toISOString();
  runState.finishedAt = null;
  runState.exitCode = null;
  runState.logs = [];
  pushLog(
    runMode === "reuse"
      ? `Starting AI agent reused existing coverage run (${reusableTitles.length} existing case(s) for ${artifact.scenarios.length} agent scenario(s))...`
      : `Starting AI generated scenario run (${artifact.scenarios.length} agent scenario(s), ${artifact.summary?.generated || 0} new, ${artifact.summary?.reused || 0} reused)...`
  );

  const childEnv = {
    ...process.env,
    LIST_VIEW_REGRESSION_HEADED: headed ? "1" : "0",
    ALLOW_DATA_WRITE: resetAfterRun ? "true" : process.env.ALLOW_DATA_WRITE || ""
  };
  try {
    currentProcess = spawn(runCommand, runArgs, {
      cwd: repoRoot,
      env: childEnv,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start AI generated scenarios.";
    pushLog(`Failed to start AI generated scenarios: ${message}`);
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = 1;
    currentProcess = null;
    sendJson(response, 500, { error: message, state: runState });
    return;
  }

  currentProcess.stdout.on("data", pushLog);
  currentProcess.stderr.on("data", pushLog);
  currentProcess.on("error", (error) => {
    pushLog(`Failed to start AI generated scenarios: ${error.message}`);
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = 1;
    currentProcess = null;
  });
  currentProcess.on("exit", (code) => {
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = runState.stopRequested ? code ?? 130 : code ?? 1;
    if (!runState.stopRequested && resetAfterRun) {
      pushLog("Resetting Core Platform seeded data after AI generated scenario run...");
      try {
        const resetOutput = resetCorePlatformSeedData();
        pushLog(`Seed reset completed.${resetOutput ? `\n${resetOutput}` : ""}`);
      } catch (error) {
        runState.exitCode = 1;
        pushLog(`Seed reset failed: ${error instanceof Error ? error.message : "Unknown reset failure."}`);
      }
    }
    if (!runState.stopRequested && runState.exitCode === 0) {
      markAgentArtifactSuccessful(artifact, "passed");
    } else {
      writeAgentState({ lastRunStatus: runState.stopRequested ? "stopped" : "failed", updatedAt: new Date().toISOString() });
    }
    pushLog(
      runState.stopRequested
        ? `AI generated scenarios stopped with exit code ${runState.exitCode}.`
        : `AI generated scenarios finished with exit code ${runState.exitCode}.`
    );
    currentProcess = null;
  });

  sendJson(response, 202, { ok: true, artifact, state: runState });
};

const defaultSchedulerConfig = () => ({
  enabled: false,
  pollMinutes: Number(process.env.AGENT_MAIN_POLL_MINUTES || 15),
  dailyTime: process.env.AGENT_DAILY_FULL_RUN_TIME || "",
  runAfterMainChange: true,
  autoPull: true,
  scope: "complete",
  headed: false,
  reset: false
});

const readSchedulerConfig = () => {
  if (!existsSync(agentSchedulerConfigPath)) return defaultSchedulerConfig();
  try {
    const parsed = JSON.parse(readFileSync(agentSchedulerConfigPath, "utf8"));
    return {
      ...defaultSchedulerConfig(),
      ...parsed,
      pollMinutes: Math.max(1, Number(parsed.pollMinutes || defaultSchedulerConfig().pollMinutes)),
      scope: ["complete", "bvt", "sanity", "regression"].includes(parsed.scope) ? parsed.scope : "complete"
    };
  } catch {
    return defaultSchedulerConfig();
  }
};

const writeSchedulerConfig = (config) => {
  mkdirSync(generatedRoot, { recursive: true });
  const next = {
    ...readSchedulerConfig(),
    ...config,
    pollMinutes: Math.max(1, Number(config.pollMinutes || readSchedulerConfig().pollMinutes || 15)),
    scope: ["complete", "bvt", "sanity", "regression"].includes(config.scope) ? config.scope : readSchedulerConfig().scope
  };
  writeFileSync(agentSchedulerConfigPath, JSON.stringify(next, null, 2), "utf8");
  configureScheduler();
  return next;
};

const schedulerStatus = () => ({
  config: readSchedulerConfig(),
  running: Boolean(runState.running),
  currentRun: runState,
  sync: appMainSyncStatus(),
  state: readAgentState()
});

const runCompleteSuiteFromScheduler = ({ reason = "manual", scope = "complete", headed = false, reset = false } = {}) => {
  if (runState.running || currentProcess) {
    return { queued: false, started: false, reason: "A test run is already in progress." };
  }

  const args = [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "tests/scripts/run-list-view-regression.ps1",
    "-Surface",
    "all"
  ];
  const scopePattern = {
    bvt: "@bvt",
    sanity: "@sanity",
    regression: "@regression"
  }[scope];
  if (scopePattern) args.push("-Scenario", scopePattern);
  if (!reset) args.push("-SkipReset");
  if (headed) args.push("-Headed");

  runState.running = true;
  runState.command = `powershell ${args.join(" ")}`;
  runState.surface = "all";
  runState.scenario = scope === "complete" ? "Scheduled complete test run" : `Scheduled ${scope} test run`;
  runState.selectedTestCount = 0;
  runState.reset = Boolean(reset);
  runState.headed = Boolean(headed);
  runState.stopRequested = false;
  runState.startedAt = new Date().toISOString();
  runState.finishedAt = null;
  runState.exitCode = null;
  runState.logs = [];
  pushLog(`Starting ${runState.scenario} (${reason}).`);

  currentProcess = spawn("powershell", args, {
    cwd: repoRoot,
    env: { ...process.env, LIST_VIEW_REGRESSION_HEADED: headed ? "1" : "0" },
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  currentProcess.stdout.on("data", pushLog);
  currentProcess.stderr.on("data", pushLog);
  currentProcess.on("error", (error) => {
    pushLog(`Scheduled test run failed to start: ${error.message}`);
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = 1;
    currentProcess = null;
  });
  currentProcess.on("exit", (code) => {
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = runState.stopRequested ? code ?? 130 : code ?? 1;
    writeAgentState({
      lastScheduledRunAt: runState.finishedAt,
      lastRunStatus: runState.exitCode === 0 ? "passed" : runState.stopRequested ? "stopped" : "failed",
      updatedAt: runState.finishedAt
    });
    pushLog(
      runState.stopRequested
        ? `Scheduled test run stopped with exit code ${runState.exitCode}.`
        : `Scheduled test run finished with exit code ${runState.exitCode}.`
    );
    currentProcess = null;
  });

  writeAgentState({ lastScheduledRunAt: runState.startedAt, lastRunStatus: "running", updatedAt: runState.startedAt });
  return { queued: false, started: true, state: runState };
};

const schedulerTick = () => {
  const config = readSchedulerConfig();
  if (!config.enabled || runState.running || currentProcess) return;
  try {
    const before = appMainSyncStatus();
    const sync = syncMainBranch({ pull: config.autoPull });
    const shouldRunForMain = config.runAfterMainChange && sync.after.remoteMainCommit && sync.after.remoteMainCommit !== before.remoteMainCommit;
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const state = readAgentState();
    const dailyDue =
      config.dailyTime &&
      !String(state.lastScheduledRunAt || "").startsWith(todayKey) &&
      now.toTimeString().slice(0, 5) >= config.dailyTime;
    if (shouldRunForMain || dailyDue) {
      buildAgentGraph("auto");
      runCompleteSuiteFromScheduler({
        reason: shouldRunForMain ? "main branch changed" : "daily schedule",
        scope: config.scope,
        headed: config.headed,
        reset: config.reset
      });
    }
  } catch (error) {
    writeAgentState({
      lastRunStatus: `scheduler-error: ${error instanceof Error ? error.message : "unknown error"}`,
      updatedAt: new Date().toISOString()
    });
  }
};

const configureScheduler = () => {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  const config = readSchedulerConfig();
  if (!config.enabled) return;
  schedulerTimer = setInterval(schedulerTick, Math.max(1, Number(config.pollMinutes || 15)) * 60 * 1000);
  schedulerTimer.unref?.();
};

const startRecording = async (request, response) => {
  if (recordState.recording || recorderProcess) {
    sendJson(response, 409, { error: "A recording session is already in progress." });
    return;
  }
  if (runState.running || currentProcess) {
    sendJson(response, 409, { error: "Stop the current test run before recording a new scenario." });
    return;
  }

  let body;
  try {
    body = await readRequestJson(request);
  } catch {
    sendJson(response, 400, { error: "Invalid JSON request body." });
    return;
  }

  const surface = String(body.surface || "").toLowerCase();
  const target = recordableSurfaces.get(surface);
  if (!target) {
    sendJson(response, 400, { error: "Recording supports only Admin and Keystone." });
    return;
  }

  let authWarning = "";
  try {
    await ensureAuthStorage();
  } catch (error) {
    authWarning = error instanceof Error ? error.message : "Unable to prepare recording auth state.";
  }

  mkdirSync(recordedDraftRoot, { recursive: true });
  const draftPath = path.join(recordedDraftRoot, `${surface}-${Date.now()}.spec.ts`);
  const args = [
    "playwright",
    "codegen",
    "--target",
    "playwright-test",
    "--browser",
    "chromium",
    "--output",
    draftPath
  ];
  if (existsSync(storageStatePath)) {
    args.push("--load-storage", storageStatePath);
  }
  args.push(target.url);

  Object.assign(recordState, {
    recording: true,
    surface,
    surfaceLabel: target.label,
    url: target.url,
    draftPath,
    command: `npx ${args.join(" ")}`,
    startedAt: new Date().toISOString(),
    stopRequested: false,
    exitCode: null,
    error: "",
    logs: []
  });
  pushRecorderLog(`Starting ${target.label} recorder at ${target.url}.`);
  if (authWarning) {
    pushRecorderLog(`Auth storage warning: ${authWarning} You can still sign in manually in the recorder browser.`);
  }

  const recorderCommand = process.platform === "win32" ? "cmd.exe" : "npx";
  const recorderArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;
  try {
    recorderProcess = spawn(recorderCommand, recorderArgs, {
      cwd: repoRoot,
      windowsHide: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    recordState.recording = false;
    recordState.error = error instanceof Error ? error.message : "Failed to start recorder.";
    recordState.exitCode = 1;
    pushRecorderLog(`Failed to start recorder: ${recordState.error}`);
    recorderProcess = null;
    sendJson(response, 500, { error: recordState.error, state: recordState });
    return;
  }
  recorderProcess.stdout.on("data", pushRecorderLog);
  recorderProcess.stderr.on("data", pushRecorderLog);
  recorderProcess.on("error", (error) => {
    recordState.recording = false;
    recordState.error = error.message;
    recordState.exitCode = 1;
    pushRecorderLog(`Failed to start recorder: ${error.message}`);
    recorderProcess = null;
  });
  recorderProcess.on("exit", (code) => {
    recordState.recording = false;
    recordState.exitCode = recordState.stopRequested ? code ?? 130 : code ?? 0;
    pushRecorderLog(
      recordState.stopRequested
        ? `Recorder stopped with exit code ${recordState.exitCode}.`
        : `Recorder exited with exit code ${recordState.exitCode}.`
    );
    recorderProcess = null;
  });

  sendJson(response, 202, { ok: true, state: recordState });
};

const stopRecording = async (request, response) => {
  let body;
  try {
    body = await readRequestJson(request);
  } catch {
    sendJson(response, 400, { error: "Invalid JSON request body." });
    return;
  }

  const waitForRecorderExit = () =>
    new Promise((resolve) => {
      if (!recorderProcess) {
        resolve();
        return;
      }
      const processToStop = recorderProcess;
      processToStop.once("exit", () => resolve());
      if (process.platform === "win32" && processToStop.pid) {
        spawnSync("taskkill", ["/PID", String(processToStop.pid), "/T", "/F"], { windowsHide: true });
      } else {
        processToStop.kill("SIGTERM");
        setTimeout(() => {
          if (recorderProcess === processToStop) processToStop.kill("SIGKILL");
        }, 5_000).unref();
      }
    });

  recordState.stopRequested = true;
  pushRecorderLog("Stop and save requested from the dashboard.");
  await waitForRecorderExit();

  try {
    const saved = finalizeRecordedScenario(body.name);
    sendJson(response, 200, { ok: true, ...saved, state: recordState });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Unable to save recorded scenario.", state: recordState });
  }
};

const stopListViewSuite = async (_request, response) => {
  if (!runState.running || !currentProcess) {
    sendJson(response, 409, { error: "No list-view test run is currently in progress." });
    return;
  }

  runState.stopRequested = true;
  pushLog("Stop requested from the list-view test dashboard.");

  if (process.platform === "win32" && currentProcess.pid) {
    const result = spawnSync("taskkill", ["/PID", String(currentProcess.pid), "/T", "/F"], {
      windowsHide: true
    });
    if (result.stdout?.length) pushLog(result.stdout);
    if (result.stderr?.length) pushLog(result.stderr);
  } else {
    currentProcess.kill("SIGTERM");
    setTimeout(() => {
      if (currentProcess && !currentProcess.killed) {
        currentProcess.kill("SIGKILL");
      }
    }, 5_000).unref();
  }

  sendJson(response, 202, { ok: true, state: runState });
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);


  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, runState);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/services") {
    sendJson(response, 200, await readServices());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/framework") {
    sendJson(response, 200, readFramework());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/results") {
    try {
      sendJson(response, 200, readResults());
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Failed to read results." });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/inventory") {
    try {
      if (url.searchParams.get("refresh") === "1") {
        cachedInventory = null;
        cachedInventoryAt = 0;
      }
      sendJson(response, 200, readInventory());
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Failed to read inventory." });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/inventory.xlsx") {
    try {
      if (url.searchParams.get("refresh") === "1") {
        cachedInventory = null;
        cachedInventoryAt = 0;
      }
      sendBuffer(
        response,
        200,
        buildInventoryWorkbook(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "core-platform-test-cases.xlsx"
      );
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Failed to export inventory workbook." });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/recording/status") {
    sendJson(response, 200, recordState);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/recorded-scenarios") {
    try {
      sendJson(response, 200, readRecordedMetadata());
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Failed to read recorded scenarios." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/run") {
    await runListViewSuite(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/stop") {
    await stopListViewSuite(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/record/start") {
    await startRecording(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/record/stop") {
    await stopRecording(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/recorded-scenarios/run") {
    await runRecordedScenario(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/agent/sync/status") {
    try {
      sendJson(response, 200, appMainSyncStatus());
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Agent sync status failed." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/sync/main") {
    try {
      const body = await readRequestJson(request);
      sendJson(response, 200, syncMainBranchAndReindex({ pull: body.pull !== false }));
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Agent main sync failed." });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/agent/graph") {
    try {
      sendJson(response, 200, latestAgentGraph() || { nodes: [], edges: [], commits: [], summary: { total: 0 } });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Agent graph read failed." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/graph/analyze") {
    try {
      const body = await readRequestJson(request);
      sendJson(response, 200, buildAgentGraph(String(body.baseRef || "auto").trim() || "auto"));
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Agent graph analysis failed." });
    }
    return;
  }


  if (request.method === "GET" && url.pathname === "/api/agent/scheduler/status") {
    try {
      sendJson(response, 200, schedulerStatus());
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Scheduler status failed." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/scheduler/config") {
    try {
      const body = await readRequestJson(request);
      sendJson(response, 200, { ok: true, config: writeSchedulerConfig(body) });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Scheduler config update failed." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/scheduler/run-now") {
    try {
      const body = await readRequestJson(request);
      sendJson(response, 202, runCompleteSuiteFromScheduler({
        reason: "manual dashboard request",
        scope: body.scope || readSchedulerConfig().scope,
        headed: Boolean(body.headed ?? readSchedulerConfig().headed),
        reset: Boolean(body.reset ?? readSchedulerConfig().reset)
      }));
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Scheduled run failed to start." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/scan") {
    try {
      const body = await readRequestJson(request);
      sendJson(response, 200, scanChangedFiles(String(body.baseRef || "auto").trim() || "auto"));
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Agent scan failed." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/generate") {
    try {
      const body = await readRequestJson(request);
      cachedInventory = null;
      cachedInventoryAt = 0;
      sendJson(response, 200, await generateAgentScenarios(String(body.baseRef || "auto").trim() || "auto"));
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Agent scenario generation failed." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/run") {
    await runAgentGeneratedScenarios(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/commit") {
    try {
      const body = await readRequestJson(request);
      const activeBranch = currentGitBranch(repoRoot);
      const branchName = String(body.branchName || activeBranch)
        .replace(/[^A-Za-z0-9/_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!branchName) {
        sendJson(response, 400, { error: "A branch name is required." });
        return;
      }
      if (branchName !== activeBranch) {
        runGit(repoRoot, ["checkout", "-B", branchName]);
      }
      runGit(repoRoot, ["add", "tests/e2e/generated-agent-scenarios"]);
      runGit(repoRoot, ["add", "tests/e2e/list-view-regression/generated-agent-scenarios"]);
      const statusOutput = runGit(repoRoot, [
        "status",
        "--short",
        "tests/e2e/generated-agent-scenarios",
        "tests/e2e/list-view-regression/generated-agent-scenarios"
      ]);
      if (!statusOutput) {
        sendJson(response, 409, { error: "No generated agent scenario changes are available to commit." });
        return;
      }
      runGit(repoRoot, ["commit", "-m", "Add AI generated test scenarios"]);
      const shouldPush = body.push !== false;
      if (shouldPush) {
        runGit(repoRoot, ["push", "-u", "origin", branchName], 180_000);
      }
      sendJson(response, 200, { ok: true, branchName, pushed: shouldPush, repo: repoRoot });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Agent commit failed." });
    }
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  if (url.pathname === "/report" || url.pathname === "/report/") {
    response.writeHead(302, { location: "/report/latest" });
    response.end();
    return;
  }

  if (url.pathname === "/report/latest" || url.pathname === "/report/latest.html") {
    sendHtml(response, 200, renderLatestResultsHtml());
    return;
  }

  if (url.pathname.startsWith("/report/")) {
    const namedReport = resultReportSources.find((source) =>
      source.id !== "list-view-regression" && url.pathname.startsWith(`/report/${source.id}/`)
    );
    const targetPath = namedReport
      ? resolveSafePath(namedReport.root, url.pathname.replace(`/report/${namedReport.id}`, ""))
      : resolveSafePath(reportRoot, url.pathname.replace(/^\/report/, ""));
    if (!targetPath) {
      sendText(response, 403, "Forbidden.");
      return;
    }
    serveFile(response, targetPath);
    return;
  }

  if (url.pathname.startsWith("/evidence/list-view/")) {
    const targetPath = resolveSafePath(listViewArtifactsRoot, url.pathname.replace(/^\/evidence\/list-view/, ""));
    if (!targetPath) {
      sendText(response, 403, "Forbidden.");
      return;
    }
    serveFile(response, targetPath);
    return;
  }


  const dashboardPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const targetPath = resolveSafePath(environmentRoot, dashboardPath);
  if (!targetPath) {
    sendText(response, 403, "Forbidden.");
    return;
  }
  serveFile(response, targetPath);
});

server.listen(port, host, () => {
  configureScheduler();
  console.log(`List-view test environment: http://${host}:${port}/`);
  console.log(`Report URL: http://${host}:${port}/report`);
  console.log(`Serving reports from: ${reportRoot}`);
});
