import { z } from "zod";

// The Load Lab can only ever start something described here. The API takes a
// profile id plus validated params — a command string is never accepted from
// the client, so a button can never become a shell.

export type ParamControl =
  | { kind: "number"; min: number; max: number; step?: number }
  | { kind: "duration" }
  | { kind: "text"; maxLength: number }
  | { kind: "select"; options: { value: string; label: string }[] }
  | { kind: "boolean" };

export type ProfileParam = {
  key: string;
  label: string;
  help?: string;
  control: ParamControl;
  default: string | number | boolean;
};

export type ProfileThresholds = {
  p95Ms?: number;
  errorRatePct?: number;
};

export type TestProfile = {
  id: string;
  label: string;
  category: "Baseline" | "Load" | "Stress" | "Endurance" | "Resource pressure" | "Domain" | "Security";
  summary: string;
  proves: string;
  runner: "k6" | "node" | "zap" | "agent" | "nuclei" | "semgrep";
  script: string;
  danger: "low" | "medium" | "high";
  estimate: string;
  params: ProfileParam[];
  thresholds: ProfileThresholds;
  buildEnv: (values: Record<string, string>) => Record<string, string>;
};

const DRIVER = "tests/load/platform-driver/platform-driver.js";

const vus = (fallback: number, max = 500): ProfileParam => ({
  key: "vus",
  label: "Virtual users",
  help: "Concurrent simulated users at peak.",
  control: { kind: "number", min: 1, max },
  default: fallback
});

const duration = (fallback: string): ProfileParam => ({
  key: "duration",
  label: "Duration",
  help: "k6 duration string, e.g. 90s, 5m, 1h.",
  control: { kind: "duration" },
  default: fallback
});

const thinkTime: ProfileParam = {
  key: "thinkMs",
  label: "Think time (ms)",
  help: "Pause between operations per user. 0 makes it a hammer test.",
  control: { kind: "number", min: 0, max: 10_000, step: 50 },
  default: 500
};

const usePool: ProfileParam = {
  key: "useUserPool",
  label: "Distinct user per VU",
  help: "Each virtual user logs in as a different seeded account instead of sharing one session.",
  control: { kind: "boolean" },
  default: false
};

const driverEnv = (values: Record<string, string>, extra: Record<string, string> = {}) => ({
  SCENARIO: "constant",
  VUS: values.vus ?? "10",
  DURATION: values.duration ?? "1m",
  THINK_MS: values.thinkMs ?? "500",
  ...extra
});

