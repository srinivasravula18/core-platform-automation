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
const storageStatePath = path.join(repoRoot, "tests", "e2e", ".storage", "list-view.json");
const port = Number(process.env.LIST_VIEW_REPORT_PORT || process.argv[2] || 5372);
const host = process.env.LIST_VIEW_REPORT_HOST || "127.0.0.1";
const gitNexusHost = process.env.GITNEXUS_HOST || "127.0.0.1";
const gitNexusPort = Number(process.env.GITNEXUS_PORT || 4747);

const allowedSurfaces = new Set(["all", "admin", "keystone", "api"]);
const recordableSurfaces = new Map([
  ["admin", { label: "Admin", url: process.env.ADMIN_BASE_URL || "http://localhost:5002" }],
  ["keystone", { label: "Keystone", url: process.env.TEST_BASE_URL || process.env.TEST_UI_URL || "http://localhost:5003" }]
]);
const frameworkRegistry = {
  appRoot,
  hierarchy: ["Test Suite", "Test Scenario", "Test Case", "Test Steps", "Evidence", "Bug Report"],
  suites: [
    {
      id: "list-view-regression",
      label: "List View Regression",
      surface: "all",
      description: "Full Admin, Keystone/Shockwave, and API list-view regression coverage.",
      tags: ["bvt", "sanity", "regression", "e2e"]
    },
    {
      id: "admin-list-view",
      label: "Admin List View",
      surface: "admin",
      description: "Metadata administration list views, settings, lifecycle, recycle bin, and workflow coverage.",
      tags: ["admin", "metadata", "list-view"]
    },
    {
      id: "keystone-list-view",
      label: "Keystone / Shockwave List View",
      surface: "keystone",
      description: "Business object list views, toolbar behavior, navigation, edits, exports, and recycle-bin flows.",
      tags: ["shockwave", "records", "list-view"]
    },
    {
      id: "list-view-api",
      label: "List View API",
      surface: "api",
      description: "Backend list-view metadata, query, export, validation, security, and bulk-action contract tests.",
      tags: ["api", "contract", "security"]
    }
  ],
  scenarios: [
    { id: "shell-toolbar", suiteId: "list-view-regression", label: "Shell and toolbar", grep: "List view shell|Object home|Toolbar controls|primary toolbar", description: "Core page load and toolbar controls." },
    { id: "search", suiteId: "list-view-regression", label: "Search", grep: "Search|Search navigation|Search empty state", description: "Search input, matching rows, empty states, and recovery." },
    { id: "settings", suiteId: "list-view-regression", label: "Settings", grep: "Settings modal|Filters|Columns|Sharing|Preferences|Hierarchy", description: "List-view configuration panels and validation." },
    { id: "table-ops", suiteId: "list-view-regression", label: "Table operations", grep: "Column resize|Column sizing|Sorting|View modes", description: "Resize, fit, sort, and view mode transitions." },
    { id: "navigation", suiteId: "list-view-regression", label: "Row navigation", grep: "Record navigation|Metadata boundary|Embedded list view|row opens|row can be selected", description: "Row selection, record navigation, and embedded list views." },
    { id: "lifecycle", suiteId: "list-view-regression", label: "Lifecycle and recycle bin", grep: "@lifecycle|@recycle|Bulk delete", description: "Safe disposable create, delete, recycle-bin, and cleanup flows." },
    { id: "workflow", suiteId: "list-view-regression", label: "Multi-step workflows", grep: "@workflow", description: "Connected user journeys that prove end-to-end task continuity." },
    { id: "exports", suiteId: "list-view-regression", label: "Exports", grep: "Export|CSV|PDF", description: "CSV and PDF exports from UI and API paths." },
    { id: "api-security", suiteId: "list-view-api", label: "API, validation, security", grep: "Security|Validation|Failure state|API", description: "Backend boundaries, invalid input, and permission-sensitive paths." }
  ],
  caseFormat: [
    { key: "suite", label: "Test Suite", description: "A runnable surface or module such as Admin, Keystone, API, or a feature pack." },
    { key: "scenario", label: "Test Scenario", description: "A user or system behavior group, usually matching a product workflow." },
    { key: "case", label: "Test Case", description: "A single verifiable behavior with preconditions, priority, level, and expected outcome." },
    { key: "steps", label: "Test Steps", description: "Concrete navigation and actions that the automation performs." },
    { key: "evidence", label: "Evidence", description: "Screenshots, assertions, logs, and generated bug summaries for failed cases." }
  ]
};
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

