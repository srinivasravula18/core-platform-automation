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
const appRoot = path.resolve(process.env.CORE_PLATFORM_ROOT || "D:\\core-platform");
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const resultsJsonPath = path.join(reportRoot, "list-view-regression-results.json");
const storageStatePath = path.join(repoRoot, "tests", "e2e", ".storage", "list-view.json");
const port = Number(process.env.LIST_VIEW_REPORT_PORT || process.argv[2] || 5372);
const host = process.env.LIST_VIEW_REPORT_HOST || "127.0.0.1";

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
    return { baselineCommit: "", updatedAt: null, history: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(agentStatePath, "utf8"));
    return {
      baselineCommit: parsed.baselineCommit || "",
      updatedAt: parsed.updatedAt || null,
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch {
    return { baselineCommit: "", updatedAt: null, history: [] };
  }
};

const writeAgentState = (nextState) => {
  mkdirSync(generatedRoot, { recursive: true });
  writeFileSync(agentStatePath, JSON.stringify(nextState, null, 2), "utf8");
  return nextState;
};

const currentAppCommit = () => runGit(appRoot, ["rev-parse", "HEAD"]);

const resolveAgentBaseRef = (baseRef = "") => {
  const requested = String(baseRef || "").trim();
  if (requested && requested !== "auto") return requested;
  const state = readAgentState();
  return state.baselineCommit || "HEAD~1";
};

