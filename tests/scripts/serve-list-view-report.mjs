import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const reportRoot = path.resolve(repoRoot, "tests", "e2e", "reports", "list-view-regression");
const environmentRoot = path.resolve(repoRoot, "tests", "e2e", "list-view-test-environment");
const resultsJsonPath = path.join(reportRoot, "list-view-regression-results.json");
const port = Number(process.env.LIST_VIEW_REPORT_PORT || process.argv[2] || 5372);
const host = process.env.LIST_VIEW_REPORT_HOST || "127.0.0.1";

const allowedSurfaces = new Set(["all", "admin", "keystone", "api"]);
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
let cachedInventory = null;
let cachedInventoryAt = 0;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
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
  return JSON.parse(readFileSync(resultsJsonPath, "utf8"));
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseMeta = (title, key) => {
  const match = new RegExp(`\\[${key}:\\s*([^\\]]+)\\]`, "i").exec(title);
  return match ? match[1].trim() : "";
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

const readInventory = () => {
  const now = Date.now();
  if (cachedInventory && now - cachedInventoryAt < 5 * 60 * 1000) {
    return cachedInventory;
  }

  const config = "tests/e2e/playwright.list-view-regression.config.ts";
  const result = spawnSync("npx.cmd", ["playwright", "test", "--list", "-c", config], {
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
    rows.push({
      id: `CASE_${String(rows.length + 1).padStart(3, "0")}`,
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

  if (request.method === "POST" && url.pathname === "/api/run") {
    await runListViewSuite(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/stop") {
    await stopListViewSuite(request, response);
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