const proxyGitNexus = (request, response, url) => {
  const upstreamPath = `${url.pathname.replace(/^\/gitnexus/, "") || "/"}${url.search}`;
  const upstream = httpRequest(
    {
      hostname: gitNexusHost,
      port: gitNexusPort,
      path: upstreamPath,
      method: request.method,
      headers: { ...request.headers, host: `${gitNexusHost}:${gitNexusPort}` }
    },
    (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers };
      delete headers["content-security-policy"];
      response.writeHead(upstreamResponse.statusCode || 502, headers);
      upstreamResponse.on("error", () => {
        if (!response.destroyed) response.destroy();
      });
      upstreamResponse.pipe(response);
    }
  );
  upstream.on("error", (error) => {
    if (response.headersSent || response.writableEnded) {
      if (!response.destroyed) response.destroy();
      return;
    }
    sendText(response, 502, `GitNexus graph service is not available through the dashboard proxy. ${error.message}`);
  });
  request.on("aborted", () => {
    upstream.destroy();
  });
  response.on("close", () => {
    upstream.destroy();
  });
  request.pipe(upstream);
};

const gitNexusApiPrefixes = [
  "/api/repos",
  "/api/repo",
  "/api/graph",
  "/api/query",
  "/api/search",
  "/api/grep",
  "/api/file",
  "/api/analyze",
  "/api/embed",
  "/api/heartbeat",
  "/api/mcp"
];

const isGitNexusApiPath = (pathname) => gitNexusApiPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

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

const readResults = () => {
  if (!existsSync(resultsJsonPath)) {
    return {
      runStatus: "not_started",
      updatedAt: null,
      total: 0,
      counts: { PENDING: 0, RUNNING: 0, PASS: 0, FAIL: 0, SKIP: 0 },
      rows: []
    };
  }
  const payload = JSON.parse(readFileSync(resultsJsonPath, "utf8"));
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
    const counts = normalizedRows.reduce(
      (acc, row) => {
        if (acc[row.status] !== undefined) acc[row.status] += 1;
        return acc;
      },
      { PENDING: 0, RUNNING: 0, PASS: 0, FAIL: 0, SKIP: 0 }
    );
    const normalizedPayload = {
      ...payload,
      runStatus: runState.stopRequested ? "stopped" : "interrupted",
      counts,
      rows: normalizedRows
    };
    writeFileSync(resultsJsonPath, JSON.stringify(normalizedPayload, null, 2), "utf8");
    return normalizedPayload;
  }
  const isDiscoveryOnlyResult =
    !runState.running &&
    rows.length > 0 &&
    rows.every((row) => row?.status === "PENDING" && /^not run\.?$/i.test(String(row?.actualResult || "")));
  if (isDiscoveryOnlyResult) {
    return {
      runStatus: "not_started",
      updatedAt: payload.updatedAt ?? null,
      total: 0,
      counts: { PENDING: 0, RUNNING: 0, PASS: 0, FAIL: 0, SKIP: 0 },
      rows: []
    };
  }
  return payload;
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

