import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot, Bug, CheckSquare, ChevronDown, ChevronRight, ClipboardList, FileBarChart, GitBranch,
  Database, Download, FileSpreadsheet, LayoutDashboard, Moon, PanelLeftClose, PanelLeftOpen, Play, Plus, Radio, RefreshCw, Save, Search, Settings, Square, Sun,
  TestTube2, Trash2, Upload, Video, Waypoints, XCircle
} from "lucide-react";
import "./styles.css";

const navGroups = [
  {
    id: "dashboard",
    label: "Dashboard",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard }
    ]
  },
  {
    id: "test-management",
    label: "Test Management",
    items: [
      { id: "suites", label: "Suites", icon: TestTube2 },
      { id: "scenarios", label: "Scenarios", icon: Waypoints },
      { id: "test-plans", label: "Test Plans", icon: GitBranch },
      { id: "inventory", label: "Inventory", icon: ClipboardList }
    ]
  },
  {
    id: "execution",
    label: "Execution",
    items: [
      { id: "recorder", label: "Recorder", icon: Radio },
      { id: "execution", label: "Execution", icon: Play },
      { id: "reports", label: "Reports", icon: FileBarChart },
      { id: "bugs", label: "Bugs", icon: Bug }
    ]
  },
  {
    id: "automation",
    label: "Automation",
    items: [
      { id: "agent", label: "AI Agent", icon: Bot }
    ]
  },
  {
    id: "configuration",
    label: "Configuration",
    items: [
      { id: "settings", label: "Settings", icon: Settings }
    ]
  }
];
const navItems = navGroups.flatMap((group) => group.items);
const defaultOpenNavGroups = Object.fromEntries(navGroups.map((group) => [group.id, true]));

const formatDate = (value) => value ? new Date(value).toLocaleString() : "-";
const categoryLevels = ["BVT", "Sanity", "Regression"];
const summarizeScenario = (status) => {
  if (status?.selectedTestCount > 0) return `${status.selectedTestCount} selected test cases`;
  const scenario = String(status?.scenario || "").trim();
  if (!scenario) return "-";
  if (scenario.length > 80 || scenario.includes("\\[") || scenario.includes("|")) return "Filtered scenario run";
  return scenario;
};
const normalizeSurface = (value) => String(value || "").toLowerCase().replace(/[^a-z]/g, "");
const safeRegex = (value) => {
  try {
    return new RegExp(String(value || ""), "i");
  } catch {
    return null;
  }
};
const suiteMatchesRow = (suite, row) => {
  if (!suite) return true;
  const suiteId = String(suite.id || "").toLowerCase();
  const suiteSurface = normalizeSurface(suite.surface);
  const rowSurface = normalizeSurface(row.surface);
  const rowText = [row.title, row.tags, row.spec, row.surface, row.feature, row.displayTitle]
    .join(" ")
    .toLowerCase();
  const suiteGrep = String(suite.grep || "").trim();
  if (suiteGrep) {
    const regex = safeRegex(suiteGrep);
    if (regex) return regex.test(rowText);
    return rowText.includes(suiteGrep.toLowerCase());
  }
  if (suiteId === "admin-side-navbar") {
    return /from side nav|seed api contract is reachable|table\/search remains stable|seed readiness verifies all admin table anchors/i.test(rowText);
  }
  if (suiteId === "list-view-regression" || suiteSurface === "all") return true;
  if (suiteId.includes("admin") || suiteSurface === "admin") return rowSurface === "admin";
  if (suiteId.includes("keystone") || suiteSurface === "keystone") return rowSurface === "keystone";
  if (suiteId.includes("api") || suiteSurface === "api") return rowSurface === "api";
  return rowSurface === suiteSurface;
};

const stepChain = (steps) => steps.filter(Boolean).join(" -> ");

const normalizeStepText = (value) =>
  String(value || "")
    .replace(/\s*\|\s*/g, " -> ")
    .replace(/\s+/g, " ")
    .trim();

const stripBracketMeta = (value) =>
  String(value || "").replace(/\s*\[(surface|feature|level|priority|testdata|test data|automation|precondition|input|expected|proof):[^\]]+\]/gi, "");

const isAlreadyExpandedStep = (value) => {
  const lower = normalizeStepText(value).toLowerCase();
  return /^open (admin|keystone)?\s*application\b/.test(lower) || lower.startsWith("open application ->");
};

const isVagueStepText = (value) => {
  const lower = normalizeStepText(value).toLowerCase();
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

const adminScreenForSteps = (row) => {
  const text = [row.feature, row.displayTitle, row.title, row.spec].join(" ").toLowerCase();
  if (/permission|access|role|group|user|security/.test(text)) return "Permissions or Access Records";
  if (/object|field|metadata/.test(text)) return "Objects";
  if (/recycle|restore|purge/.test(text)) return "Recycle Bin";
  if (/app/.test(text)) return "Apps";
  return row.feature || "the target screen";
};

const uiActionForSteps = (row) => {
  const text = [row.feature, row.displayTitle, row.title, row.spec, row.input].join(" ").toLowerCase();
  const target = String(row.feature || "record").toLowerCase();
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
  return `perform the ${row.feature || "feature"} action named in the test case`;
};

const readableStepsForRow = (row) => {
  const raw = normalizeStepText(row.input);
  if (isAlreadyExpandedStep(raw)) return raw;

  const surface = normalizeSurface(row.surface);
  const cleanTitle = stripBracketMeta([row.displayTitle, row.title].join(" "));
  const text = [cleanTitle, row.spec, row.feature, row.surface, raw].join(" ").toLowerCase();
  const isApi = surface === "api" || /api|routes?|service|endpoint|^get |^post |^patch |^delete |\/api\//i.test(text);
  const isKeystone = surface === "keystone" || /keystone|shockwave/.test(text);
  const isAdmin = surface === "admin" || /admin/.test(text);
  const isPermissionAccess = /permission|access record|access-control|effective-access|role|group|grant/.test(text);
  const isInvalid = /reject|invalid|unauthorized|requires valid authentication|not found|missing|duplicate|inactive/.test(text);
  const isDownstream = /downstream|effective-access|grant|check/.test(text);

  if (isApi && isPermissionAccess && isInvalid) {
    return stepChain([
      "Open application",
      "authenticate with seeded admin API credentials",
      `send the invalid or unauthorized ${row.feature || "security"} request from the test case`,
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
  if (isApi && isPermissionAccess && isVagueStepText(raw)) {
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
      isVagueStepText(raw) ? `call the ${row.feature || "target"} endpoint or route named in the test` : raw,
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
      isVagueStepText(raw) ? uiActionForSteps(row) : raw,
      "verify the record or table state"
    ]);
  }
  if (isAdmin || isPermissionAccess) {
    return stepChain([
      "Open Admin application",
      "fill the login details",
      "click Login",
      isVagueStepText(raw) ? `navigate to ${adminScreenForSteps(row)} from the sidebar` : raw,
      isVagueStepText(raw) ? uiActionForSteps(row) : "",
      "verify the page or table result"
    ]);
  }
  return stepChain([
    "Open application",
    "sign in with seeded test credentials",
    isVagueStepText(raw) ? `navigate to the ${row.feature || "target"} screen` : raw,
    isVagueStepText(raw) ? uiActionForSteps(row) : "",
    "verify the expected result and capture evidence"
  ]);
};

const withReadableSteps = (row) => ({ ...row, input: readableStepsForRow(row) });

const structuredStepsForRow = (row) => {
  if (Array.isArray(row.steps) && row.steps.length > 0) return row.steps;
  const input = normalizeStepText(row.input || row.inputAction || "");
  const parts = input.split(/\s*->\s*/).map((part) => part.trim()).filter(Boolean);
  const source = parts.length > 0 ? parts : [input || "Execute the test case"];
  const expected = row.expected || row.expectedResult || "The UI/API behaves as expected.";
  const feature = row.feature || row.featureArea || "Feature";
  const surface = row.surface || "Application";
  return source.map((action, index) => ({
    section: index === 0 ? surface : `${surface} > ${feature}`,
    action,
    testData: row.testData || "Seeded credentials and seeded application data resolved at runtime.",
    expectedBehavior: expected,
    verify: index === source.length - 1 ? expected : `Verify "${action}" completes and the next state is reachable.`,
    result: row.status || "Pending"
  }));
};

const api = async (path, options) => {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { "content-type": "application/json" },
    ...options
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || payload.detail || "Request failed.");
  return payload;
};

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
    reader.onerror = () => reject(reader.error || new Error("Unable to read file."));
    reader.readAsDataURL(file);
  });

const downloadFile = async (url, fallbackName) => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      message = JSON.parse(text).error || message;
    } catch {
      // Keep the raw response text when it is not JSON.
    }
    throw new Error(message || `Download failed with ${response.status}.`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const filename = /filename="?([^"]+)"?/i.exec(disposition)?.[1] || fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
};

const useDashboardData = () => {
  const [framework, setFramework] = useState(null);
  const [services, setServices] = useState({ services: [] });
  const [status, setStatus] = useState({});
  const [results, setResults] = useState({ counts: {}, rows: [] });
  const [inventory, setInventory] = useState({ rows: [] });
  const [testPlan, setTestPlan] = useState({ plans: [], counts: {} });
  const [recording, setRecording] = useState({});
  const [recordedScenarios, setRecordedScenarios] = useState({ scenarios: [] });
  const [error, setError] = useState("");

  const refreshStatic = async (forceInventory = false) => {
    const [frameworkPayload, inventoryPayload, testPlanPayload] = await Promise.all([
      api("/api/framework"),
      api(`/api/inventory${forceInventory ? "?refresh=1" : ""}`),
      api("/api/test-plan")
    ]);
    setFramework(frameworkPayload);
    setInventory(inventoryPayload);
    setTestPlan(testPlanPayload);
  };

  const refreshLive = async () => {
    try {
      const [servicesPayload, statusPayload, resultsPayload] = await Promise.all([
        api("/api/services"),
        api("/api/status"),
        api("/api/results")
      ]);
      setServices(servicesPayload);
      setStatus(statusPayload);
      setResults(resultsPayload);
      const [recordingPayload, scenariosPayload] = await Promise.all([
        api("/api/recording/status"),
        api("/api/recorded-scenarios")
      ]);
      setRecording(recordingPayload);
      setRecordedScenarios(scenariosPayload);
      setError("");
    } catch (error) {
      setError(error.message);
    }
  };

  useEffect(() => {
    refreshStatic().catch((error) => setError(error.message));
    refreshLive();
    const id = window.setInterval(refreshLive, 2500);
    return () => window.clearInterval(id);
  }, []);

  return { framework, services, status, results, inventory, testPlan, recording, recordedScenarios, error, refreshStatic, refreshLive };
};

