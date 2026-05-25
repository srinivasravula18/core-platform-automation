import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, Bot, Bug, CheckSquare, ClipboardList, FileBarChart, GitBranch,
  LayoutDashboard, Moon, Play, Radio, RefreshCw, Save, Search, Settings, Square, Sun,
  TestTube2, Video, Waypoints, XCircle
} from "lucide-react";
import "./styles.css";

const navItems = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "services", label: "Services", icon: Activity },
  { id: "suites", label: "Suites", icon: TestTube2 },
  { id: "scenarios", label: "Scenarios", icon: Waypoints },
  { id: "recorder", label: "Recorder", icon: Radio },
  { id: "inventory", label: "Inventory", icon: ClipboardList },
  { id: "builder", label: "Case Builder", icon: CheckSquare },
  { id: "execution", label: "Execution", icon: Play },
  { id: "reports", label: "Reports", icon: FileBarChart },
  { id: "bugs", label: "Bugs", icon: Bug },
  { id: "agent", label: "AI Agent", icon: Bot },
  { id: "settings", label: "Settings", icon: Settings }
];

const formatDate = (value) => value ? new Date(value).toLocaleString() : "-";

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
  const [filter, setFilter] = useState("");
  const [selectedTests, setSelectedTests] = useState(new Set());
  const [scenarioFilter, setScenarioFilter] = useState("");
  const [surface, setSurface] = useState("all");
  const [headed, setHeaded] = useState(false);
  const [reset, setReset] = useState(false);
  const [agent, setAgent] = useState({ baseRef: "origin/main", scan: null, generated: null, busy: false, error: "" });
  const [recorder, setRecorder] = useState({ name: "", busy: false, error: "" });

  useEffect(() => {
    localStorage.setItem("qa-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const rows = Array.isArray(data.inventory.rows) ? data.inventory.rows : [];
  const resultRows = Array.isArray(data.results.rows) ? data.results.rows : [];
  const filteredRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.id, row.surface, row.feature, row.displayTitle, row.precondition, row.input, row.expected, row.proof]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [rows, filter]);

  const selectedTitles = Array.from(selectedTests);
  const failedRows = resultRows.filter((row) => row.status === "FAIL");
  const counts = data.results.counts || {};

  const runSuite = async (nextSurface = surface, scenario = scenarioFilter, tests = []) => {
    await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ surface: nextSurface, scenario, tests, reset, headed })
    });
    await data.refreshLive();
    setActive("execution");
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
    setActive("execution");
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

  const renderSection = () => {
    if (active === "services") return <ServicesPanel services={data.services} />;
    if (active === "suites") return <SuitesPanel framework={data.framework} onRun={(suite) => runSuite(suite.surface, suite.grep || "")} />;
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
        running={data.status.running}
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
        clearSelected={() => setSelectedTests(new Set())}
        refresh={() => data.refreshStatic(true)}
      />
    );
    if (active === "builder") return <BuilderPanel framework={data.framework} />;
    if (active === "execution") return <ExecutionPanel status={data.status} stopRun={stopRun} />;
    if (active === "reports") return <ReportsPanel results={data.results} />;
    if (active === "bugs") return <BugsPanel failedRows={failedRows} />;
    if (active === "agent") return <AgentPanel agent={agent} setAgent={setAgent} runAgentScan={runAgentScan} runAgentGenerate={runAgentGenerate} />;
    if (active === "settings") return <SettingsPanel framework={data.framework} theme={theme} setTheme={setTheme} />;
    return <OverviewPanel counts={counts} framework={data.framework} inventory={data.inventory} status={data.status} services={data.services} results={data.results} />;
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">CP</span>
          <div><strong>QA Framework</strong><small>Core Platform</small></div>
        </div>
        <nav aria-label="Framework sections">
          {navItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={active === item.id ? "nav-active" : ""} onClick={() => setActive(item.id)}><Icon size={17} /><span>{item.label}</span></button>;
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
    <div className="flow-panel"><div className="flow-node">Test Suite</div><div className="flow-line" /><div className="flow-node">Test Scenario</div><div className="flow-line" /><div className="flow-node">Test Case</div><div className="flow-line" /><div className="flow-node">Test Steps</div><div className="flow-line" /><div className="flow-node">Evidence and Bugs</div></div>
    <div className="metric-grid compact">
      <Metric label="Pending" value={counts.PENDING || 0} tone="pending" /><Metric label="Running" value={counts.RUNNING || 0} tone="running" /><Metric label="Passed" value={counts.PASS || 0} tone="pass" /><Metric label="Failed" value={counts.FAIL || 0} tone="fail" /><Metric label="Skipped" value={counts.SKIP || 0} tone="skip" />
    </div>
    <DataTable title="Latest Results" rows={(results.rows || []).slice(0, 12)} columns={[["id", "ID"], ["surface", "Surface"], ["featureArea", "Feature"], ["testCaseTitle", "Test Case"], ["status", "Status"]]} />
  </section>;
}