const addRecordedEvidenceHooks = (source) => {
  let nextSource = source;
  if (!/attachEvidence/.test(nextSource)) {
    nextSource = nextSource.replace(
      /import\s+\{\s*test\s*(,\s*expect\s*)?\}\s+from\s+['"]@playwright\/test['"];?/,
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
    finalSource = `import { test } from '@playwright/test';\n\ntest(\`${escapeJsString(title)}\`, async ({ page }) => {\n  await page.goto('${recordState.url}');\n});\n`;
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

const syncMainBranchAndReindex = ({ pull = true } = {}) => {
  const sync = syncMainBranch({ pull });
  let gitNexus = null;
  try {
    gitNexus = runGitNexusAnalyze();
    writeAgentState({
      lastGraphCommit: sync.after?.headCommit || sync.after?.remoteMainCommit || "",
      lastGitNexusReindexAt: gitNexus.analyzedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    gitNexus = {
      ok: false,
      available: tryGitNexusGraph().available,
      error: error instanceof Error ? error.message : "GitNexus reindex failed after main sync.",
      analyzedAt: new Date().toISOString()
    };
    writeAgentState({
      lastGitNexusReindexError: gitNexus.error,
      updatedAt: new Date().toISOString()
    });
  }
  return {
    ...sync,
    gitNexus,
    graphReady: Boolean(gitNexus?.ok)
  };
};

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

const tryGitNexusGraph = () => {
  const candidates = process.platform === "win32"
    ? [
        path.join(process.env.APPDATA || "", "npm", "gitnexus.cmd"),
        path.join("C:\\Users\\bdevi\\AppData\\Roaming\\npm", "gitnexus.cmd"),
        "gitnexus.cmd",
        "gitnexus"
      ]
    : ["gitnexus"];
  for (const command of candidates) {
    if (path.isAbsolute(command) && !existsSync(command)) continue;
    const result = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", command, "--help"], {
          cwd: appRoot,
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true
        })
      : spawnSync(command, ["--help"], {
      cwd: appRoot,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true
    });
    if (!result.error && result.status === 0) {
      return {
        available: true,
        command,
        note: "GitNexus CLI is available. Reindex refreshes the local knowledge graph; the dashboard renders the current commit impact graph."
      };
    }
  }
  return {
    available: false,
    command: "",
    note: "GitNexus CLI was not found on PATH, so the graph falls back to git diff, commit log, and path dependency heuristics."
  };
};

const runGitNexusAnalyze = () => {
  const gitNexus = tryGitNexusGraph();
  if (!gitNexus.available) {
    return {
      ok: false,
      available: false,
      message: "GitNexus CLI is not installed on PATH. Install it with npm install -g gitnexus, then run Analyze Graph again."
    };
  }
  const analyzeArgs = ["analyze", appRoot, "--index-only", "--worker-timeout", "120", "--max-file-size", "256"];
  const result = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", gitNexus.command, ...analyzeArgs], {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 10 * 60_000,
        windowsHide: true
      })
    : spawnSync(gitNexus.command, analyzeArgs, {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 10 * 60_000,
        windowsHide: true
      });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(output || `GitNexus analyze exited ${result.status}`);
  }
  return {
    ok: true,
    available: true,
    command: `${gitNexus.command} ${analyzeArgs.join(" ")}`,
    output: output.slice(-12_000),
    analyzedAt: new Date().toISOString()
  };
};

const ensureGitNexusNativeServer = async () => {
  const probe = await probeHttp("GitNexus", gitNexusPort, "/api/repos");
  if (probe.ok) return { ok: true, alreadyRunning: true };
  const gitNexus = tryGitNexusGraph();
  if (!gitNexus.available) return { ok: false, error: "GitNexus CLI is not available." };
  const runtimeRoot = path.join(repoRoot, ".runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const outLog = path.join(runtimeRoot, "gitnexus-serve.out.log");
  const errLog = path.join(runtimeRoot, "gitnexus-serve.err.log");
  const args = ["serve", "--host", gitNexusHost, "--port", String(gitNexusPort)];
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", gitNexus.command, ...args], {
        cwd: appRoot,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"]
      })
    : spawn(gitNexus.command, args, {
        cwd: appRoot,
        detached: true,
        stdio: ["ignore", "ignore", "ignore"]
      });
  child.unref();
  writeFileSync(path.join(runtimeRoot, "gitnexus-serve.pid"), String(child.pid || ""), "utf8");
  writeFileSync(outLog, "GitNexus native server started by dashboard.\n", "utf8");
  writeFileSync(errLog, "", "utf8");
  return { ok: true, started: true, pid: child.pid };
};