export const PROFILES: TestProfile[] = [
  {
    id: "security-core-platform",
    label: "Core Platform security regression",
    category: "Security",
    summary: "Runs the repository's predefined security checks across App Service, Admin, Keystone, tenant routing, permissions, sharing, audit visibility, and agent guardrails.",
    proves: "Security-critical platform invariants still pass before a deployed-target DAST scan is attempted.",
    runner: "node",
    script: "tests/security/core-platform-security.mjs",
    danger: "low",
    estimate: "~2m",
    params: [],
    thresholds: {},
    buildEnv: () => ({})
  },
  {
    id: "security-baseline",
    label: "OWASP ZAP baseline",
    category: "Security",
    summary: "Crawls the authorized target and runs passive OWASP ZAP checks without attack payloads.",
    proves: "Security headers, cookie flags, information disclosure, browser-side weaknesses, and other passive DAST findings.",
    runner: "zap",
    script: "tests/security/zap-scan.mjs",
    danger: "medium",
    estimate: "~5m",
    params: [
      { key: "authorized", label: "I am authorized to scan this target", help: "Required. Only the server-configured target allowlist can be scanned.", control: { kind: "boolean" }, default: false },
      { key: "minutes", label: "Spider duration (minutes)", control: { kind: "number", min: 1, max: 30 }, default: 3 },
      { key: "failOn", label: "Fail run on", control: { kind: "select", options: [{ value: "high", label: "High risk" }, { value: "medium", label: "Medium or high risk" }] }, default: "high" }
    ],
    thresholds: {},
    buildEnv: (values) => ({ ZAP_SCAN_MODE: "baseline", ZAP_SCAN_MINUTES: values.minutes ?? "3", ZAP_FAIL_ON: values.failOn ?? "high" })
  },
  {
    id: "security-active",
    label: "OWASP ZAP active scan",
    category: "Security",
    summary: "Runs an active OWASP ZAP attack scan against the authorized non-production target.",
    proves: "Whether discovered inputs resist automated injection, traversal, browser, and server-side attack payloads.",
    runner: "zap",
    script: "tests/security/zap-scan.mjs",
    danger: "high",
    estimate: "10m+",
    params: [
      { key: "authorized", label: "I authorize active security testing", help: "Required. Active probes can create records, trigger workflows, or affect availability; use a controlled environment.", control: { kind: "boolean" }, default: false },
      { key: "minutes", label: "Active scan limit (minutes)", control: { kind: "number", min: 1, max: 60 }, default: 10 },
      { key: "failOn", label: "Fail run on", control: { kind: "select", options: [{ value: "high", label: "High risk" }, { value: "medium", label: "Medium or high risk" }] }, default: "medium" }
    ],
    thresholds: {},
    buildEnv: (values) => ({ ZAP_SCAN_MODE: "active", ZAP_SCAN_MINUTES: values.minutes ?? "10", ZAP_FAIL_ON: values.failOn ?? "medium" })
  },
  {
    id: "security-agent",
    label: "Autonomous purple-team exercise (Red/Blue/Purple)",
    category: "Security",
    summary: "A Codex-driven graph of security teams: a Red team (recon coordinator + parallel exploitation workers + synthesis) attacks the target; the platform captures its own observability telemetry for the attack window; a Blue team agent judges what was detectable; and a Purple team agent correlates them, tagging each finding detected / partial / blind-spot. Confirms proof-of-concept exploits in an isolated sandbox.",
    proves: "Not just whether weaknesses are exploitable, but whether your own monitoring would have caught the attack — surfacing the exploitable-and-undetected blind spots that matter most. Scoped strictly to the authorized target.",
    runner: "agent",
    script: "tests/security/agent-pentest.mjs",
    danger: "high",
    estimate: "10m+",
    params: [
      { key: "authorized", label: "I authorize autonomous agent testing of this target", help: "Required. The agents actively probe and may develop exploits; run only against a target you are authorized to test.", control: { kind: "boolean" }, default: false },
      { key: "budgetMinutes", label: "Total time budget (minutes)", control: { kind: "number", min: 3, max: 60 }, default: 15 },
      { key: "workers", label: "Exploitation workers", help: "How many exploitation agents run in parallel after recon. More workers = broader coverage, higher cost.", control: { kind: "number", min: 1, max: 6 }, default: 3 },
      { key: "effort", label: "Reasoning effort", control: { kind: "select", options: [{ value: "medium", label: "Medium (quicker)" }, { value: "high", label: "High (default)" }, { value: "xhigh", label: "Extra high" }] }, default: "high" },
      { key: "scanMode", label: "Scan mode", help: "quick = fast/shallow (CI), standard = balanced, deep = thorough & adversarial. Controls how the agents' system prompts and skills are rendered.", control: { kind: "select", options: [{ value: "quick", label: "Quick" }, { value: "standard", label: "Standard" }, { value: "deep", label: "Deep" }] }, default: "standard" },
      { key: "instruction", label: "Focus / rules of engagement (optional)", help: "Free-text guidance for the agent: focus areas, in-scope credentials, business-logic notes, or things to avoid. Scope stays bound to the authorized target.", control: { kind: "text", maxLength: 2000 }, default: "" },
      { key: "apiSpec", label: "API spec URL (optional)", help: "OpenAPI/Swagger or Postman collection URL under the authorized target. The agent tests declared endpoints instead of only crawling.", control: { kind: "text", maxLength: 500 }, default: "" },
      { key: "specFile", label: "API spec file (optional)", help: "Path to an OpenAPI/Swagger/Postman file within the repo, e.g. apps/service/openapi.json. The agent tests every declared endpoint.", control: { kind: "text", maxLength: 300 }, default: "" },
      { key: "postmanCollection", label: "Postman collection id (optional)", help: "Postman collection UUID. Requires POSTMAN_API_KEY in the environment; the agent pulls it live and tests each request.", control: { kind: "text", maxLength: 120 }, default: "" },
      { key: "sourcePath", label: "Source path for white-box (optional)", help: "Path within the repo to review as source, e.g. apps/service. Makes the exercise source-aware (code + deployed).", control: { kind: "text", maxLength: 300 }, default: "" },
      { key: "githubRepo", label: "GitHub repo URL (optional)", help: "https://github.com/org/repo — cloned into the sandbox and reviewed alongside the live target.", control: { kind: "text", maxLength: 300 }, default: "" },
      { key: "scopeMode", label: "Scope mode", help: "full = whole target; diff = only files changed vs the base ref (needs a source path).", control: { kind: "select", options: [{ value: "full", label: "Full" }, { value: "diff", label: "Diff (changed files)" }] }, default: "full" },
      { key: "diffBase", label: "Diff base ref (optional)", help: "Base branch/ref for diff scope, e.g. origin/main.", control: { kind: "text", maxLength: 120 }, default: "" },
      { key: "instructionFile", label: "Instruction file (optional)", help: "Path within the repo to a rules-of-engagement / scope / exclusions file the agents must follow.", control: { kind: "text", maxLength: 300 }, default: "" }
    ],
    thresholds: {},
    buildEnv: (values) => ({ AGENT_BUDGET_MINUTES: values.budgetMinutes ?? "15", AGENT_WORKERS: values.workers ?? "3", AGENT_EFFORT: values.effort ?? "high", AGENT_SCAN_MODE: values.scanMode ?? "standard", AGENT_INSTRUCTION: values.instruction ?? "", AGENT_API_SPEC: values.apiSpec ?? "", AGENT_SPEC_FILE: values.specFile ?? "", AGENT_POSTMAN_COLLECTION: values.postmanCollection ?? "", AGENT_SOURCE_PATH: values.sourcePath ?? "", AGENT_GITHUB_REPO: values.githubRepo ?? "", AGENT_SCOPE_MODE: values.scopeMode ?? "full", AGENT_DIFF_BASE: values.diffBase ?? "", AGENT_INSTRUCTION_FILE: values.instructionFile ?? "" })
  },
  {
    id: "security-nuclei",
    label: "Nuclei template scan",
    category: "Security",
    summary: "Runs the ProjectDiscovery Nuclei engine against the authorized target using its community template library (CVEs, misconfigurations, exposures, default credentials).",
    proves: "Whether the target matches thousands of known-vulnerability and misconfiguration signatures maintained by the security community.",
    runner: "nuclei",
    script: "tests/security/nuclei-scan.mjs",
    danger: "high",
    estimate: "~5m",
    params: [
      { key: "authorized", label: "I authorize active template scanning of this target", help: "Required. Nuclei sends live probes; run only against an authorized target.", control: { kind: "boolean" }, default: false },
      { key: "severity", label: "Minimum severity", control: { kind: "select", options: [{ value: "info", label: "Info and up" }, { value: "low", label: "Low and up" }, { value: "medium", label: "Medium and up" }, { value: "high", label: "High and up" }] }, default: "low" }
    ],
    thresholds: {},
    buildEnv: (values) => ({ NUCLEI_SEVERITY: values.severity ?? "low" })
  },
  {
    id: "security-semgrep",
    label: "Semgrep static analysis (SAST)",
    category: "Security",
    summary: "Runs Semgrep's security rulesets against the Core Platform source tree to find injection, auth, secret-handling, and unsafe-API defects in code — no target traffic.",
    proves: "Whether the source contains statically detectable security defects before anything is deployed or scanned dynamically.",
    runner: "semgrep",
    script: "tests/security/semgrep-scan.mjs",
    danger: "low",
    estimate: "~3m",
    params: [
      { key: "config", label: "Ruleset", control: { kind: "select", options: [{ value: "p/security-audit", label: "Security audit" }, { value: "p/owasp-top-ten", label: "OWASP Top Ten" }, { value: "auto", label: "Auto" }] }, default: "p/security-audit" }
    ],
    thresholds: {},
    buildEnv: (values) => ({ SEMGREP_CONFIG: values.config ?? "p/security-audit" })
  },
  {
    id: "smoke",
    label: "Smoke",
    category: "Baseline",
    summary: "One user, short run. Confirms the target is reachable and seeded before anything heavy.",
    proves: "The environment, credentials and discovery all work.",
    runner: "k6",
    script: DRIVER,
    danger: "low",
    estimate: "~30s",
    params: [duration("30s")],
    thresholds: { errorRatePct: 1, p95Ms: 3_000 },
    buildEnv: (values) => driverEnv({ ...values, vus: "1", thinkMs: "200" })
  },
  {
    id: "load-steady",
    label: "Load",
    category: "Load",
    summary: "Steady concurrency at a chosen level for a chosen time — the normal-traffic baseline.",
    proves: "Latency and error rate at expected peak traffic.",
    runner: "k6",
    script: DRIVER,
    danger: "medium",
    estimate: "matches duration",
    params: [vus(50), duration("5m"), thinkTime, usePool],
    thresholds: { errorRatePct: 1, p95Ms: 2_000 },
    buildEnv: (values) => driverEnv(values)
  },
  {
    id: "multi-user-parallel",
    label: "Parallel multi-user",
    category: "Load",
    summary:
      "Every virtual user is a different seeded account with its own session and permissions, all hitting the platform at once.",
    proves: "Real concurrent distinct-session behavior: per-user caches, permission checks and session handling under parallelism — not one account hammered.",
    runner: "k6",
    script: DRIVER,
    danger: "medium",
    estimate: "matches duration",
    params: [vus(100, 300), duration("5m"), thinkTime],
    thresholds: { errorRatePct: 2, p95Ms: 4_000 },
    buildEnv: (values) => driverEnv({ ...values }, { REQUIRE_UNIQUE_USERS: "1" })
  },
  {
    id: "stress-ramp",
    label: "Stress ramp",
    category: "Stress",
    summary: "Steps concurrency upward in stages to the target, holding at each step.",
    proves: "Where the latency knee is — the load level at which response time stops being linear.",
    runner: "k6",
    script: DRIVER,
    danger: "high",
    estimate: "steps x step duration",
    params: [
      vus(200, 500),
      { key: "steps", label: "Steps", control: { kind: "number", min: 2, max: 10 }, default: 5 },
      { key: "stepDuration", label: "Hold per step", control: { kind: "duration" }, default: "1m" },
      thinkTime,
      usePool
    ],
    thresholds: { errorRatePct: 5, p95Ms: 10_000 },
    buildEnv: (values) =>
      driverEnv(values, {
        SCENARIO: "ramp",
        RAMP_STEPS: values.steps ?? "5",
        RAMP_STEP_DURATION: values.stepDuration ?? "1m"
      })
  },
  {
    id: "spike",
    label: "Spike",
    category: "Stress",
    summary: "Quiet baseline, sudden burst to full target, then back down with a recovery window.",
    proves: "How fast the platform recovers after a traffic surge, and whether it recovers at all.",
    runner: "k6",
    script: DRIVER,
    danger: "high",
    estimate: "~5m",
    params: [
      vus(150, 500),
      { key: "hold", label: "Spike hold", control: { kind: "duration" }, default: "1m" },
      { key: "recover", label: "Recovery window", control: { kind: "duration" }, default: "2m" },
      thinkTime
    ],
    thresholds: { errorRatePct: 5, p95Ms: 15_000 },
    buildEnv: (values) =>
      driverEnv(values, {
        SCENARIO: "spike",
        SPIKE_HOLD: values.hold ?? "1m",
        SPIKE_RECOVER: values.recover ?? "2m"
      })
  },
  {
    id: "breakpoint",
    label: "Breakpoint",
    category: "Stress",
    summary: "Ramps until the error-rate or latency threshold trips, then stops and reports the level it broke at.",
    proves: "The hard capacity ceiling of this deployment, as a number.",
    runner: "k6",
    script: DRIVER,
    danger: "high",
    estimate: "until it breaks",
    params: [
      vus(400, 1_000),
      { key: "steps", label: "Steps", control: { kind: "number", min: 4, max: 20 }, default: 10 },
      { key: "stepDuration", label: "Hold per step", control: { kind: "duration" }, default: "45s" },
      {
        key: "p95Limit",
        label: "p95 limit (ms)",
        control: { kind: "number", min: 500, max: 60_000, step: 500 },
        default: 5_000
      },
      {
        key: "errorLimit",
        label: "Error rate limit (%)",
        control: { kind: "number", min: 1, max: 50 },
        default: 5
      }
    ],
    thresholds: {},
    buildEnv: (values) =>
      driverEnv(values, {
        SCENARIO: "breakpoint",
        RAMP_STEPS: values.steps ?? "10",
        RAMP_STEP_DURATION: values.stepDuration ?? "45s",
        ABORT_ON_BREACH: "1",
        P95_THRESHOLD_MS: values.p95Limit ?? "5000",
        FAIL_RATE_THRESHOLD: String(Number(values.errorLimit ?? 5) / 100)
      })
  },
  {
    id: "soak",
    label: "Soak",
    category: "Endurance",
    summary: "Moderate concurrency held for a long time.",
    proves: "Memory leaks, connection leaks and slow degradation that a short run cannot reveal.",
    runner: "k6",
    script: DRIVER,
    danger: "medium",
    estimate: "30m+",
    params: [vus(25), duration("30m"), thinkTime],
    thresholds: { errorRatePct: 1, p95Ms: 3_000 },
    buildEnv: (values) => driverEnv(values)
  },
  {
    id: "search-storm",
    label: "Search storm",
    category: "Load",
    summary: "Concentrates the operation mix on search and list-view queries.",
    proves: "Search and query-path behavior under concurrency, where index pressure shows first.",
    runner: "k6",
    script: DRIVER,
    danger: "medium",
    estimate: "matches duration",
    params: [vus(50), duration("3m"), thinkTime],
    thresholds: { errorRatePct: 2, p95Ms: 5_000 },
    buildEnv: (values) =>
      driverEnv(values, { OP_MIX: JSON.stringify({ search: 6, query_list_view: 4, list_records: 1 }) })
  },
  {
    id: "cardinality-scan",
    label: "Large catalog and result pages",
    category: "Load",
    summary: "Discovers a broad app/object catalog and repeatedly reads large pages and list views.",
    proves: "Query behavior as metadata cardinality and result-page size grow.",
    runner: "k6",
    script: DRIVER,
    danger: "medium",
    estimate: "matches duration",
    params: [
      vus(20),
      duration("3m"),
      { key: "maxApps", label: "Apps to discover", control: { kind: "number", min: 1, max: 100 }, default: 25 },
      { key: "maxObjects", label: "Objects per app", control: { kind: "number", min: 1, max: 100 }, default: 25 },
      { key: "pageSize", label: "Records per page", control: { kind: "number", min: 10, max: 500 }, default: 200 }
    ],
    thresholds: { errorRatePct: 2, p95Ms: 5_000 },
    buildEnv: (values) => driverEnv(values, {
      MAX_APPS: values.maxApps ?? "25",
      MAX_OBJECTS_PER_APP: values.maxObjects ?? "25",
      PAGE_SIZE: values.pageSize ?? "200",
      OP_MIX: JSON.stringify({ list_records: 5, query_list_view: 4, search: 2, describe_object: 1 })
    })
  },
  {
    id: "session-churn",
    label: "Session churn and reauthentication",
    category: "Stress",
    summary: "Forces virtual users to discard sessions and reauthenticate throughout a normal read workload.",
    proves: "Session creation, authentication backoff and recovery without a synchronized retry cascade.",
    runner: "k6",
    script: DRIVER,
    danger: "medium",
    estimate: "matches duration",
    params: [
      vus(30),
      duration("2m"),
      { key: "refreshEvery", label: "Iterations per login", control: { kind: "number", min: 1, max: 100 }, default: 5 },
      thinkTime
    ],
    thresholds: { errorRatePct: 2, p95Ms: 4_000 },
    buildEnv: (values) => driverEnv(values, {
      SESSION_REFRESH_EVERY: values.refreshEvery ?? "5",
      LOGIN_RETRY_BASE_MS: "1000",
      LOGIN_MAX_ATTEMPTS: "8"
    })
  },
  {
    id: "write-correctness",
    label: "Concurrent write correctness",
    category: "Domain",
    summary: "Runs scoped create, update, delete and read operations concurrently across LIMS, CRM and HR users.",
    proves: "Business-operation checks, permission isolation and CRUD behavior under concurrent writes.",
    runner: "k6",
    script: "tests/load/ops3/real-time-ops3-test.js",
    danger: "high",
    estimate: "matches duration",
    params: [duration("2m")],
    thresholds: { errorRatePct: 2, p95Ms: 10_000 },
    buildEnv: (values) => ({
      DURATION: values.duration ?? "2m",
      LIMS_VUS: "12",
      CRM_VUS: "12",
      HR_VUS: "4",
      ADMIN_APP_VUS: "1",
      SHOCKWAVE_ADMIN_VUS: "1",
      SKIP_FILE_OPS: "1",
      SKIP_LIST_TABS: "0",
      REQUIRE_UNIQUE_USERS: "1"
    })
  },
  {
    id: "mixed-contention",
    label: "Mixed foreground contention",
    category: "Domain",
    summary: "Runs metadata, CRUD, search, list-view and supported file operations at the same time.",
    proves: "Cross-workload contention that isolated endpoint tests cannot reveal.",
    runner: "k6",
    script: "tests/load/ops3/real-time-ops3-test.js",
    danger: "high",
    estimate: "matches duration",
    params: [duration("3m")],
    thresholds: { errorRatePct: 5, p95Ms: 15_000 },
    buildEnv: (values) => ({
      DURATION: values.duration ?? "3m",
      LIMS_VUS: "25",
      CRM_VUS: "20",
      HR_VUS: "5",
      ADMIN_APP_VUS: "2",
      SHOCKWAVE_ADMIN_VUS: "3",
      SKIP_FILE_OPS: "0",
      SKIP_LIST_TABS: "0",
      REQUIRE_UNIQUE_USERS: "1"
    })
  },
  {
    id: "cpu-pressure",
    label: "CPU pressure at peak",
    category: "Resource pressure",
    summary:
      "Occupies a share of the server's cores with busy workers so you can watch latency degrade under contention.",
    proves: "How the platform behaves when CPU is scarce — the peak-hour throttling scenario.",
    runner: "node",
    script: "tests/load/cpu-pressure/cpu-pressure.mjs",
    danger: "high",
    estimate: "matches duration",
    params: [
      {
        key: "fraction",
        label: "Share of cores",
        help: "0.75 leaves a quarter of the machine free. 1.0 saturates it.",
        control: { kind: "number", min: 0.1, max: 1, step: 0.05 },
        default: 0.75
      },
      {
        key: "dutyCycle",
        label: "Duty cycle",
        help: "How hard each worker spins. Lower values simulate partial throttling.",
        control: { kind: "number", min: 0.1, max: 1, step: 0.05 },
        default: 0.9
      },
      {
        key: "seconds",
        label: "Duration (seconds)",
        control: { kind: "number", min: 10, max: 3_600 },
        default: 120
      }
    ],
    thresholds: {},
    buildEnv: (values) => ({
      PRESSURE_FRACTION: values.fraction ?? "0.75",
      PRESSURE_DUTY_CYCLE: values.dutyCycle ?? "0.9",
      PRESSURE_DURATION_SECONDS: values.seconds ?? "120"
    })
  },
  {
    id: "db-saturation",
    label: "DB connection saturation",
    category: "Resource pressure",
    summary: "Opens connections up to and past the pool ceiling, timing each one.",
    proves: "Whether the platform queues gracefully or fails when the database runs out of connections.",
    runner: "node",
    script: "tests/load/db-saturation/db-saturation.mjs",
    danger: "high",
    estimate: "~1m",
    params: [
      {
        key: "connections",
        label: "Connections",
        control: { kind: "number", min: 5, max: 500 },
        default: 60
      },
      {
        key: "holdSeconds",
        label: "Hold (seconds)",
        control: { kind: "number", min: 5, max: 600 },
        default: 30
      }
    ],
    thresholds: {},
    buildEnv: (values) => ({
      SATURATION_CONNECTIONS: values.connections ?? "60",
      SATURATION_HOLD_SECONDS: values.holdSeconds ?? "30"
    })
  },
  {
    id: "db-slow-query-pressure",
    label: "DB slow-query pressure",
    category: "Resource pressure",
    summary: "Runs bounded concurrent pg_sleep queries while probing database responsiveness.",
    proves: "How the database and connection budget behave when many queries remain active at once.",
    runner: "node",
    script: "tests/load/db-saturation/db-saturation.mjs",
    danger: "high",
    estimate: "~1m",
    params: [
      { key: "connections", label: "Concurrent queries", control: { kind: "number", min: 2, max: 100 }, default: 20 },
      { key: "queryDelayMs", label: "Query duration (ms)", control: { kind: "number", min: 100, max: 30_000 }, default: 3_000 },
      { key: "holdSeconds", label: "Hold (seconds)", control: { kind: "number", min: 5, max: 300 }, default: 15 }
    ],
    thresholds: {},
    buildEnv: (values) => ({
      SATURATION_CONNECTIONS: values.connections ?? "20",
      SATURATION_QUERY_DELAY_MS: values.queryDelayMs ?? "3000",
      SATURATION_HOLD_SECONDS: values.holdSeconds ?? "15"
    })
  },
  {
    id: "agent-concurrency",
    label: "AI agent concurrency",
    category: "Domain",
    summary: "Runs parallel read-only health-summary conversations through the deployed Codex agent.",
    proves: "Agent authentication, MCP-backed response latency, concurrency and upstream model failure behavior.",
    runner: "k6",
    script: "tests/load/agent-concurrency/agent-concurrency.js",
    danger: "high",
    estimate: "matches duration; incurs model usage",
    params: [vus(2, 10), duration("1m")],
    thresholds: { errorRatePct: 5, p95Ms: 120_000 },
    buildEnv: (values) => ({ VUS: values.vus ?? "2", DURATION: values.duration ?? "1m" })
  },
  {
    id: "login-storm",
    label: "Login storm",
    category: "Domain",
    summary: "Wraps the existing login suite — concurrent authentication against the auth rate limiter.",
    proves: "Auth throughput and whether the rate-limit buckets behave under a burst of logins.",
    runner: "k6",
    script: "tests/load/login-test/login-test.js",
    danger: "medium",
    estimate: "short",
    params: [vus(20), duration("30s")],
    thresholds: { errorRatePct: 5 },
    buildEnv: (values) => ({ VUS: values.vus ?? "20", DURATION: values.duration ?? "30s" })
  },
  {
    id: "bulk-insert",
    label: "Bulk insert",
    category: "Domain",
    summary: "Wraps the existing Shockwave bulk-insert suite.",
    proves: "Write throughput on the bulk path.",
    runner: "k6",
    script: "tests/load/shockwave-bulk-insert-test/shockwave-bulk-insert-test.js",
    danger: "high",
    estimate: "varies",
    params: [],
    thresholds: {},
    buildEnv: () => ({})
  },
  {
    id: "bulk-load",
    label: "Bulk load",
    category: "Domain",
    summary: "Wraps the existing Shockwave bulk-load suite.",
    proves: "Read throughput on large result sets.",
    runner: "k6",
    script: "tests/load/shockwave-bulk-load-test/shockwave-bulk-load-test.js",
    danger: "high",
    estimate: "varies",
    params: [],
    thresholds: {},
    buildEnv: () => ({})
  },
  {
    id: "export-pdf",
    label: "Export under load",
    category: "Domain",
    summary: "Wraps the existing list-view PDF export suite.",
    proves: "Export worker behavior when several exports are requested at once.",
    runner: "k6",
    script: "tests/load/list-view-export-pdf-test/list-view-export-pdf-test.js",
    danger: "medium",
    estimate: "varies",
    params: [],
    thresholds: {},
    buildEnv: () => ({})
  },
  {
    id: "ops3-combined",
    label: "Combined operations (ops3)",
    category: "Domain",
    summary: "The existing 100-VU combined admin + app operations suite, unchanged.",
    proves: "Full mixed-workload behavior across Admin and Keystone surfaces with per-user permission scopes.",
    runner: "k6",
    script: "tests/load/ops3/real-time-ops3-test.js",
    danger: "high",
    estimate: "matches duration",
    params: [
      duration("1m"),
      { key: "limsVus", label: "LIMS VUs", control: { kind: "number", min: 0, max: 200 }, default: 45 },
      { key: "crmVus", label: "CRM VUs", control: { kind: "number", min: 0, max: 200 }, default: 38 },
      { key: "hrVus", label: "HR VUs", control: { kind: "number", min: 0, max: 200 }, default: 10 },
      { key: "adminVus", label: "Admin VUs", control: { kind: "number", min: 0, max: 50 }, default: 2 }
    ],
    thresholds: { errorRatePct: 10, p95Ms: 40_000 },
    buildEnv: (values) => ({
      DURATION: values.duration ?? "1m",
      LIMS_VUS: values.limsVus ?? "45",
      CRM_VUS: values.crmVus ?? "38",
      HR_VUS: values.hrVus ?? "10",
      ADMIN_APP_VUS: values.adminVus ?? "2",
      SHOCKWAVE_ADMIN_VUS: "5",
      SKIP_FILE_OPS: "1",
      SKIP_LIST_TABS: "1",
      REQUIRE_UNIQUE_USERS: "1"
    })
  }
];