function ServicesPanel({ services }) {
  return <section className="panel"><div className="section-heading"><h2>Local Services</h2><span>Updated {formatDate(services.updatedAt)}</span></div><div className="service-grid">{(services.services || []).map((service) => <article key={service.name} className="service-card"><span>{service.name}</span><strong>:{service.port}</strong><p className={service.up ? "pass" : "fail"}>{service.up ? `up ${service.statusCode}` : service.error || "down"}</p></article>)}</div></section>;
}

function SuitesPanel({ framework, onRun }) {
  return <section className="card-grid">{(framework?.suites || []).map((suite) => <article key={suite.id} className="panel"><div className="section-heading"><h2>{suite.label}</h2><span>{suite.surface}</span></div><p>{suite.description}</p><div className="tag-row">{(suite.tags || []).map((tag) => <span key={tag}>{tag}</span>)}</div><button onClick={() => onRun(suite)}><Play size={16} /> Run Suite</button></article>)}</section>;
}

function ScenariosPanel({ framework, setScenarioFilter, setActive }) {
  return <section className="card-grid">{(framework?.scenarios || []).map((scenario) => <article key={scenario.id} className="panel"><div className="section-heading"><h2>{scenario.label}</h2><span>{scenario.suiteId}</span></div><p>{scenario.description}</p><code>{scenario.grep || "No grep filter"}</code><button onClick={() => { setScenarioFilter(scenario.grep || ""); setActive("execution"); }}><Search size={16} /> Use Filter</button></article>)}</section>;
}

function RecorderPanel({ recorder, setRecorder, recording, recordedScenarios, startRecording, stopRecording, runRecordedScenario, running }) {
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
        return <div className="inline-actions"><button onClick={() => runRecordedScenario(row, false)} disabled={running || isRecording}><Play size={16} /> Run</button><button className="secondary" onClick={() => runRecordedScenario(row, true)} disabled={running || isRecording}>Headed</button></div>;
      }}
    />
  </section>;
}

function InventoryPanel({ rows, filter, setFilter, selectedTests, toggleSelected, selectVisible, clearSelected, refresh }) {
  return <section className="panel"><div className="section-heading toolbar-heading"><div><h2>Selectable Test Inventory</h2><span>{rows.length} visible cases</span></div><div className="inline-actions"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by surface, feature, case, step" /><button className="secondary" onClick={refresh}><RefreshCw size={16} /> Refresh</button><button className="secondary" onClick={selectVisible}>Select Visible</button><button className="secondary" onClick={clearSelected}>Clear</button></div></div><DataTable rows={rows} columns={[["select", "Select"], ["id", "ID"], ["surface", "Surface"], ["feature", "Scenario"], ["displayTitle", "Test Case"], ["input", "Test Steps"], ["expected", "Expected Result"], ["proof", "What It Proves"]]} renderCell={(row, key) => key === "select" ? <input type="checkbox" checked={selectedTests.has(row.title)} onChange={() => toggleSelected(row.title)} /> : null} /></section>;
}