const parseMcpSseJson = (text) => {
  const dataLines = String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, ""));
  const payload = dataLines.join("\n").trim() || String(text || "").trim();
  if (!payload) return {};
  return JSON.parse(payload);
};

const mcpResultText = (payload) => {
  const content = payload?.result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
};

const gitNexusMcpPost = async (body, sessionId = "", timeoutMs = 45_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${gitNexusHost}:${gitNexusPort}/api/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const payload = parseMcpSseJson(text);
    if (!response.ok || payload?.error) {
      throw new Error(payload?.error?.message || text || `GitNexus MCP failed with HTTP ${response.status}`);
    }
    return {
      payload,
      sessionId: response.headers.get("mcp-session-id") || sessionId
    };
  } finally {
    clearTimeout(timer);
  }
};

const createGitNexusMcpSession = async () => {
  await ensureGitNexusNativeServer();
  const initialized = await gitNexusMcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "core-platform-test-agent", version: "1.0.0" }
    }
  });
  return {
    sessionId: initialized.sessionId,
    nextId: 2,
    serverInfo: initialized.payload?.result?.serverInfo || null
  };
};

const callGitNexusMcpTool = async (session, name, args = {}, timeoutMs = 8_000) => {
  let lastResult = null;
  for (let attempt = 0; attempt < 1; attempt += 1) {
    const requestId = session.nextId++;
    const { payload } = await gitNexusMcpPost({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name, arguments: args }
    }, session.sessionId, timeoutMs);
    lastResult = {
      payload,
      text: mcpResultText(payload).slice(0, 14_000)
    };
    if (!isGitNexusStoreBusy(lastResult.text)) return lastResult;
    await wait(400 * (attempt + 1));
  }
  return lastResult;
};

const parseGitNexusRepos = (text) => {
  const match = String(text || "").match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
};

const chooseGitNexusRepo = (repos) => {
  const normalizedAppRoot = appRoot.toLowerCase().replace(/\\/g, "/");
  return repos.find((repo) => String(repo.path || "").toLowerCase().replace(/\\/g, "/") === normalizedAppRoot)
    || repos.find((repo) => repo.name === "core-platform")
    || repos[0]
    || { name: "core-platform" };
};

const compactMcpSummary = (text) => String(text || "")
  .replace(/\r/g, "")
  .replace(/\n{3,}/g, "\n\n")
  .slice(0, 10_000);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isGitNexusStoreBusy = (text) => /LadybugDB unavailable|process has locked|Error 33|rebuilding the index/i.test(String(text || ""));
const isGitNexusToolFailure = (text) => !String(text || "").trim() || /LadybugDB unavailable|process has locked|Error 33|rebuilding the index|operation was aborted|^Error:/i.test(String(text || "").trim());

const cypherString = (value) => JSON.stringify(String(value || "").replace(/\\/g, "/"));