export const profileById = (id: string) => PROFILES.find((profile) => profile.id === id) ?? null;

/** Params are validated against the profile's own declared controls. */
export const buildParamSchema = (profile: TestProfile) => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of profile.params) {
    switch (param.control.kind) {
      case "number":
        shape[param.key] = z
          .number()
          .min(param.control.min)
          .max(param.control.max)
          .optional();
        break;
      case "boolean":
        shape[param.key] = z.boolean().optional();
        break;
      case "duration":
        shape[param.key] = z
          .string()
          .regex(/^\d+(ms|s|m|h)$/, "expected a k6 duration such as 90s or 5m")
          .optional();
        break;
      case "select":
        shape[param.key] = z
          .enum(param.control.options.map((option) => option.value) as [string, ...string[]])
          .optional();
        break;
      case "text":
      default:
        shape[param.key] = z.string().max(param.control.maxLength).optional();
        break;
    }
  }
  return z.object(shape).strict();
};

export const applyDefaults = (
  profile: TestProfile,
  values: Record<string, unknown>
): Record<string, string> => {
  const resolved: Record<string, string> = {};
  for (const param of profile.params) {
    const value = values[param.key] ?? param.default;
    resolved[param.key] = String(value);
  }
  return resolved;
};

/** Script paths and environment builders remain server-only. */
export const profileSummaries = () => PROFILES.map(({ script: _script, buildEnv: _buildEnv, ...profile }) => profile);