function BuilderPanel({ framework }) {
  return <section className="panel builder"><div className="section-heading"><h2>Case Builder Standard</h2><span>Suite - Scenario - Case - Steps</span></div><div className="builder-grid">{(framework?.caseFormat || []).map((item) => <article key={item.key}><strong>{item.label}</strong><p>{item.description}</p></article>)}</div></section>;
}

function ExecutionPanel({ status, stopRun }) {
  return <section className="section-stack"><div className="metric-grid"><Metric label="Status" value={status.running ? "Running" : "Idle"} /><Metric label="Surface" value={status.surface || "-"} /><Metric label="Scenario" value={status.scenario || "-"} /><Metric label="Selected" value={status.selectedTestCount || 0} /><Metric label="Exit Code" value={status.exitCode ?? "-"} /></div><div className="panel"><div className="section-heading"><h2>Live Output</h2><button className="danger" onClick={stopRun} disabled={!status.running}><Square size={16} /> Stop Run</button></div><pre className="logs">{(status.logs || []).join("\n") || "No run started."}</pre></div></section>;
}

function ReportsPanel({ results }) {
  return <section className="section-stack"><div className="report-links"><a href="/report/list-view-regression-results.html" target="_blank" rel="noreferrer">HTML Report</a><a href="/report/list-view-regression-results.csv" target="_blank" rel="noreferrer">CSV</a><a href="/report/list-view-regression-results.json" target="_blank" rel="noreferrer">JSON</a><a href="/report/list-view-regression-results.pdf" target="_blank" rel="noreferrer">PDF</a></div><DataTable title={`Report Rows (${results.total || 0})`} rows={results.rows || []} columns={[["id", "ID"], ["moduleSuite", "Module / Suite"], ["testCaseTitle", "Test Case"], ["expectedResult", "Expected"], ["actualResult", "Actual"], ["status", "Status"], ["automationStatus", "Automation"]]} /></section>;
}

function BugsPanel({ failedRows }) {
  return <section className="panel"><DataTable title={`Bug Report (${failedRows.length})`} rows={failedRows} columns={[["id", "ID"], ["surface", "Surface"], ["featureArea", "Feature"], ["bugReport", "Bug Summary"], ["actualResult", "Actual Result"]]} /></section>;
}

function AgentPanel({ agent, setAgent, runAgentScan, runAgentGenerate }) {
  return <section className="section-stack"><div className="panel"><div className="section-heading"><div><h2>AI Test Agent</h2><span>Branch plus review workflow</span></div><GitBranch size={20} /></div><div className="agent-controls"><label>Base ref <input value={agent.baseRef} onChange={(event) => setAgent((previous) => ({ ...previous, baseRef: event.target.value }))} /></label><button onClick={runAgentScan} disabled={agent.busy}><Search size={16} /> Scan Changes</button><button onClick={runAgentGenerate} disabled={agent.busy}><Bot size={16} /> Generate Scenarios</button></div>{agent.error ? <p className="danger-text">{agent.error}</p> : null}</div>{agent.scan ? <DataTable title={`Changed Files (${agent.scan.changedFiles?.length || 0})`} rows={agent.scan.changedFiles || []} columns={[["path", "Path"], ["area", "Area"], ["risk", "Risk"], ["reason", "Reason"]]} /> : null}{agent.generated ? <DataTable title={`Generated Candidate Scenarios (${agent.generated.scenarios?.length || 0})`} rows={agent.generated.scenarios || []} columns={[["suite", "Suite"], ["scenario", "Scenario"], ["testCase", "Test Case"], ["steps", "Steps"], ["expected", "Expected"]]} /> : null}</section>;
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