const buildGitNexusAgentContext = async (scan) => {
  const availability = tryGitNexusGraph();
  if (!availability.available) {
    return {
      available: false,
      source: "unavailable",
      note: availability.note,
      error: "GitNexus CLI is not available."
    };
  }

  try {
    const session = await createGitNexusMcpSession();
    const reposResult = await callGitNexusMcpTool(session, "list_repos", {}, 30_000);
    const repos = parseGitNexusRepos(reposResult.text);
    const repo = chooseGitNexusRepo(repos);
    const repoName = repo.name || "core-platform";
    const detect = await callGitNexusMcpTool(session, "detect_changes", {
      scope: "compare",
      base_ref: scan.baseRef,
      repo: repoName
    }, 8_000).catch((error) => ({ text: "", error: error.message }));

    const files = [];
    const priorityChanges = [...scan.changedFiles]
      .sort((left, right) => (right.risk === "High" ? 1 : 0) - (left.risk === "High" ? 1 : 0))
      .slice(0, 3);
    for (const change of priorityChanges) {
      const details = {
        path: change.path,
        area: change.area,
        risk: change.risk,
        tools: []
      };
      const filePath = cypherString(change.path);
      const neighborhoodQuery = [
        `MATCH (f:File {filePath: ${filePath}})-[r:CodeRelation]-(n)`,
        "RETURN labels(n) AS labels, n.name AS name, n.filePath AS filePath, r.type AS relation",
        "LIMIT 30"
      ].join(" ");
      const neighbors = await callGitNexusMcpTool(session, "cypher", {
        repo: repoName,
        query: neighborhoodQuery
      }, 4_000).catch((error) => ({ text: "", error: error.message }));
      details.neighborhood = compactMcpSummary(neighbors.text || neighbors.error || "");
      details.tools.push("cypher");

      if (/routes?|api|service|server|controller|handler/i.test(change.path)) {
        const apiImpact = await callGitNexusMcpTool(session, "api_impact", {
          repo: repoName,
          file: change.path
        }, 5_000).catch((error) => ({ text: "", error: error.message }));
        details.apiImpact = compactMcpSummary(apiImpact.text || apiImpact.error || "");
        details.tools.push("api_impact");
      }

      files.push(details);
    }

    const toolTexts = [
      detect.text || detect.error || "",
      ...files.flatMap((file) => [file.neighborhood || "", file.apiImpact || "", file.executionFlows || ""])
    ];
    const busyCount = toolTexts.filter(isGitNexusStoreBusy).length;
    const usableCount = toolTexts.filter((text) => !isGitNexusToolFailure(text)).length;
    const graphUsable = usableCount > 0 || (files.length === 0 && !isGitNexusStoreBusy(detect.text || detect.error || ""));

    return {
      available: graphUsable,
      connected: true,
      source: "gitnexus-mcp",
      serverInfo: session.serverInfo,
      repo: repoName,
      repoPath: repo.path || appRoot,
      indexedAt: repo.indexedAt || "",
      indexedCommit: repo.lastCommit || "",
      staleness: repo.staleness || null,
      error: graphUsable ? "" : "GitNexus MCP connected, but the local graph store is locked or rebuilding. Reindex/graph load should finish before graph-aware generation.",
      busyToolCalls: busyCount,
      generatedAt: new Date().toISOString(),
      detectChanges: compactMcpSummary(detect.text || detect.error || ""),
      files
    };
  } catch (error) {
    return {
      available: false,
      source: "gitnexus-mcp",
      note: "GitNexus MCP enrichment failed; agent fell back to git diff and inventory matching.",
      error: error instanceof Error ? error.message : "GitNexus MCP enrichment failed."
    };
  }
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
    gitNexus: tryGitNexusGraph(),
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
    steps: [
      `Open the affected ${change.area} surface.`,
      `Navigate to the screen or API path related to ${change.path}.`,
      "Exercise the changed behavior with seeded data and one edge-case input.",
      "Capture evidence and assert no crash, permission leak, or invalid state."
    ].join(" | "),
    expected: "The changed behavior works as intended, existing list-view contracts remain stable, and any invalid input is handled visibly.",
    risk: change.risk,
    sourcePath: change.path
  };
};

const tagForRisk = (risk) => (risk === "High" ? "@bvt" : risk === "Medium" ? "@sanity" : "@regression");
const levelForTag = (tag) => (tag === "@bvt" ? "BVT" : tag === "@sanity" ? "Sanity" : "Regression");