const scanChangedFiles = (baseRef = "auto") => {
  if (!existsSync(path.join(appRoot, ".git"))) {
    throw new Error(`Application repo was not found at ${appRoot}.`);
  }
  const resolvedBaseRef = resolveAgentBaseRef(baseRef);
  const headCommit = currentAppCommit();
  let output = "";
  try {
    output = runGit(appRoot, ["diff", "--name-status", `${resolvedBaseRef}...HEAD`]);
  } catch {
    output = runGit(appRoot, ["diff", "--name-status", resolvedBaseRef]);
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
    headCommit,
    previousBaselineCommit: readAgentState().baselineCommit || "",
    scannedAt: new Date().toISOString(),
    summary,
    changedFiles
  };
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

const changedFileDiff = (baseRef, filePath) => {
  try {
    return runGit(appRoot, ["diff", "--unified=80", `${baseRef}...HEAD`, "--", filePath], 60_000).slice(0, 18_000);
  } catch {
    try {
      return runGit(appRoot, ["diff", "--unified=80", baseRef, "--", filePath], 60_000).slice(0, 18_000);
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
    diff: changedFileDiff(scan.baseRef, change.path)
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

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
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
  );
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

const specTitle = (scenario) =>
  `${scenario.tag || tagForRisk(scenario.risk)} ${scenario.testCase} [surface: ${scenario.surfaceLabel || scenario.surface}] [feature: ${scenario.feature}] [level: ${scenario.level || "Regression"}] [precondition: ${scenario.precondition}] [input: ${scenario.steps}] [expected: ${scenario.expected}] [proof: ${scenario.proof}]`;

const generateAgentSpecSource = (scenarios) => {
  const cases = JSON.stringify(scenarios.filter((scenario) => scenario.action === "generate"), null, 2);
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

      if (generatedCase.surface === "api") {
        const token = await apiLogin(request);
        const response = await request.get("/api/apps", {
          headers: { Authorization: \`Bearer \${token}\` }
        });
        expect(response.ok(), await response.text()).toBeTruthy();
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
  const scenarios = scan.changedFiles.map((change, index) => {
    const scenario = scenarioForChange(change, index);
    const modelDecision = decisionByPath.get(change.path) || null;
    const surface =
      scenario.surface === "api" || scenario.surface === "keystone" || scenario.surface === "admin"
        ? scenario.surface
        : /api|route|server|backend|service|schema|migration/i.test(change.path)
          ? "api"
          : /keystone|object-home|launcher|tab/i.test(change.path)
            ? "keystone"
          : "admin";
    const feature = scenario.scenario.replace(/\s+regression[\s\S]*$/i, "") || scenario.area || "Change Impact";
    const tag = modelDecision?.tag || tagForRisk(change.risk);
    const level = modelDecision?.level || levelForTag(tag);
    const draft = {
      ...scenario,
      surface,
      surfaceLabel: surface === "api" ? "API" : surface === "keystone" ? "Keystone" : "Admin",
      feature: modelDecision?.feature || feature,
      level,
      tag,
      testCase: modelDecision?.testCase || scenario.testCase,
      steps: modelDecision?.steps || scenario.steps,
      expected: modelDecision?.expected || scenario.expected,
      adminScreen: modelDecision?.adminScreen || (/object/i.test(change.path) ? "Objects" : /role|permission|access/i.test(change.path) ? "Permissions" : "Apps"),
      proof: modelDecision?.proof || `generated smoke coverage for ${change.path}`,
      evidenceName: `agent-${scenario.id.toLowerCase()}`
    };
    const modelExistingTests = Array.isArray(modelDecision?.existingTestIds)
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
    const action = modelDecision?.action === "generate" ? "generate" : existingTests.length > 0 ? "reuse" : "generate";
    return {
      ...draft,
      action,
      existingTests,
      decision: modelDecision?.reason || (existingTests.length > 0
        ? `Existing ${existingTests[0].id} covers the changed feature area; reuse it instead of duplicating.`
        : `No close existing coverage found; generate a new ${tag} test.`),
      planner: geminiPlan?.decisions?.length ? "gemini" : "rules",
      title: specTitle(draft)
    };
  });
  mkdirSync(generatedRoot, { recursive: true });
  mkdirSync(generatedSpecRoot, { recursive: true });
  const timestamp = Date.now();
  const specPath = path.join(generatedSpecRoot, `agent-generated-${timestamp}.spec.ts`);
  const specRelativePath = path.relative(repoRoot, specPath).replace(/\\/g, "/");
  const generatedCount = scenarios.filter((scenario) => scenario.action === "generate").length;
  const reusedCount = scenarios.filter((scenario) => scenario.action === "reuse").length;
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
      groundingMetadata: geminiPlan?.groundingMetadata || null
    },
    appRoot,
    spec: generatedCount > 0 ? specRelativePath : "",
    summary: {
      changedFiles: scan.changedFiles.length,
      generated: generatedCount,
      reused: reusedCount
    },
    scenarios
  };
  const outputPath = path.join(generatedRoot, `agent-scenarios-${timestamp}.json`);
  if (generatedCount > 0) {
    writeFileSync(specPath, generateAgentSpecSource(scenarios), "utf8");
  }
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2), "utf8");
  const state = readAgentState();
  writeAgentState({
    baselineCommit: scan.headCommit,
    updatedAt: artifact.generatedAt,
    lastArtifact: path.relative(repoRoot, outputPath).replace(/\\/g, "/"),
    lastSpec: artifact.spec,
    history: [
      {
        generatedAt: artifact.generatedAt,
        from: scan.baseRef,
        to: scan.headCommit,
        changedFiles: scan.changedFiles.length,
        generated: generatedCount,
        reused: reusedCount,
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

  let artifact = latestGeneratedArtifact();
  if (!artifact) {
    artifact = await generateAgentScenarios(String(body.baseRef || "auto").trim() || "auto");
  }
  if (!artifact.scenarios || artifact.scenarios.length === 0) {
    sendJson(response, 409, { error: "No changed files were found, so there are no generated agent scenarios to run." });
    return;
  }

  const headed = Boolean(body.headed);
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
  runState.selectedTestCount = runMode === "reuse" ? reusableTitles.length : artifact.scenarios.filter((scenario) => scenario.action === "generate").length;
  runState.reset = false;
  runState.headed = headed;
  runState.stopRequested = false;
  runState.startedAt = new Date().toISOString();
  runState.finishedAt = null;
  runState.exitCode = null;
  runState.logs = [];
  pushLog(
    runMode === "reuse"
      ? `Starting AI agent reused existing coverage run (${reusableTitles.length} case(s))...`
      : `Starting AI generated scenario run (${runState.selectedTestCount} case(s))...`
  );

  const childEnv = { ...process.env, LIST_VIEW_REGRESSION_HEADED: headed ? "1" : "0" };
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
    pushLog(
      runState.stopRequested
        ? `AI generated scenarios stopped with exit code ${runState.exitCode}.`
        : `AI generated scenarios finished with exit code ${runState.exitCode}.`
    );
    currentProcess = null;
  });

  sendJson(response, 202, { ok: true, artifact, state: runState });
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

  const dashboardPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const targetPath = resolveSafePath(environmentRoot, dashboardPath);
  if (!targetPath) {
    sendText(response, 403, "Forbidden.");
    return;
  }
  serveFile(response, targetPath);
});

server.listen(port, host, () => {
  console.log(`List-view test environment: http://${host}:${port}/`);
  console.log(`Report URL: http://${host}:${port}/report`);
  console.log(`Serving reports from: ${reportRoot}`);
});
