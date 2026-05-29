import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot, Bug, CheckSquare, ChevronDown, ChevronRight, ClipboardList, FileBarChart, GitBranch,
  Download, LayoutDashboard, Moon, PanelLeftClose, PanelLeftOpen, Play, Radio, RefreshCw, Save, Search, Settings, Square, Sun,
  TestTube2, Video, Waypoints, XCircle
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

const useDashboardData = () => {
  const [framework, setFramework] = useState(null);
  const [services, setServices] = useState({ services: [] });
  const [status, setStatus] = useState({});
  const [results, setResults] = useState({ counts: {}, rows: [] });
  const [inventory, setInventory] = useState({ rows: [] });
  const [recording, setRecording] = useState({});
  const [recordedScenarios, setRecordedScenarios] = useState({ scenarios: [] });
  const [error, setError] = useState("");

  const refreshStatic = async (forceInventory = false) => {
    const [frameworkPayload, inventoryPayload] = await Promise.all([
      api("/api/framework"),
      api(`/api/inventory${forceInventory ? "?refresh=1" : ""}`)
    ]);
    setFramework(frameworkPayload);
    setInventory(inventoryPayload);
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

  return { framework, services, status, results, inventory, recording, recordedScenarios, error, refreshStatic, refreshLive };
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
      [row.id, row.tags, row.testingLevel, row.surface, row.feature, row.displayTitle, row.precondition, row.input, row.expected, row.proof]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [rows, filter, inventoryContext]);

  const selectedTitles = Array.from(selectedTests);
  const failedRows = resultRows.filter((row) => row.status === "FAIL");
  const counts = data.results.counts || {};

  const runSuite = async (nextSurface = surface, scenario = scenarioFilter, tests = [], headedOverride = headed) => {
    await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ surface: nextSurface, scenario, tests, reset, headed: headedOverride })
    });
    await data.refreshLive();
    setActive("execution");
  };

  const runCategory = async (level) => {
    const tests = rowsForCategory(level).map((row) => row.title);
    if (tests.length === 0) return;
    await runSuite("all", "", tests);
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
    if (active === "suites") return <SuitesPanel framework={data.framework} running={data.status.running} onOpen={openSuiteCases} onRun={(suite, runHeaded) => runSuite(suite.surface, suite.grep || "", [], runHeaded)} />;
    if (active === "scenarios") return <ScenariosPanel framework={data.framework} setScenarioFilter={setScenarioFilter} setActive={setActive} />;
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
        runSelected={() => runSuite(surface, "", selectedTitles)}
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
            <button onClick={() => runSuite(surface, "", selectedTitles)} disabled={data.status.running || selectedTitles.length === 0}><CheckSquare size={16} /> Run Selected {selectedTitles.length}</button>
            <button className="danger" onClick={stopRun} disabled={!data.status.running}><XCircle size={16} /> Stop</button>
            <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
          </div>
        </header>
        {data.error ? <div className="notice danger-text">{data.error}</div> : null}
        {renderSection()}
      </main>
    </div>
  );
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

function ScenariosPanel({ framework, setScenarioFilter, setActive }) {
  return <section className="card-grid">{(framework?.scenarios || []).map((scenario) => <article key={scenario.id} className="panel"><div className="section-heading"><h2>{scenario.label}</h2><span>{scenario.suiteId}</span></div><p>{scenario.description}</p><code>{scenario.grep || "No grep filter"}</code><button onClick={() => { setScenarioFilter(scenario.grep || ""); setActive("execution"); }}><Search size={16} /> Use Filter</button></article>)}</section>;
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

function InventoryPanel({ rows, filter, setFilter, selectedTests, toggleSelected, selectVisible, selectAll, clearSelected, refresh, context, clearContext, backToSuites, runSelected, running }) {
  return <section className="panel inventory-panel"><div className="section-heading toolbar-heading"><div><h2>{context ? `${context.label} Test Cases` : "Selectable Test Inventory"}</h2><span>{rows.length} visible cases · {selectedTests.size} selected</span></div><div className="inline-actions">{context ? <button className="secondary" onClick={backToSuites}>Back</button> : null}<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by tag, surface, feature, case, step" />{context ? <button className="secondary" onClick={clearContext}>All Cases</button> : null}<button onClick={runSelected} disabled={running || selectedTests.size === 0}><Play size={16} /> Run Selected {selectedTests.size}</button><a className="secondary" href="/api/inventory.xlsx?refresh=1"><Download size={16} /> Excel</a><button className="secondary" onClick={refresh}><RefreshCw size={16} /> Refresh</button><button className="secondary" onClick={selectAll}>Select All</button><button className="secondary" onClick={selectVisible}>Select Visible</button><button className="secondary" onClick={clearSelected}>Clear</button></div></div><DataTable rows={rows} columns={[["select", "Select"], ["id", "ID"], ["tags", "Tags"], ["testingLevel", "Category"], ["surface", "Surface"], ["feature", "Scenario"], ["displayTitle", "Test Case"], ["input", "Test Steps"], ["expected", "Expected Result"], ["proof", "What It Proves"]]} renderCell={(row, key) => key === "select" ? <input type="checkbox" checked={selectedTests.has(row.title)} onChange={() => toggleSelected(row.title)} /> : null} /></section>;
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
    <DataTable title={`Report Rows (${results.total || 0})`} rows={results.rows || []} columns={[["id", "ID"], ["tags", "Tags"], ["moduleSuite", "Module / Suite"], ["testCaseTitle", "Test Case"], ["expectedResult", "Expected"], ["actualResult", "Actual"], ["status", "Status"], ["automationStatus", "Automation"]]} />
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

function DataTable({ title, rows, columns, renderCell }) {
  return <section className="panel table-panel">{title ? <div className="section-heading"><h2>{title}</h2></div> : null}<div className="table-wrap"><table><thead><tr>{columns.map(([, label]) => <th key={label}>{label}</th>)}</tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={columns.length} className="empty">No rows available.</td></tr> : rows.map((row, index) => <tr key={row.id || row.title || row.path || index}>{columns.map(([key]) => { const custom = renderCell?.(row, key); return <td key={key}>{custom ?? String(row[key] ?? "")}</td>; })}</tr>)}</tbody></table></div></section>;
}

createRoot(document.getElementById("root")).render(<App />);