const routeLikeChange = (change, graphContext) =>
  /routes?|api|service|server|controller|handler/i.test(change.path)
  || Boolean(graphContext?.apiImpact && !isGitNexusToolFailure(graphContext.apiImpact));

const securityLikeChange = (change) => /auth|permission|access|role|policy|security/i.test(change.path);
const validationLikeChange = (change) => /validation|schema|field|form|modal|constraint|input/i.test(change.path);
const mutationLikeChange = (change) => /create|update|edit|delete|bulk|recycle|restore|purge|workflow|lifecycle|mutation|routes?/i.test(change.path);
const uiLikeChange = (change) => /apps\/admin|apps\/shockwave|packages\/ui|component|hook|page|layout|modal|panel|view|screen/i.test(change.path.replace(/\\/g, "/"));

const graphEvidenceForScenario = (graphContext) => {
  if (!hasUsableGitNexusFileContext(graphContext)) return "";
  const evidence = [];
  if (graphContext?.apiImpact && !isGitNexusToolFailure(graphContext.apiImpact)) evidence.push("api_impact");
  if (graphContext?.neighborhood && !isGitNexusToolFailure(graphContext.neighborhood)) evidence.push("file_neighbors");
  if (graphContext?.executionFlows && !isGitNexusToolFailure(graphContext.executionFlows)) evidence.push("execution_flows");
  return evidence.join(", ");
};

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