function App() {
  const data = useDashboardData();
  const [active, setActive] = useState("overview");
  const [theme, setTheme] = useState(() => localStorage.getItem("qa-theme") || "system");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("qa-sidebar") === "collapsed");
  const [openNavGroups, setOpenNavGroups] = useState(() => {
    try {
      return { ...defaultOpenNavGroups, ...JSON.parse(localStorage.getItem("qa-nav-groups") || "{}") };
    } catch {
      return defaultOpenNavGroups;
    }
  });
  const [filter, setFilter] = useState("");
  const [inventoryContext, setInventoryContext] = useState(null);
  const [selectedTests, setSelectedTests] = useState(new Set());
  const [scenarioFilter, setScenarioFilter] = useState("");
  const [surface, setSurface] = useState("all");
  const [headed, setHeaded] = useState(false);
  const [reset, setReset] = useState(false);
  const [agent, setAgent] = useState({
    baseRef: "auto",
    branchName: "agent/generated-tests",
    push: true,
    scan: null,
    generated: null,
    sync: null,
    graph: null,
    scheduler: null,
    commit: null,
    busy: false,
    error: ""
  });
  const [recorder, setRecorder] = useState({ name: "", busy: false, error: "" });
  const [runDialog, setRunDialog] = useState({
    open: false,
    suites: [],
    surface: "all",
    scenario: "",
    tests: [],
    headed: false,
    requestedBy: "",
    mappings: {},
    datasets: [],
    loadingDatasets: false,
    busy: false,
    error: ""
  });

  useEffect(() => {
    localStorage.setItem("qa-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("qa-sidebar", sidebarCollapsed ? "collapsed" : "expanded");
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem("qa-nav-groups", JSON.stringify(openNavGroups));
  }, [openNavGroups]);

  useEffect(() => {
    const activeGroup = navGroups.find((group) => group.items.some((item) => item.id === active));
    if (!activeGroup || openNavGroups[activeGroup.id]) return;
    setOpenNavGroups((previous) => ({ ...previous, [activeGroup.id]: true }));
  }, [active, openNavGroups]);

  const toggleNavGroup = (groupId) => {
    setOpenNavGroups((previous) => ({ ...previous, [groupId]: !previous[groupId] }));
  };

  const rows = useMemo(
    () => (Array.isArray(data.inventory.rows) ? data.inventory.rows : []).map(withReadableSteps),
    [data.inventory.rows]
  );
  const resultRows = Array.isArray(data.results.rows) ? data.results.rows : [];
  const rowsForCategory = (level) => rows.filter((row) =>
    String(row.testingLevel || "").toLowerCase() === String(level).toLowerCase()
    && row.title
  );
  const categoryCounts = useMemo(() => Object.fromEntries(categoryLevels.map((level) => [level, rowsForCategory(level).length])), [rows]);
  const filteredRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const contextRows = inventoryContext
      ? rows.filter((row) => suiteMatchesRow(inventoryContext, row))
      : rows;
    if (!needle) return contextRows;
    return contextRows.filter((row) =>
      [row.id, row.tags, row.testingLevel, row.surface, row.feature, row.displayTitle, row.precondition, row.input, row.expected, row.proof, JSON.stringify(structuredStepsForRow(row))]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [rows, filter, inventoryContext]);

  const selectedTitles = Array.from(selectedTests);
  const failedRows = resultRows.filter((row) => row.status === "FAIL");
  const counts = data.results.counts || {};

  const refreshRunDatasets = async () => {
    setRunDialog((previous) => ({ ...previous, loadingDatasets: true, error: "" }));
    try {
      const payload = await api("/api/test-data/datasets");
      setRunDialog((previous) => ({ ...previous, datasets: payload.datasets || [], loadingDatasets: false }));
    } catch (error) {
      const message = error.message === "Failed to fetch"
        ? "Unable to load saved datasets. Refresh after the dashboard server restarts."
        : error.message;
      setRunDialog((previous) => ({ ...previous, error: message, loadingDatasets: false }));
    }
  };

  useEffect(() => {
    if (!runDialog.open) return;
    refreshRunDatasets();
  }, [runDialog.open]);

  const mappingDefaults = (suites) => Object.fromEntries((suites || []).map((suite) => [
    suite.id,
    { suiteId: suite.id, mode: "automated", datasetId: "", versionId: "", datasetName: "", file: null, uploading: false, downloadingTemplate: false, error: "" }
  ]));

  const openRunDialog = ({ suites = [], nextSurface = surface, scenario = scenarioFilter, tests = [], headedOverride = headed }) => {
    const safeSuites = suites.filter(Boolean);
    setRunDialog({
      open: true,
      suites: safeSuites,
      surface: nextSurface,
      scenario,
      tests,
      headed: headedOverride,
      requestedBy: "",
      mappings: mappingDefaults(safeSuites),
      datasets: runDialog.datasets || [],
      loadingDatasets: false,
      busy: false,
      error: ""
    });
  };

  const startRun = async ({ nextSurface = surface, scenario = scenarioFilter, tests = [], headedOverride = headed, requestedBy = "", testDataMappings = [] }) => {
    await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ surface: nextSurface, scenario, tests, reset, headed: headedOverride, requestedBy, testDataMappings })
    });
    await data.refreshLive();
    setActive("execution");
  };

  const runSuite = (nextSurface = surface, scenario = scenarioFilter, tests = [], headedOverride = headed, suites = []) => {
    const inferredSuites = suites.length
      ? suites
      : inventoryContext
        ? [inventoryContext]
        : (data.framework?.suites || []).filter((suite) => scenario && suite.grep === scenario).slice(0, 1);
    openRunDialog({ suites: inferredSuites, nextSurface, scenario, tests, headedOverride });
  };

  const runCategory = async (level) => {
    const tests = rowsForCategory(level).map((row) => row.title);
    if (tests.length === 0) return;
    runSuite("all", "", tests, headed, data.framework?.suites || []);
  };

  const openSuiteCases = (suite) => {
    setInventoryContext(suite);
    setFilter("");
    setSelectedTests(new Set());
    setSurface(suite.surface || "all");
    setActive("inventory");
  };

  const stopRun = async () => {
    await api("/api/stop", { method: "POST", body: "{}" });
    await data.refreshLive();
  };

  const startRecording = async (nextSurface) => {
    setRecorder((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      await api("/api/record/start", { method: "POST", body: JSON.stringify({ surface: nextSurface }) });
      await data.refreshLive();
      setRecorder((previous) => ({ ...previous, busy: false }));
      setActive("recorder");
    } catch (error) {
      setRecorder((previous) => ({ ...previous, busy: false, error: error.message }));
    }
  };

  const stopRecording = async () => {
    const name = recorder.name.trim();
    if (!name) {
      setRecorder((previous) => ({ ...previous, error: "Enter a scenario name before saving." }));
      return;
    }
    setRecorder((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      await api("/api/record/stop", { method: "POST", body: JSON.stringify({ name }) });
      await data.refreshStatic(true);
      await data.refreshLive();
      setRecorder({ name: "", busy: false, error: "" });
    } catch (error) {
      setRecorder((previous) => ({ ...previous, busy: false, error: error.message }));
    }
  };

  const runRecordedScenario = async (scenario, runHeaded = false) => {
    await api("/api/recorded-scenarios/run", {
      method: "POST",
      body: JSON.stringify({ id: scenario.id, headed: runHeaded })
    });
    await data.refreshLive();
  };

  const toggleSelected = (title) => {
    setSelectedTests((previous) => {
      const next = new Set(previous);
      next.has(title) ? next.delete(title) : next.add(title);
      return next;
    });
  };

  const runAgentScan = async () => {
    setAgent((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      const scan = await api("/api/agent/scan", { method: "POST", body: JSON.stringify({ baseRef: agent.baseRef }) });
      setAgent((previous) => ({ ...previous, scan, busy: false }));
    } catch (error) {
      setAgent((previous) => ({ ...previous, error: error.message, busy: false }));
    }
  };

  const runAgentGenerate = async () => {
    setAgent((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      const generated = await api("/api/agent/generate", { method: "POST", body: JSON.stringify({ baseRef: agent.baseRef }) });
      setAgent((previous) => ({ ...previous, generated, busy: false }));
      await data.refreshStatic(true);
    } catch (error) {
      setAgent((previous) => ({ ...previous, error: error.message, busy: false }));
    }
  };

  const runAgentGenerated = async (reset = false) => {
    setAgent((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      const run = await api("/api/agent/run", {
        method: "POST",
        body: JSON.stringify({ baseRef: agent.baseRef, headed, reset, artifactPath: agent.generated?.outputPath })
      });
      setAgent((previous) => ({ ...previous, generated: run.artifact || previous.generated, busy: false }));
      await data.refreshLive();
      setActive("execution");
    } catch (error) {
      setAgent((previous) => ({ ...previous, error: error.message, busy: false }));
    }
  };

  const commitAgentGenerated = async () => {
    setAgent((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      const commit = await api("/api/agent/commit", {
        method: "POST",
        body: JSON.stringify({ branchName: agent.branchName, push: agent.push })
      });
      setAgent((previous) => ({ ...previous, commit, busy: false }));
    } catch (error) {
      setAgent((previous) => ({ ...previous, error: error.message, busy: false }));
    }
  };

  const refreshAgentOps = async () => {
    try {
      const [sync, graph, scheduler] = await Promise.all([
        api("/api/agent/sync/status"),
        api("/api/agent/graph"),
        api("/api/agent/scheduler/status")
      ]);
      setAgent((previous) => ({ ...previous, sync, graph, scheduler }));
    } catch (error) {
      setAgent((previous) => ({ ...previous, error: error.message }));
    }
  };

  useEffect(() => {
    if (active !== "agent") return;
    refreshAgentOps();
    const id = window.setInterval(refreshAgentOps, 5000);
    return () => window.clearInterval(id);
  }, [active]);

  const syncAgentMain = async () => {
    setAgent((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      const sync = await api("/api/agent/sync/main", { method: "POST", body: JSON.stringify({ pull: true }) });
      setAgent((previous) => ({ ...previous, sync: sync.after || sync, busy: false }));
      await refreshAgentOps();
    } catch (error) {
      setAgent((previous) => ({ ...previous, error: error.message, busy: false }));
    }
  };

  const saveScheduler = async (config) => {
    setAgent((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      const scheduler = await api("/api/agent/scheduler/config", { method: "POST", body: JSON.stringify(config) });
      setAgent((previous) => ({ ...previous, scheduler, busy: false }));
      await refreshAgentOps();
    } catch (error) {
      setAgent((previous) => ({ ...previous, error: error.message, busy: false }));
    }
  };

  const runScheduledNow = async () => {
    setAgent((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      await api("/api/agent/scheduler/run-now", {
        method: "POST",
        body: JSON.stringify(agent.scheduler?.config || {})
      });
      setAgent((previous) => ({ ...previous, busy: false }));
      await data.refreshLive();
      await refreshAgentOps();
      setActive("execution");
    } catch (error) {
      setAgent((previous) => ({ ...previous, error: error.message, busy: false }));
    }
  };

  const renderSection = () => {
    if (active === "suites") return <SuitesPanel framework={data.framework} running={data.status.running} onOpen={openSuiteCases} onRun={(suite, runHeaded) => runSuite(suite.surface, suite.grep || "", [], runHeaded, [suite])} />;
    if (active === "scenarios") return <ScenariosPanel framework={data.framework} running={data.status.running} onRun={(scenario) => {
      const suite = (data.framework?.suites || []).find((item) => item.id === scenario.suiteId);
      setScenarioFilter(scenario.grep || "");
      runSuite(suite?.surface || "all", scenario.grep || "", [], headed, suite ? [suite] : []);
    }} />;
    if (active === "test-plans") return <TestPlansPanel testPlan={data.testPlan} running={data.status.running} onRunAutomation={() => runSuite("all", "@complete-list-view-atomic", [], headed, (data.framework?.suites || []).filter((suite) => suite.id === "complete-list-view-e2e"))} />;
    if (active === "recorder") return (
      <RecorderPanel
        recorder={recorder}
        setRecorder={setRecorder}
        recording={data.recording}
        recordedScenarios={data.recordedScenarios}
        startRecording={startRecording}
        stopRecording={stopRecording}
        runRecordedScenario={runRecordedScenario}
        stopRun={stopRun}
        running={data.status.running}
        status={data.status}
      />
    );
    if (active === "inventory") return (
      <InventoryPanel
        rows={filteredRows}
        filter={filter}
        setFilter={setFilter}
        selectedTests={selectedTests}
        toggleSelected={toggleSelected}
        selectVisible={() => setSelectedTests(new Set(filteredRows.map((row) => row.title)))}
        selectAll={() => setSelectedTests(new Set(filteredRows.map((row) => row.title)))}
        clearSelected={() => setSelectedTests(new Set())}
        refresh={() => data.refreshStatic(true)}
        context={inventoryContext}
        clearContext={() => setInventoryContext(null)}
        backToSuites={() => setActive("suites")}
        runSelected={() => runSuite(surface, "", selectedTitles, headed, inventoryContext ? [inventoryContext] : [])}
        running={data.status.running}
      />
    );
    if (active === "execution") return <ExecutionPanel status={data.status} stopRun={stopRun} />;
    if (active === "reports") return <ReportsPanel results={data.results} />;
    if (active === "bugs") return <BugsPanel failedRows={failedRows} />;
    if (active === "agent") return (
      <AgentPanel
        agent={agent}
        setAgent={setAgent}
        runAgentScan={runAgentScan}
        runAgentGenerate={runAgentGenerate}
        runAgentGenerated={runAgentGenerated}
        commitAgentGenerated={commitAgentGenerated}
        syncAgentMain={syncAgentMain}
        saveScheduler={saveScheduler}
        runScheduledNow={runScheduledNow}
        running={data.status.running}
      />
    );
    if (active === "settings") return <SettingsPanel framework={data.framework} theme={theme} setTheme={setTheme} />;
    return <OverviewPanel counts={counts} framework={data.framework} inventory={data.inventory} status={data.status} services={data.services} results={data.results} />;
  };

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">CP</span>
          <div className="brand-copy"><strong>QA Framework</strong><small>Core Platform</small></div>
          <button
            className="icon-button sidebar-toggle"
            onClick={() => setSidebarCollapsed((value) => !value)}
            aria-label={sidebarCollapsed ? "Open sidebar" : "Close sidebar"}
            title={sidebarCollapsed ? "Open sidebar" : "Close sidebar"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <nav aria-label="Framework sections">
          {navGroups.map((group) => {
            const isOpen = sidebarCollapsed || openNavGroups[group.id];
            return (
              <section className="nav-group" key={group.id}>
                {!sidebarCollapsed ? (
                  <button
                    type="button"
                    className="nav-group-toggle"
                    onClick={() => toggleNavGroup(group.id)}
                    aria-expanded={isOpen}
                    title={group.label}
                  >
                    {isOpen ? <ChevronDown className="nav-chevron" size={15} /> : <ChevronRight className="nav-chevron" size={15} />}
                    <span>{group.label}</span>
                  </button>
                ) : null}
                {isOpen ? (
                  <div className="nav-items">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      return <button key={item.id} className={active === item.id ? "nav-active" : ""} onClick={() => setActive(item.id)} title={item.label}><Icon size={17} /><span>{item.label}</span></button>;
                    })}
                  </div>
                ) : null}
              </section>
            );
          })}
        </nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Web based testing framework</p>
            <h1>{navItems.find((item) => item.id === active)?.label || "Overview"}</h1>
          </div>
          <div className="topbar-actions">
            <select value={surface} onChange={(event) => setSurface(event.target.value)} aria-label="Surface">
              <option value="all">All</option><option value="admin">Admin</option><option value="keystone">Keystone</option><option value="api">API</option>
            </select>
            <label><input type="checkbox" checked={reset} onChange={(event) => setReset(event.target.checked)} /> Reset</label>
            <label><input type="checkbox" checked={headed} onChange={(event) => setHeaded(event.target.checked)} /> Headed</label>
            <button onClick={() => runSuite()} disabled={data.status.running}><Play size={16} /> Run</button>
            {categoryLevels.map((level) => (
              <button
                key={level}
                className="secondary category-run"
                onClick={() => runCategory(level)}
                disabled={data.status.running || categoryCounts[level] === 0}
                title={`Run ${level} cases across Admin, Keystone, and API`}
              >
                <Play size={16} /> {level} {categoryCounts[level] || 0}
              </button>
            ))}
            <button onClick={() => runSuite(surface, "", selectedTitles, headed, inventoryContext ? [inventoryContext] : [])} disabled={data.status.running || selectedTitles.length === 0}><CheckSquare size={16} /> Run Selected {selectedTitles.length}</button>
            <button className="danger" onClick={stopRun} disabled={!data.status.running}><XCircle size={16} /> Stop</button>
            <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
          </div>
        </header>
        {data.error ? <div className="notice danger-text">{data.error}</div> : null}
        {renderSection()}
      </main>
      <RunSetupDialog
        state={runDialog}
        setState={setRunDialog}
        framework={data.framework}
        running={data.status.running}
        refreshDatasets={refreshRunDatasets}
        startRun={startRun}
      />
    </div>
  );
}

function RunSetupDialog({ state, setState, framework, running, refreshDatasets, startRun }) {
  const [suiteFilter, setSuiteFilter] = useState("");
  const [showSuitePicker, setShowSuitePicker] = useState(false);
  if (!state.open) return null;
  const suites = Array.isArray(state.suites) ? state.suites : [];
  const allSuites = framework?.suites || [];
  const selectedSuiteIds = new Set(suites.map((suite) => suite.id));
  const availableSuites = allSuites.filter((suite) => !selectedSuiteIds.has(suite.id));
  const suiteNeedle = suiteFilter.trim().toLowerCase();
  const filteredAvailableSuites = availableSuites.filter((suite) =>
    !suiteNeedle ||
    [suite.label, suite.id, suite.surface, ...(suite.tags || [])].join(" ").toLowerCase().includes(suiteNeedle)
  );
  const updateMapping = (suiteId, patch) => {
    setState((previous) => ({
      ...previous,
      mappings: {
        ...previous.mappings,
        [suiteId]: {
          suiteId,
          mode: "automated",
          datasetId: "",
          versionId: "",
          datasetName: "",
          file: null,
          uploading: false,
          downloadingTemplate: false,
          error: "",
          ...(previous.mappings[suiteId] || {}),
          ...patch
        }
      }
    }));
  };
  const close = () => setState((previous) => ({ ...previous, open: false, busy: false, error: "" }));
  const addSuiteById = (suiteId) => {
    const suite = allSuites.find((item) => item.id === suiteId);
    if (!suite) return;
    setState((previous) => ({
      ...previous,
      suites: [...previous.suites, suite],
      mappings: {
        ...previous.mappings,
        [suite.id]: { suiteId: suite.id, mode: "automated", datasetId: "", versionId: "", datasetName: "", file: null, uploading: false, downloadingTemplate: false, error: "" }
      }
    }));
    setSuiteFilter("");
    setShowSuitePicker(false);
  };
  const removeSuite = (suiteId) => {
    setState((previous) => {
      const nextMappings = { ...previous.mappings };
      delete nextMappings[suiteId];
      return { ...previous, suites: previous.suites.filter((suite) => suite.id !== suiteId), mappings: nextMappings };
    });
  };
  const downloadTemplate = async (suite) => {
    updateMapping(suite.id, { downloadingTemplate: true, error: "" });
    try {
      await downloadFile(
        `/api/test-data/template.xlsx?suiteId=${encodeURIComponent(suite.id)}`,
        `${suite.id || "suite"}-manual-test-data-template.xlsx`
      );
      updateMapping(suite.id, { downloadingTemplate: false, error: "" });
    } catch (error) {
      const message = error.message === "Failed to fetch"
        ? "Template download failed because the dashboard server is not reachable. Restart the test dashboard and try again."
        : error.message;
      updateMapping(suite.id, { downloadingTemplate: false, error: message });
    }
  };
  const uploadDataset = async (suite) => {
    const mapping = state.mappings[suite.id] || {};
    if (!mapping.file) {
      updateMapping(suite.id, { error: "Choose an Excel file first." });
      return;
    }
    updateMapping(suite.id, { uploading: true, error: "" });
    try {
      const contentBase64 = await fileToBase64(mapping.file);
      const saved = await api("/api/test-data/datasets", {
        method: "POST",
        body: JSON.stringify({
          suiteId: suite.id,
          datasetName: mapping.datasetName || `${suite.label} manual data`,
          requestedBy: state.requestedBy,
          fileName: mapping.file.name,
          contentBase64
        })
      });
      setState((previous) => {
        const datasets = [
          saved.dataset,
          ...(previous.datasets || []).filter((dataset) => dataset.id !== saved.dataset.id)
        ];
        return {
          ...previous,
          datasets,
          mappings: {
            ...previous.mappings,
            [suite.id]: {
              ...(previous.mappings[suite.id] || {}),
              mode: "dataset",
              datasetId: saved.dataset.id,
              versionId: saved.version.id,
              datasetName: saved.dataset.name,
              file: null,
              uploading: false,
              error: ""
            }
          }
        };
      });
    } catch (error) {
      updateMapping(suite.id, { uploading: false, error: error.message });
    }
  };
  const submit = async () => {
    const mappings = suites.map((suite) => state.mappings[suite.id] || { suiteId: suite.id, mode: "automated" });
    const usesManual = mappings.some((mapping) => mapping.mode === "dataset");
    if (usesManual && !state.requestedBy.trim()) {
      setState((previous) => ({ ...previous, error: "Requested by is required for saved Excel data runs." }));
      return;
    }
    const missingDataset = mappings.find((mapping) => mapping.mode === "dataset" && !mapping.datasetId);
    if (missingDataset) {
      setState((previous) => ({ ...previous, error: "Select a saved dataset for every manual suite." }));
      return;
    }
    setState((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      await startRun({
        nextSurface: state.surface,
        scenario: state.scenario,
        tests: state.tests,
        headedOverride: state.headed,
        requestedBy: state.requestedBy,
        testDataMappings: mappings.map((mapping) => ({
          suiteId: mapping.suiteId,
          mode: mapping.mode === "dataset" ? "dataset" : "automated",
          datasetId: mapping.datasetId || "",
          versionId: mapping.versionId || ""
        }))
      });
      close();
    } catch (error) {
      setState((previous) => ({ ...previous, busy: false, error: error.message }));
    }
  };

  return <div className="modal-backdrop" role="dialog" aria-modal="true">
    <section className="run-modal panel">
      <div className="section-heading run-modal-heading">
        <div>
          <h2>Run Setup</h2>
          <span>{state.tests.length ? `${state.tests.length} selected cases` : state.scenario || state.surface}</span>
        </div>
        <button type="button" className="icon-button" onClick={close} aria-label="Close"><XCircle size={18} /></button>
      </div>
      <div className="run-modal-grid run-modal-primary">
        <label className="requested-by-field">Requested by <input value={state.requestedBy} onChange={(event) => setState((previous) => ({ ...previous, requestedBy: event.target.value, error: "" }))} placeholder="Name or team" /></label>
        <label>Mode <select value={state.headed ? "headed" : "headless"} onChange={(event) => setState((previous) => ({ ...previous, headed: event.target.value === "headed" }))}><option value="headless">Headless</option><option value="headed">Headed</option></select></label>
        {availableSuites.length ? (
          <div className="add-suite-control">
            <span className="field-label">Add suite</span>
            <button type="button" className="secondary add-suite-trigger" onClick={() => setShowSuitePicker((value) => !value)}><Plus size={16} /> Add Suite</button>
          </div>
        ) : null}
      </div>
      {showSuitePicker && availableSuites.length ? (
        <div className="suite-picker">
          <input value={suiteFilter} onChange={(event) => setSuiteFilter(event.target.value)} placeholder="Search suites" autoFocus />
          <div className="suite-picker-list">
            {filteredAvailableSuites.length ? filteredAvailableSuites.map((suite) => (
              <button type="button" className="suite-picker-option" key={suite.id} onClick={() => addSuiteById(suite.id)}>
                <strong>{suite.label}</strong>
                <span>{suite.surface || "all"} · {suite.id}</span>
              </button>
            )) : <div className="empty">No matching suites.</div>}
          </div>
        </div>
      ) : null}
      {state.error ? <p className="run-modal-error danger-text">{state.error}</p> : null}
      <div className="suite-data-list">
        {suites.length === 0 ? <div className="notice">No suite mapping selected. The run will use automated test data.</div> : suites.map((suite) => {
          const mapping = state.mappings[suite.id] || { suiteId: suite.id, mode: "automated" };
          const suiteDatasets = (state.datasets || []).filter((dataset) => dataset.suiteId === suite.id);
          const selectedDataset = suiteDatasets.find((dataset) => dataset.id === mapping.datasetId);
          return <article className="suite-data-row" key={suite.id}>
            <div className="suite-data-head">
              <div><strong>{suite.label}</strong><span>{suite.id}</span></div>
              <div className="inline-actions">
                <button type="button" className="secondary" onClick={() => downloadTemplate(suite)} disabled={mapping.downloadingTemplate}><FileSpreadsheet size={16} /> {mapping.downloadingTemplate ? "Downloading" : "Template"}</button>
                <button type="button" className="secondary" onClick={() => removeSuite(suite.id)}><Trash2 size={16} /> Remove</button>
              </div>
            </div>
            <div className="run-modal-grid suite-run-controls">
              <label>Data source <select value={mapping.mode || "automated"} onChange={(event) => updateMapping(suite.id, { mode: event.target.value, error: "" })}><option value="automated">Automated data</option><option value="dataset">Saved Excel dataset</option></select></label>
              {mapping.mode === "dataset" ? <>
                <label>Saved dataset <select value={mapping.datasetId || ""} onChange={(event) => {
                  const dataset = suiteDatasets.find((item) => item.id === event.target.value);
                  updateMapping(suite.id, { datasetId: dataset?.id || "", versionId: dataset?.latestVersionId || "", datasetName: dataset?.name || "", error: "" });
                }}><option value="">Select dataset</option>{suiteDatasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></label>
                <label>Version <select value={mapping.versionId || ""} onChange={(event) => updateMapping(suite.id, { versionId: event.target.value, error: "" })}><option value="">Latest version</option>{(selectedDataset?.versions || []).map((version) => <option key={version.id} value={version.id}>{formatDate(version.uploadedAt)} · {version.rowCount} rows</option>)}</select></label>
              </> : null}
              {mapping.mode === "dataset" && suiteDatasets.length === 0 ? <p className="inline-note">No saved Excel datasets for this suite.</p> : null}
            </div>
            <div className="excel-upload-card">
              <label>Dataset name <input value={mapping.datasetName || ""} onChange={(event) => updateMapping(suite.id, { datasetName: event.target.value, error: "" })} placeholder={`${suite.label} manual data`} /></label>
              <label className="file-picker">
                <span>Upload Excel</span>
                <input type="file" accept=".xlsx" onChange={(event) => updateMapping(suite.id, { file: event.target.files?.[0] || null, error: "" })} />
                <b>Choose .xlsx</b>
                <em>{mapping.file?.name || "No file selected"}</em>
              </label>
              <button type="button" className="secondary save-excel-button" onClick={() => uploadDataset(suite)} disabled={mapping.uploading}><Upload size={16} /> {mapping.uploading ? "Saving" : "Save Excel"}</button>
            </div>
            {mapping.error ? <p className="danger-text">{mapping.error}</p> : null}
          </article>;
        })}
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={refreshDatasets} disabled={state.loadingDatasets}><Database size={16} /> {state.loadingDatasets ? "Refreshing" : "Refresh Datasets"}</button>
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button type="button" onClick={submit} disabled={running || state.busy}><Play size={16} /> {state.busy ? "Starting" : "Run"}</button>
      </div>
    </section>
  </div>;
}

function OverviewPanel({ counts, framework, inventory, status, services, results }) {
  const up = Array.isArray(services.services) ? services.services.filter((service) => service.up).length : 0;
  return <section className="section-stack">
    <div className="metric-grid">
      <Metric label="Suites" value={framework?.suites?.length || 0} />
      <Metric label="Scenarios" value={framework?.scenarios?.length || 0} />
      <Metric label="Inventory" value={inventory.total || inventory.rows?.length || 0} />
      <Metric label="Services Up" value={`${up}/${services.services?.length || 3}`} />
      <Metric label="Run" value={status.running ? "Running" : "Idle"} />
    </div>
    <ServicesPanel services={services} />
    <div className="metric-grid compact">
      <Metric label="Pending" value={counts.PENDING || 0} tone="pending" /><Metric label="Running" value={counts.RUNNING || 0} tone="running" /><Metric label="Passed" value={counts.PASS || 0} tone="pass" /><Metric label="Failed" value={counts.FAIL || 0} tone="fail" /><Metric label="Skipped" value={counts.SKIP || 0} tone="skip" />
    </div>
    <DataTable title={`Latest Results (${results.total || results.rows?.length || 0})`} rows={results.rows || []} columns={[["id", "ID"], ["surface", "Surface"], ["featureArea", "Feature"], ["testCaseTitle", "Test Case"], ["status", "Status"]]} />
  </section>;
}

function ServicesPanel({ services }) {
  return <section className="panel"><div className="section-heading"><h2>Local Services</h2><span>Updated {formatDate(services.updatedAt)}</span></div><div className="service-grid">{(services.services || []).map((service) => <article key={service.name} className="service-card"><span>{service.name}</span><strong>:{service.port}</strong><p className={service.up ? "pass" : "fail"}>{service.up ? `up ${service.statusCode}` : service.error || "down"}</p></article>)}</div></section>;
}

function SuitesPanel({ framework, running, onOpen, onRun }) {
  return <section className="card-grid">{(framework?.suites || []).map((suite) => <article key={suite.id} className="panel suite-card" onClick={() => onOpen(suite)}><div className="section-heading"><h2>{suite.label}</h2><span>{suite.surface}</span></div><p>{suite.description}</p><div className="tag-row">{(suite.tags || []).map((tag) => <span key={tag}>{tag}</span>)}</div><div className="inline-actions"><button onClick={(event) => { event.stopPropagation(); onOpen(suite); }}><Search size={16} /> View Cases</button><button className="secondary" disabled={running} onClick={(event) => { event.stopPropagation(); onRun(suite, false); }}><Play size={16} /> Run Headless</button><button className="secondary" disabled={running} onClick={(event) => { event.stopPropagation(); onRun(suite, true); }}><Video size={16} /> Run Headed</button></div></article>)}</section>;
}

function ScenariosPanel({ framework, running, onRun }) {
  return <section className="card-grid">{(framework?.scenarios || []).map((scenario) => <article key={scenario.id} className="panel"><div className="section-heading"><h2>{scenario.label}</h2><span>{scenario.suiteId}</span></div><p>{scenario.description}</p><code>{scenario.grep || "No grep filter"}</code><button onClick={() => onRun(scenario)} disabled={running}><Play size={16} /> Run Scenario</button></article>)}</section>;
}

function RecorderPanel({ recorder, setRecorder, recording, recordedScenarios, startRecording, stopRecording, runRecordedScenario, stopRun, running, status }) {
  const scenarios = Array.isArray(recordedScenarios?.scenarios) ? recordedScenarios.scenarios : [];
  const isRecording = Boolean(recording?.recording);
  return <section className="section-stack">
    <div className="panel">
      <div className="section-heading">
        <div>
          <h2>Flow Recorder</h2>
          <span>{isRecording ? `Recording ${recording.surfaceLabel || recording.surface}` : "Idle"}</span>
        </div>
        <Video size={20} />
      </div>
      {running ? <div className="notice recorder-blocked">A test run is active. Stop the current run before recording a new flow.</div> : null}
      <div className="recorder-grid">
        <label>Scenario name <input value={recorder.name} onChange={(event) => setRecorder((previous) => ({ ...previous, name: event.target.value, error: "" }))} placeholder="Example: Admin create app flow" /></label>
        <div className="recorder-actions">
          <button onClick={() => startRecording("admin")} disabled={isRecording || running || recorder.busy}><Radio size={16} /> Record Admin</button>
          <button onClick={() => startRecording("keystone")} disabled={isRecording || running || recorder.busy}><Radio size={16} /> Record Keystone</button>
          <button className="danger" onClick={stopRecording} disabled={!isRecording || recorder.busy}><Save size={16} /> Stop & Save</button>
        </div>
      </div>
      {recorder.error ? <p className="danger-text recorder-message">{recorder.error}</p> : null}
      <pre className="logs recorder-logs">{(recording?.logs || []).join("\n") || "Start recording, complete the flow in the Playwright Codegen browser, then stop and save it here."}</pre>
    </div>
    <DataTable
      title={`Recorded Scenarios (${scenarios.length})`}
      rows={scenarios}
      columns={[["name", "Scenario"], ["surfaceLabel", "Surface"], ["createdAt", "Created"], ["spec", "Spec"], ["actions", "Run"]]}
      renderCell={(row, key) => {
        if (key === "createdAt") return formatDate(row.createdAt);
        if (key !== "actions") return null;
        const isCurrentRun = running && status?.scenario === row.name && status?.surface === row.surface;
        return <div className="inline-actions"><button onClick={() => runRecordedScenario(row, false)} disabled={running || isRecording}><Play size={16} /> Run</button><button className="secondary" onClick={() => runRecordedScenario(row, true)} disabled={running || isRecording}>Headed</button><button className="danger" onClick={stopRun} disabled={!isCurrentRun}><Square size={16} /> Stop</button></div>;
      }}
    />
  </section>;
}

function TestPlansPanel({ testPlan, running, onRunAutomation }) {
  const plans = Array.isArray(testPlan?.plans) ? testPlan.plans : [];
  const counts = testPlan?.counts || {};
  const plan = plans[0] || null;
  const suites = useMemo(() => collectPlanSuites(plan), [plan]);
  const suiteGroups = useMemo(() => groupPlanSuites(suites), [suites]);
  const [planView, setPlanView] = useState("list");
  const [selectedSuiteId, setSelectedSuiteId] = useState("");
  const [activeTab, setActiveTab] = useState("Execute");
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [sidebarNotice, setSidebarNotice] = useState("");
  const [mainNotice, setMainNotice] = useState("");

  useEffect(() => {
    setSidebarNotice("");
    setMainNotice("");
  }, [selectedSuiteId, selectedCaseId, activeTab, planView]);
  const [openSuiteGroups, setOpenSuiteGroups] = useState({});
  const [isProductOpen, setIsProductOpen] = useState(true);
  const selectedSuite = suites.find((suite) => suite.id === selectedSuiteId) || suites[0] || null;
  const selectedCases = selectedSuite?.cases || [];
  const selectedCase = selectedCases.find((caseItem) => caseItem.id === selectedCaseId) || null;
  const passRate = counts.total ? Math.round(((counts.PASS || 0) / counts.total) * 100) : 0;

  useEffect(() => {
    if (!selectedSuiteId && suites[0]?.id) setSelectedSuiteId(suites[0].id);
  }, [selectedSuiteId, suites]);

  useEffect(() => {
    setOpenSuiteGroups((previous) => {
      const next = { ...previous };
      for (const group of suiteGroups) {
        if (next[group.label] === undefined) next[group.label] = true;
        for (const folder of group.folders) {
          const key = `${group.label}/${folder.label}`;
          if (next[key] === undefined) next[key] = true;
        }
      }
      return next;
    });
  }, [suiteGroups]);

  if (planView === "list") {
    return <AzurePlanList plans={plans} counts={counts} testPlan={testPlan} notice={mainNotice} setNotice={setMainNotice} onOpenPlan={() => setPlanView("detail")} />;
  }

  return <section className="azure-test-plan-workspace">
    <aside className="azure-plan-sidebar">
      <div className="azure-plan-title">
        <div>
          <h2>{plan?.label || "Test Plan"}</h2>
          <span>{plan?.product || "Core Platform"} · {plan?.version || "Automation"}</span>
        </div>
        <button className="icon-button" title="Plan actions" aria-label="Plan actions" onClick={() => setSidebarNotice("Plan actions opened. This automation workspace currently has one active plan.")}><ChevronDown size={16} /></button>
      </div>
      {sidebarNotice ? <p className="azure-inline-notice">{sidebarNotice}</p> : null}
      <div className="azure-plan-stats">
        <span>{counts.total || 0} test points</span>
        <strong>{passRate}% passed</strong>
        <a href="/report/latest" target="_blank" rel="noreferrer">View report</a>
      </div>
      <div className="azure-suite-heading">
        <h3>Test Suites</h3>
        <div className="azure-suite-tools">
          <button title="Show suites" onClick={() => setSidebarNotice(`${suites.length} suites are available in this automation plan.`)}><ClipboardList size={15} /></button>
          <button title="Add suite" onClick={() => setSidebarNotice("Suite creation will be enabled when a second automation plan is added.")}><Plus size={15} /></button>
          <button title="Delete suite" onClick={() => setSidebarNotice("Default automation suites are protected and cannot be deleted from this view.")}><Trash2 size={15} /></button>
        </div>
      </div>
      <label className="azure-suite-filter">
        <Search size={15} />
        <input placeholder="Filter suites by name" />
      </label>
      <div className="azure-suite-list" role="tree">
        {suites.length === 0 ? <p className="empty">No suites available.</p> : (
          <section className="azure-suite-plan-root">
            <button
              className="azure-suite-product-title"
              onClick={() => setIsProductOpen((previous) => !previous)}
              aria-expanded={isProductOpen}
            >
              {isProductOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>{plan?.product || "Core Platform"}</span>
              <strong>{counts.total || 0}</strong>
            </button>
            {isProductOpen ? suiteGroups.map((group) => (
              <section className="azure-suite-group" key={group.label}>
            <button
              className="azure-suite-group-title"
              onClick={() => setOpenSuiteGroups((previous) => ({ ...previous, [group.label]: !previous[group.label] }))}
            >
              {openSuiteGroups[group.label] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>{group.label}</span>
              <strong>{group.total}</strong>
            </button>
                {openSuiteGroups[group.label] ? group.folders.map((folder) => {
              const folderKey = `${group.label}/${folder.label}`;
              return <section className="azure-suite-folder" key={folderKey}>
                <button
                  className="azure-suite-folder-title"
                  onClick={() => setOpenSuiteGroups((previous) => ({ ...previous, [folderKey]: !previous[folderKey] }))}
                >
                  {openSuiteGroups[folderKey] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{folder.label}</span>
                  <strong>{folder.total}</strong>
                </button>
                {openSuiteGroups[folderKey] ? folder.suites.map((suite) => (
                  <button
                    key={suite.id}
                    className={`azure-suite-case ${selectedSuite?.id === suite.id && !selectedCaseId ? "selected" : ""}`}
                    onClick={() => {
                      setSelectedSuiteId(suite.id);
                      setSelectedCaseId("");
                    }}
                  >
                    <span>{suite.summaryLabel}</span>
                    <strong>{suite.cases.length}</strong>
                  </button>
                )) : null}
              </section>;
            }) : null}
              </section>
            )) : null}
          </section>
        )}
      </div>
    </aside>
    <section className="azure-plan-main">
      {selectedCase ? (
        <AzureRunResultView
          cases={selectedCases}
          selectedCase={selectedCase}
          suite={selectedSuite}
          testPlan={testPlan}
          onBack={() => setSelectedCaseId("")}
          onSelectCase={(caseItem) => setSelectedCaseId(caseItem.id)}
          setNotice={setMainNotice}
        />
      ) : (
        <>
          <div className="azure-main-heading">
            <div>
              <h2><button className="azure-back-link" onClick={() => setPlanView("list")}>Back to Test Plans</button>{plan?.label || "Test Plan"} <span>(ID: {plan?.suiteId || plan?.id || "automation"})</span></h2>
              <small>{testPlan?.updatedAt ? `Updated ${formatDate(testPlan.updatedAt)}` : "Waiting for first run"}</small>
            </div>
            <div className="azure-main-actions">
              <span className={`outcome-badge ${String(testPlan?.runStatus || "").toLowerCase()}`}>{testPlan?.runStatus || "not-run"}</span>
              <button onClick={onRunAutomation} disabled={running}><Play size={16} /> Run automation</button>
            </div>
          </div>
          <div className="azure-tabs" role="tablist">
            {["Define", "Execute", "Chart", "Export"].map((tab) => (
              <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>{tab}</button>
            ))}
          </div>
          {mainNotice ? <p className="azure-inline-notice main">{mainNotice}</p> : null}
          {activeTab === "Execute" ? <AzureExecuteTab cases={selectedCases} suite={selectedSuite} running={running} onRunAutomation={onRunAutomation} setNotice={setMainNotice} onOpenCase={(caseItem) => setSelectedCaseId(caseItem.id)} /> : null}
          {activeTab === "Define" ? <AzureDefineTab cases={selectedCases} suite={selectedSuite} setNotice={setMainNotice} /> : null}
          {activeTab === "Chart" ? <AzureChartTab counts={counts} /> : null}
          {activeTab === "Export" ? <AzureExportTab /> : null}
        </>
      )}
    </section>
  </section>;
}

function AzurePlanList({ plans, counts, testPlan, notice, setNotice, onOpenPlan }) {
  const plan = plans[0] || {};
  const [scope, setScope] = useState("All");
  const [filter, setFilter] = useState("");
  const [filterState, setFilterState] = useState({
    state: "Active",
    area: plan.product || "Core Platform",
    iteration: plan.version || "MISC v1",
    assignedTo: "Automation"
  });
  const cycleFilter = (key, values) => {
    const currentIndex = values.indexOf(filterState[key]);
    setFilterState((previous) => ({ ...previous, [key]: values[(currentIndex + 1) % values.length] }));
  };
  const planTitle = plan.label || "Regression Plan";
  const visible = !filter.trim() || planTitle.toLowerCase().includes(filter.trim().toLowerCase());
  return <section className="azure-plan-list-page">
    <div className="azure-plan-list-heading">
      <h2>Test Plans</h2>
      <button onClick={() => setNotice("New Test Plan is available after adding another automation suite family. Current workspace has one active plan.")}><Plus size={16} /> New Test Plan</button>
    </div>
    <div className="azure-plan-list-tabs">
      {["Mine", "All"].map((tab) => <button key={tab} className={scope === tab ? "active" : ""} onClick={() => setScope(tab)}>{tab}</button>)}
    </div>
    <div className="azure-plan-filter-bar">
      <label><Search size={15} /><input placeholder="Filter by title" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <button className="secondary" onClick={() => cycleFilter("state", ["Active", "Passed", "All"])}>State: {filterState.state} <ChevronDown size={14} /></button>
      <button className="secondary" onClick={() => cycleFilter("area", [plan.product || "Core Platform", "All"])}>Area Path: {filterState.area} <ChevronDown size={14} /></button>
      <button className="secondary" onClick={() => cycleFilter("iteration", [plan.version || "MISC v1", "All"])}>Iteration: {filterState.iteration} <ChevronDown size={14} /></button>
      <button className="secondary" onClick={() => cycleFilter("assignedTo", ["Automation", "All"])}>Assigned To: {filterState.assignedTo} <ChevronDown size={14} /></button>
    </div>
    {notice ? <p className="azure-inline-notice">{notice}</p> : null}
    <div className="azure-plan-list-table">
      <div className="azure-plan-list-row header"><span>Title</span><span>Test Plan ID</span><span>State</span><span>Area Path</span><span>Iteration</span><span>Assigned To</span><span /></div>
      {visible ? (
        <button className="azure-plan-list-row" onClick={onOpenPlan}>
          <span><ClipboardList size={15} /> {planTitle}</span>
          <span>{plan.suiteId || plan.id || "complete-list-view-e2e"}</span>
          <span>{filterState.state === "Passed" ? "Passed" : "Active"}</span>
          <span>{plan.product || "Core Platform"}</span>
          <span>{plan.version || "MISC v1"}</span>
          <span><span className="azure-avatar">QA</span> Automation</span>
          <span>{counts.PASS || 0}/{counts.total || 0} passed</span>
        </button>
      ) : <p className="empty">No test plans match this filter.</p>}
    </div>
    <p className="azure-plan-list-footnote">Showing {scope.toLowerCase()} plans · Latest run: {testPlan?.runStatus || "not-run"} · Updated {formatDate(testPlan?.updatedAt)}</p>
  </section>;
}

function collectPlanSuites(plan) {
  const suites = [];
  const walk = (node, path = []) => {
    if (!node) return;
    const nextPath = node.label ? [...path, node.label] : path;
    const cases = Array.isArray(node.cases) ? node.cases : [];
    if (cases.length > 0) {
      const rawSuitePath = nextPath.slice(1);
      const productLabel = String(plan?.product || "").trim().toLowerCase();
      const suitePath =
        productLabel && String(rawSuitePath[0] || "").trim().toLowerCase() === productLabel
          ? rawSuitePath.slice(1)
          : rawSuitePath;
      suites.push({
        id: node.id,
        label: node.label,
        path: suitePath,
        folderLabel: suitePath[1] || "General",
        caseLabel: suitePath.slice(2).join(" / ") || node.label,
        summaryLabel: `${suitePath[0] || "Automation"} ${node.label} workflows`,
        cases
      });
    }
    (node.children || []).forEach((child) => walk(child, nextPath));
  };
  walk(plan);
  return suites;
}

function groupPlanSuites(suites) {
  const groups = new Map();
  for (const suite of suites) {
    const label = suite.path[0] || "Other";
    const existing = groups.get(label) || { label, suites: [], total: 0 };
    existing.suites.push(suite);
    existing.total += suite.cases.length;
    groups.set(label, existing);
  }
  return [...groups.values()].map((group) => {
    const folderMap = new Map();
    for (const suite of group.suites) {
      const folder = folderMap.get(suite.folderLabel) || { label: suite.folderLabel, suites: [], total: 0 };
      folder.suites.push(suite);
      folder.total += suite.cases.length;
      folderMap.set(folder.label, folder);
    }
    return { ...group, folders: [...folderMap.values()] };
  });
}

function AzureExecuteTab({ cases, suite, running, onRunAutomation, setNotice, onOpenCase }) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const toggleCase = (id) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const allSelected = cases.length > 0 && cases.every((caseItem) => selectedIds.has(caseItem.id));
  return <div className="azure-tab-panel">
    <div className="azure-grid-heading">
      <h3>Test passed</h3>
      <div className="azure-grid-actions">
        <button className="secondary" onClick={() => setNotice(`${selectedIds.size || cases.length} test point outcome(s) already come from the latest automation run.`)}><CheckSquare size={16} /> Mark outcome</button>
        <button onClick={onRunAutomation} disabled={running}><Play size={16} /> Run for web application</button>
      </div>
    </div>
    <div className="azure-test-points azure-run-step-table">
      <div className="azure-run-step-row header">
        <strong>Step</strong>
        <strong>Outcome</strong>
        <strong>Action</strong>
        <strong>Expected Result</strong>
      </div>
      {cases.length === 0 ? <p className="empty">No test points in this suite.</p> : cases.flatMap((caseItem, caseIndex) => {
        const outcome = String(caseItem.outcome || "PENDING").toUpperCase();
        const normalizedOutcome = outcome === "PASS" ? "Passed" : outcome === "FAIL" ? "Failed" : outcome;
        return planStepRowsForCase(caseItem, suite).map((step, stepIndex) => <article key={`${caseItem.id}-${stepIndex}`} className={`azure-run-step-row ${caseIndex === 1 && stepIndex === 0 ? "selected" : ""}`} onClick={() => onOpenCase?.(caseItem)}>
          <strong>{step.step}</strong>
          <span className={`azure-outcome ${outcome.toLowerCase()}`}>{normalizedOutcome}</span>
          <span>{step.action}</span>
          <span>{toVerifyExpected(step.expected)}</span>
        </article>);
      })}
    </div>
  </div>;
}

function planStepRowsForCase(caseItem, suite) {
  const suitePath = suite?.path?.join(" / ") || "Apps";
  const rowsByCase = {
    "TC-001": [
      ["Open Admin", "Admin application is loaded and the user is authenticated."],
      ["Go to Apps list", "Apps list page is visible with list-view controls available."],
      ["Create a disposable app", "New app is saved successfully."],
      ["Search and verify app appears", "New app appears in the Apps list."]
    ],
    "TC-002": [
      ["Open Admin", "Admin application is loaded and the user is authenticated."],
      ["Go to Apps list-view actions", "List-view action controls are available."],
      ["Create a disposable custom list view", "New list view is saved successfully."],
      ["Verify the list view is available", "New list view appears under the app."]
    ],
    "TC-003": [
      ["Open Admin", "Admin application is loaded and the user is authenticated."],
      ["Find the disposable app", "Disposable app row is found in the Apps list."],
      ["Delete the app", "Delete confirmation completes successfully."],
      ["Search again and verify it is removed", "App removed from the Apps list."]
    ],
    "TC-004": [
      ["Open Admin", "Admin application is loaded and the user is authenticated."],
      ["Go to Apps list", "Apps list page is visible."],
      ["Enter app name in search", "Search request filters the Apps list."],
      ["Verify matching app row is shown", "Matching app appears in search results."]
    ],
    "TC-005": [
      ["Complete TC-001", "Admin-created app exists before Keystone validation starts."],
      ["Open Keystone", "Keystone application is loaded and the user is authenticated."],
      ["Open app launcher/list", "Keystone app list is visible."],
      ["Verify Admin-created app is visible", "New app appears in Keystone app list."]
    ],
    "TC-006": [
      ["Complete TC-002", "Admin-created list view exists before Keystone validation starts."],
      ["Open Keystone", "Keystone application is loaded and the user is authenticated."],
      ["Select the relevant app/tab", "Correct app and tab are opened in Keystone."],
      ["Verify Admin-created list view is selectable", "New list view appears under correct app."]
    ]
  };
  const rows = rowsByCase[caseItem.id] || [[caseItem.title, caseItem.expected]];
  return rows.map(([action, expected], index) => ({
    step: `${caseItem.id}.${index + 1}`,
    action: `${action} (${suitePath})`,
    expected
  }));
}

function toVerifyExpected(value) {
  const text = String(value || "the expected result is reached.").trim();
  return /^verify\b/i.test(text) ? text : `Verify ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function TestCasePlanBlock({ caseItem, outcome }) {
  const normalizedOutcome = outcome === "PASS" ? "pass" : outcome === "FAIL" ? "fail" : outcome.toLowerCase();
  return <div className="azure-case-plan-block">
    <h4><span aria-hidden="true">🧪</span> {caseItem.id}</h4>
    <dl>
      <dt>Title</dt><dd>{caseItem.title.replace(/\s*\([^)]+\)\s*$/, "")}</dd>
      <dt>Expected</dt><dd>{caseItem.expected || "Expected result is defined in the automation plan."}</dd>
      <dt>Actual</dt><dd>{caseItem.actual || "(captured at runtime)"}</dd>
      <dt>Outcome</dt><dd><span className={`azure-outcome ${outcome.toLowerCase()}`}>{normalizedOutcome}</span></dd>
    </dl>
  </div>;
}

function AzureRunResultView({ cases, selectedCase, suite, testPlan, onBack, onSelectCase, setNotice }) {
  const outcome = String(selectedCase.outcome || "PENDING").toUpperCase();
  const outcomeLabel = outcome === "PASS" ? "passed" : outcome === "FAIL" ? "failed" : outcome.toLowerCase();
  const [activeResultTab, setActiveResultTab] = useState("Summary");
  const [showImages, setShowImages] = useState(false);
  const resultTitle = selectedCase.resultRef?.title || selectedCase.title;
  const attachments = [
    ["Latest HTML report", testPlan?.report?.html || "/report/latest"],
    ["JSON result payload", testPlan?.report?.json || "/report/list-view-regression-results.json"]
  ];
  const steps = [
    { label: "Resolve automation context", testSteps: `Open ${suite?.path?.join(" / ") || "automation suite"} and select ${selectedCase.id}.`, actual: "Target suite and test point are available in the automation plan.", expected: "Developers can identify the exact automation scope before execution.", outcome },
    { label: "Execute automated validation", testSteps: resultTitle, actual: selectedCase.actual || "Captured from latest Playwright automation run.", expected: selectedCase.expected, outcome },
    { label: "Review evidence and outcome", testSteps: "Open attached report artifacts and confirm the recorded status.", actual: `${outcome} result linked with latest report evidence.`, expected: "Result can be reviewed from report artifacts without rerunning manually.", outcome }
  ];

  return <div className="azure-result-workspace">
    <aside className="azure-result-list">
      <div className="azure-result-list-title">
        <button className="secondary" onClick={onBack}>Back</button>
        <strong>Run · {testPlan?.runStatus || "latest automation"}</strong>
      </div>
      <label className="azure-suite-filter">
        <Search size={15} />
        <input placeholder="Search by test case ID" />
      </label>
      <div className="azure-result-items">
        {cases.map((caseItem) => {
          const itemOutcome = String(caseItem.outcome || "PENDING").toUpperCase();
          return <button key={caseItem.id} className={caseItem.id === selectedCase.id ? "selected" : ""} onClick={() => onSelectCase(caseItem)}>
            <span className={`azure-status-dot ${itemOutcome.toLowerCase()}`} />
            <span>{caseItem.title}</span>
            <small>{caseItem.id}</small>
          </button>;
        })}
      </div>
    </aside>
    <section className="azure-result-detail">
      <div className="azure-result-header">
        <span className={`outcome-badge ${outcome.toLowerCase()}`}>{outcome}</span>
        <div>
          <h2>{selectedCase.title} ({selectedCase.id})</h2>
          <small>{suite?.path?.join(" / ") || "Automation suite"}</small>
        </div>
      </div>
      <div className="azure-result-tabs">
        {["Summary", "Attachments"].map((tab) => (
          <button key={tab} className={activeResultTab === tab ? "active" : ""} onClick={() => setActiveResultTab(tab)}>
            {tab}{tab === "Attachments" ? <span>{attachments.length}</span> : null}
          </button>
        ))}
      </div>
      {activeResultTab === "Summary" ? <>
      <article className="azure-case-plan-card azure-case-plan-card-detail">
        <TestCasePlanBlock caseItem={selectedCase} outcome={outcome} />
      </article>
      <div className="azure-summary-grid">
        <article>
          <h3>Summary</h3>
          <dl>
            <dt>Run by</dt><dd>Automation</dd>
            <dt>Pipeline run tested</dt><dd>{testPlan?.runStatus || "Latest local run"}</dd>
            <dt>Configuration</dt><dd>Playwright · Chromium</dd>
            <dt>Completed time</dt><dd>{formatDate(testPlan?.updatedAt)}</dd>
            <dt>Test suite</dt><dd>{suite?.path?.join(" / ") || "-"}</dd>
            <dt>Test case</dt><dd>{selectedCase.id}</dd>
          </dl>
        </article>
        <article>
          <h3>Analysis</h3>
          <dl>
            <dt>Analysis owner</dt><dd>Automation</dd>
            <dt>Comment</dt><dd>{selectedCase.actual || "No analysis note captured."}</dd>
          </dl>
        </article>
      </div>
      </> : <div className="azure-attachment-list">{attachments.map(([label, href]) => <a key={href} href={href} target="_blank" rel="noreferrer">{label}</a>)}</div>}
      <article className="azure-linked-work">
        <div><h3>Linked work items</h3><span>No work items linked</span></div>
        <button className="secondary" onClick={() => setNotice(`Work item link action opened for ${selectedCase.id}.`)}><Plus size={16} /> Add</button>
      </article>
      <section className="azure-steps-panel">
        <div className="azure-steps-heading">
          <strong><span className={`azure-status-dot ${outcome.toLowerCase()}`} /> Test {outcomeLabel}</strong>
          <span>Completed {formatDate(testPlan?.updatedAt)}</span>
          <label><input type="checkbox" checked={showImages} onChange={(event) => setShowImages(event.target.checked)} /> Show images</label>
        </div>
        {showImages ? <div className="azure-image-placeholder">Image evidence is available from the attached Playwright report links.</div> : null}
        <div className="azure-step-table">
          <div className="azure-step-row header"><span>Step</span><span>Outcome</span><span>Action</span><span>Expected Result</span></div>
          {steps.map((step, index) => <div key={step.label} className="azure-step-row">
            <span>{index + 1}</span>
            <span className={`azure-outcome ${step.outcome.toLowerCase()}`}>{step.outcome === "PASS" ? "Passed" : step.outcome === "FAIL" ? "Failed" : step.outcome}</span>
            <span>{step.testSteps}</span>
            <span>{toVerifyExpected(step.expected)}</span>
          </div>)}
          <div className="azure-attachments">
            <strong>Attachments</strong>
            {attachments.map(([label, href]) => <a key={href} href={href} target="_blank" rel="noreferrer">{label}</a>)}
          </div>
        </div>
      </section>
    </section>
  </div>;
}

function AzureDefineTab({ cases, suite, setNotice }) {
  return <div className="azure-tab-panel">
    <div className="azure-grid-heading"><h3>{suite?.label || "Suite"} definitions</h3><button onClick={() => setNotice("New automated case draft flow will open here when authoring is enabled.")}><Plus size={16} /> New automated case</button></div>
    <div className="azure-define-list">
      {cases.map((caseItem) => <article key={caseItem.id} className="azure-define-case">
        <strong>{caseItem.id}</strong>
        <div>
          <span>{caseItem.title}</span>
          <small>{toVerifyExpected(caseItem.expected)}</small>
          <div className="azure-define-step-table">
            <div className="azure-define-step-row header"><b>Step</b><b>Action</b><b>Expected Result</b></div>
            {planStepRowsForCase(caseItem, suite).map((step) => (
              <div className="azure-define-step-row" key={step.step}>
                <b>{step.step}</b>
                <span>{step.action}</span>
                <span>{toVerifyExpected(step.expected)}</span>
              </div>
            ))}
          </div>
        </div>
      </article>)}
    </div>
  </div>;
}

function AzureChartTab({ counts }) {
  const rows = [["Passed", counts.PASS || 0, "pass"], ["Failed", counts.FAIL || 0, "fail"], ["Blocked", counts.BLOCKED || 0, "skip"], ["Pending", counts.PENDING || 0, "pending"]];
  const total = Math.max(1, counts.total || 0);
  return <div className="azure-tab-panel azure-chart-panel">{rows.map(([label, value, tone]) => <div key={label}><span>{label}</span><strong>{value}</strong><i className={tone} style={{ width: `${Math.max(4, (value / total) * 100)}%` }} /></div>)}</div>;
}

function AzureExportTab() {
  const exports = [
    {
      title: "Latest HTML Report",
      description: "Interactive visual report from the latest automation run with steps, outcomes, and screenshots.",
      badge: "HTML",
      url: "/report/latest",
      icon: FileBarChart,
      color: "#ef4444"
    },
    {
      title: "CSV Dataset",
      description: "Tabular flat data containing all test points, paths, and status fields suitable for custom integrations.",
      badge: "CSV",
      url: "/report/list-view-regression-results.csv",
      icon: Database,
      color: "#3b82f6"
    },
    {
      title: "JSON Result Payload",
      description: "Full detailed structured test plan result payload containing metadata, configurations, and step history.",
      badge: "JSON",
      url: "/report/list-view-regression-results.json",
      icon: Database,
      color: "#a855f7"
    },
    {
      title: "Excel Case Inventory",
      description: "Exportable spreadsheet containing the full list of automated cases and templates for manual uploads.",
      badge: "XLSX",
      url: "/api/inventory.xlsx?refresh=1",
      icon: FileSpreadsheet,
      color: "#10b981"
    }
  ];

  return (
    <div className="azure-tab-panel azure-export-panel">
      <div className="azure-export-grid">
        {exports.map((item, index) => {
          const Icon = item.icon;
          return (
            <a
              key={index}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="azure-export-card"
            >
              <div className="azure-export-card-header">
                <div className="azure-export-icon-wrapper" style={{ backgroundColor: `${item.color}15`, color: item.color }}>
                  <Icon size={22} />
                </div>
                <span className="azure-export-badge">{item.badge}</span>
              </div>
              <div className="azure-export-card-body">
                <h3>{item.title}</h3>
                <p>{item.description}</p>
              </div>
              <div className="azure-export-card-footer">
                <span className="azure-export-action">
                  <span>Download</span>
                  <Download size={14} />
                </span>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function InventoryPanel({ rows, filter, setFilter, selectedTests, toggleSelected, selectVisible, selectAll, clearSelected, refresh, context, clearContext, backToSuites, runSelected, running }) {
  return <section className="panel inventory-panel"><div className="section-heading toolbar-heading"><div><h2>{context ? `${context.label} Test Cases` : "Selectable Test Inventory"}</h2><span>{rows.length} visible cases · {selectedTests.size} selected</span></div><div className="inline-actions">{context ? <button className="secondary" onClick={backToSuites}>Back</button> : null}<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by tag, surface, feature, case, step" />{context ? <button className="secondary" onClick={clearContext}>All Cases</button> : null}<button onClick={runSelected} disabled={running || selectedTests.size === 0}><Play size={16} /> Run Selected {selectedTests.size}</button><a className="secondary" href="/api/inventory.xlsx?refresh=1"><Download size={16} /> Excel</a><button className="secondary" onClick={refresh}><RefreshCw size={16} /> Refresh</button><button className="secondary" onClick={selectAll}>Select All</button><button className="secondary" onClick={selectVisible}>Select Visible</button><button className="secondary" onClick={clearSelected}>Clear</button></div></div><DataTable rows={rows} columns={[["select", "Select"], ["id", "ID"], ["tags", "Tags"], ["testingLevel", "Category"], ["surface", "Surface"], ["feature", "Scenario"], ["displayTitle", "Test Case"], ["steps", "Step Details"], ["expected", "Expected Result"], ["proof", "What It Proves"]]} renderCell={(row, key) => key === "select" ? <input type="checkbox" checked={selectedTests.has(row.title)} onChange={() => toggleSelected(row.title)} /> : key === "steps" ? <StepDetails steps={structuredStepsForRow(row)} /> : null} /></section>;
}

function ExecutionPanel({ status, stopRun }) {
  return <section className="section-stack"><div className="metric-grid execution-metrics"><Metric label="Status" value={status.running ? "Running" : "Idle"} /><Metric label="Surface" value={status.surface || "-"} /><Metric label="Scenario" value={summarizeScenario(status)} /><Metric label="Selected" value={status.selectedTestCount || 0} /><Metric label="Exit Code" value={status.exitCode ?? "-"} /></div><div className="panel"><div className="section-heading"><h2>Live Output</h2><button className="danger" onClick={stopRun} disabled={!status.running}><Square size={16} /> Stop Run</button></div><pre className="logs">{(status.logs || []).join("\n") || "No run started."}</pre></div></section>;
}

function ReportsPanel({ results }) {
  const counts = results.counts || {};
  const report = results.report || {};
  const links = [
    ["HTML Report", report.html || "/report/list-view-regression-results.html"],
    ["Test Cases Excel", "/api/inventory.xlsx?refresh=1"],
    ["CSV", report.csv || "/report/list-view-regression-results.csv"],
    ["JSON", report.json || "/report/list-view-regression-results.json"],
    ["PDF", report.pdf || "/report/list-view-regression-results.pdf"]
  ];
  return <section className="section-stack">
    <div className="metric-grid compact">
      <Metric label="Total" value={results.total || results.rows?.length || 0} />
      <Metric label="Passed" value={counts.PASS || 0} tone="pass" />
      <Metric label="Failed" value={counts.FAIL || 0} tone="fail" />
      <Metric label="Running" value={counts.RUNNING || 0} tone="running" />
      <Metric label="Skipped" value={counts.SKIP || 0} tone="skip" />
    </div>
    <section className="panel">
      <div className="section-heading">
        <div><h2>Report Exports</h2><span>{results.updatedAt ? `${report.label || "Latest report"} updated ${formatDate(results.updatedAt)}` : "Waiting for first run"}</span></div>
      </div>
      <div className="report-card-grid">
        {links.map(([label, href]) => <a key={href} href={href} target="_blank" rel="noreferrer">{label}</a>)}
      </div>
    </section>
    <DataTable className="report-rows-panel" title={`Report Rows (${results.total || 0})`} rows={results.rows || []} columns={[["id", "ID"], ["tags", "Tags"], ["moduleSuite", "Module / Suite"], ["testCaseTitle", "Test Case"], ["steps", "Step Details"], ["executionSource", "Input Source"], ["requestedBy", "Requested By"], ["performedBy", "Performed By"], ["fieldsUpdated", "Fields Updated"], ["inputDataSummary", "Input Data"], ["expectedResult", "Expected"], ["actualResult", "Actual"], ["directUrl", "Direct URL"], ["status", "Status"], ["automationStatus", "Automation"]]} renderCell={(row, key) => key === "steps" ? <StepDetails steps={structuredStepsForRow(row)} /> : key === "directUrl" && row.directUrl ? <a href={row.directUrl} target="_blank" rel="noreferrer">Open URL</a> : null} />
  </section>;
}

function BugsPanel({ failedRows }) {
  return <section className="panel"><DataTable title={`Bug Report (${failedRows.length})`} rows={failedRows} columns={[["id", "ID"], ["surface", "Surface"], ["featureArea", "Feature"], ["bugReport", "Bug Summary"], ["actualResult", "Actual Result"]]} /></section>;
}

function AgentPanel({
  agent,
  setAgent,
  runAgentScan,
  runAgentGenerate,
  runAgentGenerated,
  commitAgentGenerated,
  syncAgentMain,
  saveScheduler,
  runScheduledNow,
  running
}) {
  const generatedCount = agent.generated?.scenarios?.length || 0;
  const sync = agent.sync || agent.scheduler?.sync || {};
  const graph = agent.graph || {};
  const schedulerConfig = agent.scheduler?.config || {};
  const updateScheduler = (patch) => saveScheduler({ ...schedulerConfig, ...patch });
  return <section className="section-stack">
    <div className="panel">
      <div className="section-heading"><div><h2>AI Test Agent</h2><span>Sync main, graph changes, generate specs, run, then commit</span></div><GitBranch size={20} /></div>
      <div className="metric-grid compact agent-metrics">
        <Metric label="Target repo" value={sync.appRoot || "D:\\core-platform"} />
        <Metric label="Branch" value={sync.branch || "main"} />
        <Metric label="Remote changes" value={sync.behindCount || 0} tone={sync.hasRemoteChanges ? "running" : ""} />
        <Metric label="Worktree" value={sync.clean === false ? "Dirty" : "Clean"} tone={sync.clean === false ? "fail" : "pass"} />
        <Metric label="Scheduler" value={schedulerConfig.enabled ? "On" : "Off"} />
      </div>
      <div className="agent-controls">
        <label>Base ref <input value={agent.baseRef} onChange={(event) => setAgent((previous) => ({ ...previous, baseRef: event.target.value }))} /></label>
        <button className="secondary" onClick={syncAgentMain} disabled={agent.busy || running}><RefreshCw size={16} /> Sync Main</button>
        <button onClick={runAgentScan} disabled={agent.busy || running}><Search size={16} /> Scan Changes</button>
        <button onClick={runAgentGenerate} disabled={agent.busy || running}><Bot size={16} /> Generate Specs</button>
        <button onClick={() => runAgentGenerated(false)} disabled={agent.busy || running || generatedCount === 0}><Play size={16} /> Run Generated</button>
        <button className="secondary" onClick={() => runAgentGenerated(true)} disabled={agent.busy || running || generatedCount === 0}><RefreshCw size={16} /> Run Generated With Reset</button>
      </div>
      <div className="agent-controls">
        <label>Branch <input value={agent.branchName} onChange={(event) => setAgent((previous) => ({ ...previous, branchName: event.target.value }))} /></label>
        <label><input type="checkbox" checked={agent.push} onChange={(event) => setAgent((previous) => ({ ...previous, push: event.target.checked }))} /> Push to origin</label>
        <button className="secondary" onClick={commitAgentGenerated} disabled={agent.busy || running || generatedCount === 0}><CheckSquare size={16} /> Commit & Push Generated</button>
      </div>
      {agent.generated?.spec ? <p className="muted">Spec: <code>{agent.generated.spec}</code></p> : null}
      {agent.generated?.outputPath ? <p className="muted">Manifest: <code>{agent.generated.outputPath}</code></p> : null}
      {agent.generated?.requiresReset ? <p className="muted">Reset required: guarded write scenarios will run with <code>ALLOW_DATA_WRITE=true</code> and restore seeded data after completion.</p> : null}
      {graph.outputPath ? <p className="muted">Graph: <code>{graph.outputPath}</code></p> : null}
      {sync.pullBlocked ? <p className="danger-text">Main pull is blocked because the target app repo has local changes. Fetch still completed, so remote changes are visible.</p> : null}
      {agent.commit ? <p className="pass">Committed on {agent.commit.branchName}{agent.commit.pushed ? " and pushed" : ""}.</p> : null}
      {agent.error ? <p className="danger-text">{agent.error}</p> : null}
    </div>
    <div className="panel">
      <div className="section-heading"><div><h2>Automatic Main Pull and Schedule</h2><span>Poll main and run complete suites without overlapping active runs</span></div></div>
      <div className="agent-controls">
        <label><input type="checkbox" checked={Boolean(schedulerConfig.enabled)} onChange={(event) => updateScheduler({ enabled: event.target.checked })} /> Enabled</label>
        <label><input type="checkbox" checked={schedulerConfig.autoPull !== false} onChange={(event) => updateScheduler({ autoPull: event.target.checked })} /> Auto pull clean repo</label>
        <label><input type="checkbox" checked={schedulerConfig.runAfterMainChange !== false} onChange={(event) => updateScheduler({ runAfterMainChange: event.target.checked })} /> Run after main changes</label>
        <label>Poll minutes <input type="number" min="1" value={schedulerConfig.pollMinutes || 15} onChange={(event) => updateScheduler({ pollMinutes: Number(event.target.value || 15) })} /></label>
        <label>Daily time <input type="time" value={schedulerConfig.dailyTime || ""} onChange={(event) => updateScheduler({ dailyTime: event.target.value })} /></label>
        <label>Scope <select value={schedulerConfig.scope || "complete"} onChange={(event) => updateScheduler({ scope: event.target.value })}><option value="complete">Complete</option><option value="bvt">BVT</option><option value="sanity">Sanity</option><option value="regression">Regression</option></select></label>
        <button onClick={runScheduledNow} disabled={agent.busy || running}><Play size={16} /> Run Complete Now</button>
      </div>
      <p className="muted">Last successful checkpoint: <code>{agent.scheduler?.state?.lastSuccessfulAgentCommit || agent.scheduler?.state?.baselineCommit || "not set"}</code></p>
    </div>
    {graph.nodes ? <DataTable title={`Graph Impact Nodes (${graph.nodes?.length || 0})`} rows={graph.nodes || []} columns={[["path", "Path"], ["area", "Area"], ["surface", "Surface"], ["risk", "Risk"], ["reason", "Reason"]]} /> : null}
    {graph.commits ? <DataTable title={`Main Commit Range (${graph.commits?.length || 0})`} rows={graph.commits || []} columns={[["commit", "Commit"], ["message", "Message"]]} /> : null}
    {agent.scan ? <DataTable title={`Changed Files (${agent.scan.changedFiles?.length || 0})`} rows={agent.scan.changedFiles || []} columns={[["path", "Path"], ["area", "Area"], ["risk", "Risk"], ["reason", "Reason"]]} /> : null}
    {agent.generated ? <DataTable title={`Generated Runnable Scenarios (${generatedCount})`} rows={agent.generated.scenarios || []} columns={[["id", "ID"], ["scenarioFamily", "Family"], ["surfaceLabel", "Surface"], ["feature", "Feature"], ["level", "Testing"], ["tag", "Tag"], ["action", "Action"], ["coverageDecision", "Coverage"], ["testCase", "Test Case"], ["risk", "Risk"], ["graphSource", "Graph"], ["graphEvidence", "Evidence"], ["sourcePath", "Source"]]} /> : null}
  </section>;
}

function SettingsPanel({ framework, theme, setTheme }) {
  return <section className="panel settings-panel"><div className="section-heading"><h2>Framework Settings</h2><span>{framework?.appRoot || "D:\\core-platform"}</span></div><label>Theme <select value={theme} onChange={(event) => setTheme(event.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><p>Generated agent artifacts are stored in the automation repo and are intended for review branches before push.</p></section>;
}

function Metric({ label, value, tone = "" }) {
  return <article className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></article>;
}

function DataTable({ title, rows, columns, renderCell, className = "" }) {
  return <section className={`panel table-panel ${className}`.trim()}>{title ? <div className="section-heading"><h2>{title}</h2></div> : null}<div className="table-wrap"><table><thead><tr>{columns.map(([, label]) => <th key={label}>{label}</th>)}</tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={columns.length} className="empty">No rows available.</td></tr> : rows.map((row, index) => <tr key={row.id || row.title || row.path || index}>{columns.map(([key]) => { const custom = renderCell?.(row, key); return <td key={key}>{custom ?? String(row[key] ?? "")}</td>; })}</tr>)}</tbody></table></div></section>;
}

function StepDetails({ steps }) {
  const safeSteps = Array.isArray(steps) ? steps : [];
  if (safeSteps.length === 0) return <span className="muted">No step details.</span>;
  const visibleSteps = safeSteps.slice(0, 20);
  return <details className="step-details"><summary>{safeSteps.length} step details</summary><div className="step-list">{visibleSteps.map((step, index) => <article className="step-card" key={`${step.action || step.actionDone}-${index}`}><strong>{index + 1}. {step.section}</strong><dl><dt>Step</dt><dd>{step.step || index + 1}</dd><dt>Outcome</dt><dd>{step.outcome || step.result}</dd><dt>Action Done</dt><dd>{step.actionDone || step.action}</dd><dt>Fields Updated</dt><dd>{step.fieldsUpdated || "-"}</dd><dt>Input Data</dt><dd>{step.inputData || step.testData}</dd><dt>Input Source</dt><dd>{step.inputDataSource || "-"}</dd><dt>Expected Result</dt><dd>{step.expectedResult || step.expectedBehavior}</dd><dt>Direct URL</dt><dd>{step.directUrl ? <a href={step.directUrl} target="_blank" rel="noreferrer">Open URL</a> : "-"}</dd><dt>Result</dt><dd>{step.result}</dd></dl></article>)}{safeSteps.length > visibleSteps.length ? <p className="step-summary-note">Showing first {visibleSteps.length} of {safeSteps.length} details. Open the exported report for the full run log.</p> : null}</div></details>;
}

createRoot(document.getElementById("root")).render(<App />);