const applicationScenarioTemplates = (change, index, graphContext, gitNexusContext) => {
  const base = scenarioForChange(change, index);
  const feature = inferFeatureForChange(change);
  const graphEvidence = graphEvidenceForScenario(graphContext);
  const graphSource = graphEvidence
    ? gitNexusContext?.source || "gitnexus-mcp"
    : gitNexusContext?.connected
      ? "gitnexus-mcp-busy"
      : "git-diff";
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
    gitNexus: graphContext || null,
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
      steps: surface === "api"
        ? `Authenticate through the API. | Exercise the route family related to ${change.path}. | Assert a valid authenticated response.`
        : `Sign in to ${surfaceLabel}. | Open the impacted application shell or screen related to ${change.path}. | Assert the shell renders without auth, permission, or crash failures.`,
      expected: "The critical impacted surface remains reachable and authenticated behavior is intact.",
      proof: graphEvidence ? `GitNexus MCP evidence (${graphEvidence}) identifies this as critical impact.` : `Critical smoke coverage for ${change.path}.`
    });
  }

  pushTemplate({
    scenarioFamily: "Sanity",
    level: "Sanity",
    tag: "@sanity",
    testCase: `Sanity verifies ${feature.toLowerCase()} happy path after ${path.basename(change.path)}`,
    steps: `Open the impacted ${surfaceLabel} feature. | Exercise the primary user or API path related to ${change.path}. | Capture evidence after the happy path completes.`,
    expected: "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    proof: graphEvidence ? `GitNexus MCP evidence (${graphEvidence}) links the change to this feature path.` : `Focused sanity coverage for ${change.path}.`
  });

  if (validationLikeChange(change) || securityLikeChange(change) || routeLikeChange(change, graphContext)) {
    pushTemplate({
      scenarioFamily: securityLikeChange(change) ? "Security" : "Validation",
      level: securityLikeChange(change) ? "BVT" : "Sanity",
      tag: securityLikeChange(change) ? "@bvt" : "@sanity",
      testCase: `${securityLikeChange(change) ? "Security" : "Validation"} checks guarded behavior after ${path.basename(change.path)}`,
      steps: `Open the impacted ${surfaceLabel} feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.`,
      expected: "Invalid or unauthorized input is rejected with a safe error state and no crash.",
      proof: graphEvidence ? `GitNexus MCP evidence (${graphEvidence}) indicates guarded logic impact.` : `Guarded behavior coverage for ${change.path}.`
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
      steps: `Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to ${change.path}. | Verify cleanup or reset restores seeded state.`,
      expected: "The write flow works on seeded/disposable data and the reset path can restore the local dataset.",
      proof: graphEvidence ? `GitNexus MCP evidence (${graphEvidence}) identifies mutation or lifecycle impact.` : `Guarded mutation regression coverage for ${change.path}.`
    });
  }

  pushTemplate({
    scenarioFamily: "Regression",
    level: "Regression",
    tag: "@regression",
    testCase: `Regression protects downstream ${feature.toLowerCase()} behavior after ${path.basename(change.path)}`,
    steps: `Open a downstream ${surfaceLabel} workflow connected to ${change.path}. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.`,
    expected: "Connected downstream behavior remains stable after the code change.",
    proof: graphEvidence ? `GitNexus MCP evidence (${graphEvidence}) provides downstream relationship context.` : `Downstream regression coverage for ${change.path}.`
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

const callGeminiPlanner = async (scan, inventoryRows, gitNexusContext = null) => {
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
    "- When GitNexus MCP context is available, treat it as the primary source for execution flows, route consumers, business logic links, and blast radius.",
    "- Do not duplicate tests. If an existing test is enough, action must be reuse and include existingTestIds.",
    "- Generate only when missing coverage is clear.",
    "- This is application-wide coverage, not list-view-only coverage. Consider Admin, Keystone/Shockwave, API/service, metadata, shared UI, permissions, records, workflows, and business logic.",
    "- Prefer multiple scenario families for a single impacted feature when GitNexus shows different route, UI, workflow, or security blast radius.",
    "- Generate API-level tests when route handlers, response shape, middleware, or API consumers changed.",
    "- Generate UI-level tests when GitNexus shows an affected screen, component, hook, or process not covered by existing tests.",
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
      gitNexusContext,
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
      input: scenario.steps || "",
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

const hasUsableGitNexusFileContext = (context) => Boolean(context) && [
  context.neighborhood,
  context.apiImpact,
  context.executionFlows
].some((text) => !isGitNexusToolFailure(text));

const generateAgentSpecSource = (scenarios) => {
  const cases = JSON.stringify(scenarios, null, 2);
  return `import { expect, test } from "@playwright/test";
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
  const gitNexusContext = await buildGitNexusAgentContext(scan);
  let geminiPlan = null;
  try {
    geminiPlan = await callGeminiPlanner(scan, inventoryRows, gitNexusContext);
  } catch (error) {
    geminiPlan = {
      model: geminiModel,
      error: error instanceof Error ? error.message : "Gemini planner failed.",
      decisions: []
    };
  }
  const decisionByPath = new Map((geminiPlan?.decisions || []).map((decision) => [decision.sourcePath, decision]));
  const graphContextByPath = new Map((gitNexusContext?.files || []).map((file) => [file.path, file]));
  const scenarios = scan.changedFiles.flatMap((change, index) => {
    const modelDecision = decisionByPath.get(change.path) || null;
    const graphContext = graphContextByPath.get(change.path) || null;
    return applicationScenarioTemplates(change, index, graphContext, gitNexusContext).map((template) => {
      const tag = modelDecision?.tag && template.scenarioFamily === "Sanity" ? modelDecision.tag : template.tag;
      const level = modelDecision?.level && template.scenarioFamily === "Sanity" ? modelDecision.level : template.level || levelForTag(tag);
      const draft = {
        ...template,
        feature: template.scenarioFamily === "Sanity" ? modelDecision?.feature || template.feature : template.feature,
        level,
        tag,
        testCase: template.scenarioFamily === "Sanity" ? modelDecision?.testCase || template.testCase : template.testCase,
        steps: template.scenarioFamily === "Sanity" ? modelDecision?.steps || template.steps : template.steps,
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
      gitNexus: {
        source: gitNexusContext?.source || "none",
        available: Boolean(gitNexusContext?.available),
        connected: Boolean(gitNexusContext?.connected || gitNexusContext?.available),
        repo: gitNexusContext?.repo || "",
        indexedCommit: gitNexusContext?.indexedCommit || "",
        staleness: gitNexusContext?.staleness || null,
        error: gitNexusContext?.error || ""
      }
    },
    appRoot,
    gitNexusContext,
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

  const config = "tests/e2e/playwright.list-view-regression.config.ts";
  const result = spawnSync("cmd", ["/c", "npx.cmd", "playwright", "test", "--list", "-c", config, "--reporter=list"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const marker = " › ";
    if (!line.includes(marker) || !/\.(spec|test)\.ts:\d+:\d+/.test(line)) continue;
    const trimmed = line.trim();
    const location = trimmed.split(marker)[0].trim();
    const parts = trimmed.split(marker);
    const title = parts[parts.length - 1].trim();
    const spec = location.replace(/:\d+:\d+$/, "");
    const surface = inferSurface(spec, title);
    const feature = parseMeta(title, "feature") || "List View";
    const level = inferTestingLevel(parseMeta(title, "level"), title);
    const identity = caseIdentity(feature, level, rows.length);
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
      precondition: parseMeta(title, "precondition"),
      input: parseMeta(title, "input"),
      expected: parseMeta(title, "expected"),
      proof: parseMeta(title, "proof")
    });
  }
  if (rows.length === 0 && existsSync(resultsJsonPath)) {
    const previous = readResults();
    for (const row of previous.rows ?? []) {
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
        input: row.inputAction || "",
        expected: row.expectedResult || "",
        proof: row.proof || ""
      });
    }
  }
  const existingInventoryKeys = new Set(rows.map((row) => `${row.title}::${row.spec}`));
  for (const generatedRow of readGeneratedAgentInventoryRows(rows.length)) {
    const key = `${generatedRow.title}::${generatedRow.spec}`;
    if (existingInventoryKeys.has(key)) continue;
    existingInventoryKeys.add(key);
    rows.push(generatedRow);
  }
  cachedInventory = {
    updatedAt: new Date().toISOString(),
    total: rows.length,
    rows,
    error: result.error ? result.error.message : result.status === 0 ? "" : output.slice(-1000)
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

  if (url.pathname === "/gitnexus" || url.pathname.startsWith("/gitnexus/")) {
    proxyGitNexus(request, response, url);
    return;
  }

  if (isGitNexusApiPath(url.pathname)) {
    proxyGitNexus(request, response, url);
    return;
  }

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
      sendJson(response, 200, latestAgentGraph() || { nodes: [], edges: [], commits: [], summary: { total: 0 }, gitNexus: tryGitNexusGraph() });
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

  if (request.method === "POST" && url.pathname === "/api/agent/graph/reindex") {
    try {
      const result = runGitNexusAnalyze();
      sendJson(response, result.ok ? 200 : 409, {
        ...result,
        error: result.ok ? "" : result.message || "GitNexus CLI is not available."
      });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "GitNexus reindex failed." });
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
    response.writeHead(302, { location: "/report/list-view-regression-results.html" });
    response.end();
    return;
  }

  if (url.pathname.startsWith("/report/")) {
    const targetPath = resolveSafePath(reportRoot, url.pathname.replace(/^\/report/, ""));
    if (!targetPath) {
      sendText(response, 403, "Forbidden.");
      return;
    }
    serveFile(response, targetPath);
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    const localAssetPath = resolveSafePath(environmentRoot, url.pathname);
    if (!localAssetPath || !existsSync(localAssetPath)) {
      proxyGitNexus(request, response, url);
      return;
    }
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
  ensureGitNexusNativeServer().catch((error) => {
    console.error(`GitNexus native server start failed: ${error instanceof Error ? error.message : "unknown error"}`);
  });
  console.log(`List-view test environment: http://${host}:${port}/`);
  console.log(`Report URL: http://${host}:${port}/report`);
  console.log(`Serving reports from: ${reportRoot}`);
});
