import fs from "node:fs";
import path from "node:path";
import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  FullResult,
  Suite
} from "@playwright/test/reporter";
import { writePdfFromHtml } from "./report";

type Row = {
  id: string;
  tags: string;
  moduleSuite: string;
  testCaseTitle: string;
  surface: string;
  featureArea: string;
  scenario: string;
  precondition: string;
  inputAction: string;
  testData: string;
  expectedResult: string;
  actualResult: string;
  proof: string;
  status: "PENDING" | "RUNNING" | "PASS" | "FAIL" | "SKIP";
  priority: "High" | "Medium" | "Low";
  testingLevel: "BVT" | "Sanity" | "Regression";
  automationStatus: "Automated" | "Manual" | "Planned";
  executionSource: string;
  requestedBy: string;
  performedBy: string;
  directUrl: string;
  inputDataSummary: string;
  fieldsUpdated: string;
  bugReport?: string;
  screenshotPaths?: string[];
  evidenceNotes?: string[];
  steps?: StepDetail[];
  manualDataRows?: ManualRow[];
};

type StepDetail = {
  section: string;
  step?: string;
  outcome?: string;
  action: string;
  actionDone?: string;
  fieldsUpdated?: string;
  testData: string;
  inputData?: string;
  inputDataSource?: string;
  expectedBehavior: string;
  expectedResult?: string;
  verify: string;
  directUrl?: string;
  result: "Pending" | "Running" | "Passed" | "Failed" | "Skipped";
};

type ManualRow = {
  target?: string;
  action?: string;
  inputValue?: string;
  expectedValue?: string;
  notes?: string;
};

type ReporterOptions = {
  outputFolder?: string;
  filename?: string;
  csvFilename?: string;
  jsonFilename?: string;
};

type MetaFields = {
  surface?: string;
  feature?: string;
  level?: string;
  priority?: string;
  testData?: string;
  automation?: string;
  precondition?: string;
  input?: string;
  expected?: string;
  proof?: string;
};

const sanitize = (value: string) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const csvCell = (value: string) => `"${String(value).replace(/"/g, '""')}"`;

const formatScenario = (test: TestCase) =>
  test.titlePath().filter((part) => part.trim()).join(" > ");

const formatTitle = (test: TestCase) =>
  test.title.replace(/\s*\[[^\]]+\]/g, "").trim();

const normalizeStatus = (status: TestResult["status"]): Row["status"] => {
  if (status === "passed") return "PASS";
  if (status === "skipped") return "SKIP";
  return "FAIL";
};

const summarizeFailure = (result: TestResult) => {
  const messages = [
    result.error?.message,
    ...(result.errors ?? []).map((error) => error.message)
  ]
    .filter(Boolean)
    .map((message) => String(message).replace(/\x1b\[[0-9;]*m/g, "").trim());
  const first = messages[0] ?? "";
  return first.length > 600 ? `${first.slice(0, 600)}...` : first;
};

const getAnnotation = (test: TestCase, type: string) =>
  test.annotations.find((note) => note.type === type)?.description ?? "";

const parseMetaFromTitle = (title: string): MetaFields => {
  const fields: MetaFields = {};
  const bracket = /\[(surface|feature|level|priority|testdata|test data|automation|precondition|input|expected|proof):\s*([^\]]+)\]/gi;
  let match: RegExpExecArray | null = bracket.exec(title);
  while (match) {
    const key = normalizeMetaKey(match[1]);
    fields[key] = match[2].trim();
    match = bracket.exec(title);
  }
  if (Object.keys(fields).length > 0) {
    return fields;
  }

  const inline = /(surface|feature|level|priority|testdata|test data|automation|precondition|input|expected|proof)\s*[:=]\s*([^|]+)(?:\||$)/gi;
  match = inline.exec(title);
  while (match) {
    const key = normalizeMetaKey(match[1]);
    fields[key] = match[2].trim();
    match = inline.exec(title);
  }
  return fields;
};

const parseMetaFromTags = (test: TestCase): MetaFields => {
  const tags = ((test as unknown as { tags?: string[] }).tags ?? []).map((tag) =>
    String(tag)
  );
  const fields: MetaFields = {};
  for (const tag of tags) {
    const match = /^@(surface|feature|level|priority|testdata|test data|automation|precondition|input|expected|proof):(.+)$/i.exec(tag);
    if (!match) continue;
    const key = normalizeMetaKey(match[1]);
    fields[key] = match[2].trim();
  }
  return fields;
};

const normalizeMetaKey = (key: string): keyof MetaFields => {
  const normalized = key.toLowerCase().replace(/\s+/g, "");
  if (normalized === "testdata") return "testData";
  return normalized as keyof MetaFields;
};

const normalizeTestingLevel = (value: string, scenario: string): Row["testingLevel"] => {
  const normalized = value.toLowerCase();
  if (normalized === "bvt" || normalized.includes("build verification") || normalized.includes("smoke")) return "BVT";
  if (normalized.includes("sanity")) return "Sanity";
  if (normalized.includes("regression")) return "Regression";
  const lower = scenario.toLowerCase();
  if (lower.includes("list view loads") || lower.includes("object list view loads") || lower.includes("primary toolbar")) {
    return "BVT";
  }
  if (lower.includes("search handles") || lower.includes("refresh preserves") || lower.includes("selection count")) {
    return "Sanity";
  }
  return "Regression";
};

const normalizePriority = (value: string, level: Row["testingLevel"], scenario: string): Row["priority"] => {
  const normalized = value.toLowerCase();
  if (normalized === "high") return "High";
  if (normalized === "low") return "Low";
  if (normalized === "medium") return "Medium";
  const lower = scenario.toLowerCase();
  if (
    level === "BVT" ||
    lower.includes("security") ||
    lower.includes("metadata boundary") ||
    lower.includes("bulk delete") ||
    lower.includes("concurrency") ||
    lower.includes("export")
  ) {
    return "High";
  }
  return "Medium";
};

const normalizeAutomationStatus = (value: string): Row["automationStatus"] => {
  const normalized = value.toLowerCase();
  if (normalized === "manual") return "Manual";
  if (normalized === "planned") return "Planned";
  return "Automated";
};

const moduleCode = (feature: string) =>
  (feature || "LIST_VIEW").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "LIST_VIEW";

const levelCode = (level: Row["testingLevel"]) =>
  level === "BVT" ? "BVT" : level === "Sanity" ? "SAN" : "REG";

const categoryTag = (level: Row["testingLevel"]) =>
  level === "BVT" ? "@bvt" : level === "Sanity" ? "@sanity" : "@regression";

const defaultTestData = (surface: string) => {
  if (surface === "API") return "Seeded credentials; app, object, and list-view IDs resolved at runtime.";
  if (surface === "Admin") return "Seeded admin credentials; seeded metadata list views.";
  if (surface === "Keystone") return "Seeded Keystone credentials; seeded industry-suite app/object records.";
  return "Seeded local test data.";
};

const normalizeManualKey = (value: string) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const loadManualContext = () => {
  const contextPath = process.env.MANUAL_TEST_DATA_CONTEXT || "";
  if (!contextPath || !fs.existsSync(contextPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(contextPath, "utf8")) as {
      mode?: string;
      requestedBy?: string;
      performedBy?: string;
      byCaseId?: Record<string, { rows?: ManualRow[]; inputDataSummary?: string; fieldsUpdated?: string[]; dataset?: { datasetName?: string } }>;
      byTitle?: Record<string, { rows?: ManualRow[]; inputDataSummary?: string; fieldsUpdated?: string[]; dataset?: { datasetName?: string } }>;
      mappings?: Array<{ mode?: string; datasetName?: string }>;
    };
  } catch {
    return null;
  }
};

const manualContext = loadManualContext();

const summarizeManualRows = (rows: ManualRow[] = []) =>
  rows
    .map((row) => {
      const target = row.target || row.action || "";
      const value = row.inputValue || row.expectedValue || "";
      return target && value ? `${target}: ${value}` : target || value;
    })
    .filter(Boolean)
    .join("; ");

const manualInfoForRow = (row: Pick<Row, "id" | "testCaseTitle">) => {
  const caseData =
    manualContext?.byCaseId?.[row.id] ||
    manualContext?.byTitle?.[normalizeManualKey(row.testCaseTitle)] ||
    null;
  const manualRows = caseData?.rows || [];
  const isManual = manualContext?.mode === "manual" && Boolean(caseData);
  const datasetName =
    caseData?.dataset?.datasetName ||
    (isManual ? manualContext?.mappings?.find((mapping) => mapping.mode === "dataset")?.datasetName : "") ||
    "";
  const fieldsUpdated = Array.from(new Set(manualRows.map((item) => item.target).filter(Boolean))).join(", ");
  return {
    executionSource: isManual
      ? datasetName
        ? `Saved Excel dataset: ${datasetName}`
        : "Saved Excel dataset"
      : "Automated data",
    requestedBy: isManual ? manualContext?.requestedBy || "" : "",
    performedBy: isManual ? manualContext?.performedBy || manualContext?.requestedBy || "Manual requester" : "Automation user",
    manualDataRows: manualRows,
    fieldsUpdated,
    inputDataSummary: caseData?.inputDataSummary || summarizeManualRows(manualRows)
  };
};

const extractSeedDataFromTest = (test: TestCase) => {
  const file = test.location?.file;
  if (!file || !fs.existsSync(file)) return "";
  const source = fs.readFileSync(file, "utf8");
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
  const values: string[] = [];
  for (const name of names) {
    const match = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*(?:process\\.env\\.[A-Z0-9_]+\\s*\\|\\|\\s*)?["']([^"']+)["']|(?:const|let)\\s+${name}\\s*=\\s*(\\d+)`).exec(source);
    if (match) values.push(`${name}: ${match[1] || match[2]}`);
  }
  const dynamicNames = Array.from(source.matchAll(/const\s+(\w*(?:label|name|apiName|prefix|stamp)\w*)\s*=\s*`([^`]+)`/gi))
    .slice(0, 8)
    .map((match) => `${match[1]}: ${match[2].replace(/\$\{[^}]+\}/g, "<runtime>")}`);
  return [...values, ...dynamicNames].join("; ");
};

const actualResultForStatus = (status: Row["status"], failure = "") => {
  if (status === "PASS") return "As expected.";
  if (status === "FAIL") return failure || "Defect raised.";
  if (status === "SKIP") return "Skipped or blocked by precondition.";
  if (status === "RUNNING") return "Execution in progress.";
  return "Not Run.";
};

const stepResultForStatus = (status: Row["status"]): StepDetail["result"] => {
  if (status === "PASS") return "Passed";
  if (status === "FAIL") return "Failed";
  if (status === "SKIP") return "Skipped";
  if (status === "RUNNING") return "Running";
  return "Pending";
};

const structuredStepsFromText = (
  input: string,
  row: Pick<Row, "surface" | "featureArea" | "testData" | "expectedResult" | "status" | "executionSource" | "requestedBy" | "fieldsUpdated" | "inputDataSummary" | "directUrl">
): StepDetail[] => {
  const parts = normalizeStepSeparators(input)
    .split(/\s*->\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const source = parts.length > 0 ? parts : [input || "Execute the test case"];
  return source.map((action, index) => ({
    section: index === 0 ? row.surface || "Application" : `${row.surface || "Application"} > ${row.featureArea || "Feature"}`,
    step: String(index + 1),
    outcome: stepResultForStatus(row.status),
    action,
    actionDone: `${action}${row.fieldsUpdated ? `; fields updated: ${row.fieldsUpdated}` : ""}${row.requestedBy ? `; requested by: ${row.requestedBy}` : ""}`,
    fieldsUpdated: row.fieldsUpdated,
    testData: row.testData || defaultTestData(row.surface),
    inputData: row.inputDataSummary || row.testData || defaultTestData(row.surface),
    inputDataSource: row.executionSource,
    expectedBehavior: row.expectedResult || "The UI/API behaves as expected.",
    expectedResult: row.expectedResult || "The UI/API behaves as expected.",
    verify:
      index === source.length - 1
        ? row.expectedResult || "Verify the final UI/API state."
        : `Verify "${action}" completes and the next state is reachable.`,
    directUrl: row.directUrl,
    result: stepResultForStatus(row.status)
  }));
};

const collectResultSteps = (
  result: TestResult,
  row: Pick<Row, "surface" | "featureArea" | "testData" | "expectedResult" | "status" | "inputAction" | "executionSource" | "requestedBy" | "fieldsUpdated" | "inputDataSummary" | "directUrl" | "manualDataRows">
): StepDetail[] => {
  const rawSteps = ((result as unknown as { steps?: Array<{ title?: string; category?: string; error?: unknown; steps?: unknown[] }> }).steps ?? []);
  const flattened: Array<{ title: string; error?: unknown }> = [];
  const walk = (steps: typeof rawSteps) => {
    for (const step of steps) {
      const title = String(step.title || "").trim();
      if (title && !/^beforeEach|afterEach|fixture:/i.test(title)) flattened.push({ title, error: step.error });
      if (Array.isArray(step.steps)) walk(step.steps as typeof rawSteps);
    }
  };
  walk(rawSteps);
  if (flattened.length === 0) return structuredStepsFromText(row.inputAction, row);
  return flattened.map((step, index) => ({
    section: `${row.surface || "Application"} > ${row.featureArea || "Feature"}`,
    step: String(index + 1),
    outcome: step.error ? "Failed" : stepResultForStatus(row.status === "RUNNING" ? "RUNNING" : row.status),
    action: step.title.replace(/^BVT-\d+:\s*/i, ""),
    actionDone: `${step.title.replace(/^BVT-\d+:\s*/i, "")}${row.fieldsUpdated ? `; fields updated: ${row.fieldsUpdated}` : ""}${row.requestedBy ? `; requested by: ${row.requestedBy}` : ""}`,
    fieldsUpdated: row.fieldsUpdated,
    testData: row.testData || defaultTestData(row.surface),
    inputData: row.inputDataSummary || summarizeManualRows(row.manualDataRows || []) || row.testData || defaultTestData(row.surface),
    inputDataSource: row.executionSource,
    expectedBehavior: row.expectedResult || "The UI/API behaves as expected.",
    expectedResult: row.expectedResult || "The UI/API behaves as expected.",
    verify: `Verify ${step.title.replace(/^BVT-\d+:\s*/i, "")}.`,
    directUrl: row.directUrl,
    result: step.error ? "Failed" : stepResultForStatus(row.status === "RUNNING" ? "RUNNING" : row.status)
  }));
};

const stepChain = (steps: string[]) => steps.filter(Boolean).join(" -> ");

const normalizeStepSeparators = (steps: string) =>
  String(steps || "")
    .replace(/\s*\|\s*/g, " -> ")
    .replace(/\s+/g, " ")
    .trim();

const stripBracketMeta = (value: string) =>
  String(value || "").replace(/\s*\[(surface|feature|level|priority|testdata|test data|automation|precondition|input|expected|proof):[^\]]+\]/gi, "");

const isVagueStepText = (steps: string) => {
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

const adminScreenForSteps = (feature: string, scenario: string) => {
  const text = `${feature} ${scenario}`.toLowerCase();
  if (/permission|access|role|group|user|security/.test(text)) return "Permissions or Access Records";
  if (/object|field|metadata/.test(text)) return "Objects";
  if (/recycle|restore|purge/.test(text)) return "Recycle Bin";
  if (/app/.test(text)) return "Apps";
  return feature || "the target screen";
};

const uiActionForSteps = (feature: string, scenario: string) => {
  const text = `${feature} ${scenario}`.toLowerCase();
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

const expandSpecificSteps = ({
  raw,
  scenario,
  feature,
  surface
}: {
  raw: string;
  scenario: string;
  feature: string;
  surface: string;
}) => {
  const steps = normalizeStepSeparators(raw);
  const lower = steps.toLowerCase();
  if (/^open (admin|keystone)?\s*application\b/.test(lower) || lower.startsWith("open application ->")) return steps;

  const cleanScenario = stripBracketMeta(scenario);
  const text = `${cleanScenario} ${feature} ${surface}`.toLowerCase();
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

const readableTestSteps = ({
  raw = "",
  scenario = "",
  feature = "List View",
  surface = "Application"
}: {
  raw?: string;
  scenario?: string;
  feature?: string;
  surface?: string;
}) => {
  if (raw && !isVagueStepText(raw)) return expandSpecificSteps({ raw, scenario, feature, surface });

  const cleanScenario = stripBracketMeta(scenario);
  const text = `${cleanScenario} ${feature} ${surface}`.toLowerCase();
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
      uiActionForSteps(feature, cleanScenario),
      "verify the record or table state"
    ]);
  }
  if (isAdmin || isPermissionAccess) {
    return stepChain([
      "Open Admin application",
      "fill the login details",
      "click Login",
      `navigate to ${adminScreenForSteps(feature, cleanScenario)} from the sidebar`,
      uiActionForSteps(feature, cleanScenario),
      "verify the page or table result"
    ]);
  }
  return stepChain([
    "Open application",
    "sign in with seeded test credentials",
    `navigate to the ${feature || "target"} screen`,
    uiActionForSteps(feature, cleanScenario),
    "verify the expected result and capture evidence"
  ]);
};

const resolveMeta = (test: TestCase): Required<MetaFields> => {
  const fromAnnotations: MetaFields = {
    surface: getAnnotation(test, "surface"),
    feature: getAnnotation(test, "feature"),
    level: getAnnotation(test, "level"),
    priority: getAnnotation(test, "priority"),
    testData: getAnnotation(test, "testData") || getAnnotation(test, "test data"),
    automation: getAnnotation(test, "automation"),
    precondition: getAnnotation(test, "precondition"),
    input: getAnnotation(test, "input"),
    expected: getAnnotation(test, "expected"),
    proof: getAnnotation(test, "proof")
  };
  const fromTags = parseMetaFromTags(test);
  const fromTitle = parseMetaFromTitle(test.title);
  const scenario = formatScenario(test);
  const fallback = buildDefaultMeta(scenario);
  return {
    surface:
      fromAnnotations.surface ||
      fromTags.surface ||
      fromTitle.surface ||
      fallback.surface ||
      "",
    feature:
      fromAnnotations.feature ||
      fromTags.feature ||
      fromTitle.feature ||
      fallback.feature ||
      "",
    level:
      fromAnnotations.level ||
      fromTags.level ||
      fromTitle.level ||
      fallback.level ||
      "",
    priority:
      fromAnnotations.priority ||
      fromTags.priority ||
      fromTitle.priority ||
      fallback.priority ||
      "",
    testData:
      fromAnnotations.testData ||
      fromTags.testData ||
      fromTitle.testData ||
      fallback.testData ||
      "",
    automation:
      fromAnnotations.automation ||
      fromTags.automation ||
      fromTitle.automation ||
      fallback.automation ||
      "",
    precondition:
      fromAnnotations.precondition ||
      fromTags.precondition ||
      fromTitle.precondition ||
      fallback.precondition ||
      "",
    input:
      fromAnnotations.input ||
      fromTags.input ||
      fromTitle.input ||
      fallback.input ||
      "",
    expected:
      fromAnnotations.expected ||
      fromTags.expected ||
      fromTitle.expected ||
      fallback.expected ||
      "",
    proof:
      fromAnnotations.proof ||
      fromTags.proof ||
      fromTitle.proof ||
      fallback.proof ||
      ""
  };
};

const buildDefaultMeta = (scenario: string): MetaFields => {
  const lowerScenario = scenario.toLowerCase();
  const surface = lowerScenario.includes("admin")
    ? "Admin"
    : lowerScenario.includes("keystone")
      ? "Keystone"
      : lowerScenario.includes("shockwave")
        ? "Keystone"
        : lowerScenario.includes("api")
          ? "API"
          : "";
  const defaultFeature =
    lowerScenario.includes("list view") || lowerScenario.includes("list-view")
      ? "List View"
      : "";
  const match = /feature:\s*([^>]+)$/i.exec(scenario);
  const titleFeature = match ? match[1].trim() : "";
  const feature = titleFeature || defaultFeature;
  if (!feature) {
    return {
      surface,
      feature,
      level: "",
      priority: "",
      testData: "",
      automation: "Automated",
      precondition: "Test environment ready.",
      input: readableTestSteps({ scenario, feature: "Application", surface }),
      expected: "Behavior matches requirements.",
      proof: "Automated UI verification."
    };
  }
  const niceFeature = feature.replace(/_/g, " ");
  return {
    surface,
    feature: feature || "List View",
    level: "",
    priority: "",
    testData: "",
    automation: "Automated",
    precondition: "User is authenticated and an app/tab is loaded.",
    input: readableTestSteps({ scenario, feature: niceFeature, surface }),
    expected: "Allowed roles can perform the action; disallowed roles are blocked or hidden.",
    proof: "RBAC enforcement matches the access matrix."
  };
};

export default class TableReport implements Reporter {
  private rows: Row[] = [];
  private rowByTest = new Map<TestCase, Row>();
  private outputFolder = "";
  private filename = "e2e_results.html";
  private csvFilename = "e2e_results.csv";
  private jsonFilename = "e2e_results.json";
  private assetsDir = "";
  private counter = 0;
  private options: ReporterOptions;

  constructor(options: ReporterOptions = {}) {
    this.options = options;
  }

  private buildRow(test: TestCase, index: number, status: Row["status"]): Row {
    const meta = resolveMeta(test);
    const scenario = formatScenario(test);
    const level = normalizeTestingLevel(meta.level, scenario);
    const featureArea = meta.feature || "List View";
    const id = `${levelCode(level)}_${moduleCode(featureArea)}_${String(index + 1).padStart(3, "0")}`;
    const row: Row = {
      id,
      tags: `@case-${id} ${categoryTag(level)}`,
      moduleSuite: `${meta.surface || "Application"} / ${featureArea}`,
      testCaseTitle: formatTitle(test),
      surface: meta.surface,
      featureArea,
      scenario,
      precondition: meta.precondition,
      inputAction: readableTestSteps({
        raw: meta.input,
        scenario,
        feature: featureArea,
        surface: meta.surface
      }),
      testData: meta.testData || extractSeedDataFromTest(test) || defaultTestData(meta.surface),
      expectedResult: meta.expected,
      actualResult: actualResultForStatus(status),
      proof: meta.proof,
      status,
      priority: normalizePriority(meta.priority, level, scenario),
      testingLevel: level,
      automationStatus: normalizeAutomationStatus(meta.automation),
      executionSource: "Automated data",
      requestedBy: "",
      performedBy: "Automation user",
      directUrl: "",
      inputDataSummary: "",
      fieldsUpdated: ""
    };
    const manualInfo = manualInfoForRow(row);
    row.executionSource = manualInfo.executionSource;
    row.requestedBy = manualInfo.requestedBy;
    row.performedBy = manualInfo.performedBy;
    row.manualDataRows = manualInfo.manualDataRows;
    row.fieldsUpdated = manualInfo.fieldsUpdated;
    row.inputDataSummary = manualInfo.inputDataSummary || row.testData;
    if (manualInfo.inputDataSummary) {
      row.testData = manualInfo.inputDataSummary;
    }
    row.steps = structuredStepsFromText(row.inputAction, row);
    return row;
  }

  onBegin(config: FullConfig, suite: Suite) {
    const rootDir = config.rootDir ?? process.cwd();
    this.outputFolder = this.options.outputFolder ?? path.join(rootDir, "reports");
    this.filename = this.options.filename ?? this.filename;
    this.csvFilename = this.options.csvFilename ?? this.csvFilename;
    this.jsonFilename = this.options.jsonFilename ?? this.jsonFilename;
    this.assetsDir = path.join(this.outputFolder, "assets");
    fs.mkdirSync(this.assetsDir, { recursive: true });

    this.rows = suite.allTests().map((test, index) => {
      const row = this.buildRow(test, index, "PENDING");
      this.rowByTest.set(test, row);
      return row;
    });
    this.counter = this.rows.length;
    this.writeOutputs("running", false);
  }

  onTestBegin(test: TestCase) {
    const row = this.rowByTest.get(test);
    if (!row) return;
    row.status = "RUNNING";
    row.actualResult = actualResultForStatus("RUNNING");
    row.steps = structuredStepsFromText(row.inputAction, row);
    this.writeOutputs("running", false);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    let row = this.rowByTest.get(test);
    if (!row) {
      this.counter += 1;
      row = this.buildRow(test, this.counter - 1, "PENDING");
      this.rowByTest.set(test, row);
      this.rows.push(row);
    }

    const screenshotPaths: string[] = [];
    const screenshots = result.attachments.filter((att) => {
      const name = (att.name || "").toLowerCase();
      if (name.includes("screenshot")) return true;
      const ext = (att.path || "").toLowerCase();
      return ext.endsWith(".png") || ext.endsWith(".jpg") || ext.endsWith(".jpeg");
    });
    screenshots.forEach((screenshot, index) => {
      if (!screenshot.path || !fs.existsSync(screenshot.path)) return;
      const ext = path.extname(screenshot.path) || ".png";
      const filename = `shot_${row.id}_${String(index + 1).padStart(2, "0")}${ext}`;
      const dest = path.join(this.assetsDir, filename);
      fs.copyFileSync(screenshot.path, dest);
      screenshotPaths.push(path.relative(this.outputFolder, dest).replace(/\\/g, "/"));
    });
    const directUrlAttachment = [...result.attachments]
      .reverse()
      .find((attachment) => String(attachment.name || "").toLowerCase().startsWith("direct-url"));
    const directUrl = directUrlAttachment?.body
      ? Buffer.isBuffer(directUrlAttachment.body)
        ? directUrlAttachment.body.toString("utf8")
        : String(directUrlAttachment.body)
      : "";

    const normalizedStatus = normalizeStatus(result.status);
    const failureSummary = summarizeFailure(result);
    row.status = normalizedStatus;
    row.actualResult = actualResultForStatus(normalizedStatus, failureSummary);
    row.directUrl = directUrl.trim();
    row.steps = collectResultSteps(result, row);
    row.screenshotPaths = screenshotPaths.length > 0 ? screenshotPaths : undefined;
    row.evidenceNotes =
      screenshotPaths.length > 0
        ? [`Screenshot evidence captured after execution for ${row.id}.`]
        : [`Assertion evidence recorded for ${row.id}; no browser screenshot was produced for this test.`];
    row.bugReport =
      row.status === "FAIL"
        ? `Bug: ${row.testCaseTitle}. Expected: ${row.expectedResult}. Actual: ${failureSummary || "The test failed without a detailed Playwright error."}`
        : "";
    this.writeOutputs("running", false);
  }

  async onEnd(result: FullResult) {
    if (this.rows.length === 0) return;
    await this.writeOutputs(result.status, true);
  }

  private async writeOutputs(runStatus: string, writePdf: boolean) {
    if (this.rows.length === 0 || !this.outputFolder) return;
    fs.mkdirSync(this.outputFolder, { recursive: true });
    fs.mkdirSync(this.assetsDir, { recursive: true });

    const reportRows = writePdf ? this.rows.filter((row) => row.status !== "PENDING") : this.rows;
    const counts = reportRows.reduce(
      (acc, row) => {
        acc[row.status] += 1;
        return acc;
      },
      { PENDING: 0, RUNNING: 0, PASS: 0, FAIL: 0, SKIP: 0 } as Record<Row["status"], number>
    );
    const htmlRows = reportRows
      .map((row) => {
        const cell = (content: string, className = "") =>
          `<td${className ? ` class="${className}"` : ""}><div class="cell-content">${content}</div></td>`;
        const screenshotCell = row.screenshotPaths?.length
          ? row.screenshotPaths
              .map(
                (screenshotPath, index) =>
                  `<a class="evidence-link" href="${screenshotPath}">View ${index + 1}</a><img class="evidence-shot" src="${screenshotPath}" alt="screenshot ${index + 1}" />`
              )
              .join("<br/>")
          : "";
        const evidenceNotes = row.evidenceNotes?.length
          ? `<div>${row.evidenceNotes.map((note) => sanitize(note)).join("<br/>")}</div>`
          : "";
        return `<tr>
  ${cell(sanitize(row.id), "case-id-cell")}
  ${cell(`<span class="tag-list">${sanitize(row.tags)}</span>`)}
  ${cell(sanitize(row.moduleSuite))}
  ${cell(sanitize(row.testCaseTitle))}
  ${cell(sanitize(row.surface))}
  ${cell(sanitize(row.featureArea))}
  ${cell(sanitize(row.precondition))}
  ${cell(sanitize(row.inputAction))}
  ${cell(sanitize(row.testData))}
  ${cell(sanitize(row.executionSource))}
  ${cell(sanitize(row.requestedBy))}
  ${cell(sanitize(row.performedBy))}
  ${cell(sanitize(row.fieldsUpdated))}
  ${cell(row.directUrl ? `<a class="evidence-link" href="${sanitize(row.directUrl)}" target="_blank" rel="noreferrer">${sanitize(row.directUrl)}</a>` : "")}
  ${cell(sanitize(row.expectedResult))}
  ${cell(sanitize(row.actualResult))}
  ${cell(sanitize(row.proof))}
  ${cell(`<span class="status ${row.status}">${row.status}</span>`, "status-cell")}
  ${cell(sanitize(row.priority))}
  ${cell(sanitize(row.testingLevel))}
  ${cell(sanitize(row.automationStatus))}
  ${cell(sanitize(row.bugReport ?? ""))}
  ${cell(`${evidenceNotes}${screenshotCell}`, "screenshot-cell")}
</tr>`;
      })
      .join("\n");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Automated Test Results</title>
  ${runStatus === "running" ? '<meta http-equiv="refresh" content="5" />' : ""}
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f5;
      --panel: #ffffff;
      --panel-2: #fbfbfa;
      --border: #e6e4df;
      --border-strong: #d8d5ce;
      --text: #1f1f1d;
      --muted: #6f6b63;
      --accent: #2f66d0;
      --pass: #0f7a35;
      --fail: #b42318;
      --pending: #6b7280;
      --running: #1d4ed8;
      --skip: #64748b;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; min-width: 0; }
    html, body { width: 100%; height: 100%; max-width: 100dvw; max-height: 100dvh; overflow: hidden; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    .report-shell {
      width: 100dvw;
      height: 100dvh;
      max-width: 100dvw;
      max-height: 100dvh;
      overflow: auto;
      padding: 18px 20px 24px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 18px;
    }
    .eyebrow {
      margin: 0 0 4px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 { margin: 0; font-size: clamp(22px, 3vw, 34px); line-height: 1.1; overflow-wrap: anywhere; }
    .run-meta { margin: 8px 0 0; color: var(--muted); overflow-wrap: anywhere; }
    .report-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .report-actions a {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 7px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      font-weight: 650;
      box-shadow: 0 1px 1px rgba(15, 23, 42, 0.03);
    }
    .report-actions a:hover {
      background: #f1f1ef;
      border-color: var(--border-strong);
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric {
      min-height: 78px;
      padding: 13px 14px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--panel);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
    }
    .metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 7px; }
    .metric strong { font-size: 22px; overflow-wrap: anywhere; }
    .table-card {
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--panel);
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .table-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
    }
    .table-head h2 { margin: 0; font-size: 16px; }
    .table-head span { color: var(--muted); font-size: 13px; }
    .table-wrap {
      max-width: 100%;
      max-height: calc(100dvh - 236px);
      overflow: auto;
      scrollbar-gutter: stable;
      background: var(--panel);
    }
    .table-wrap::-webkit-scrollbar { width: 12px; height: 12px; }
    .table-wrap::-webkit-scrollbar-track { background: #f1f1ef; }
    .table-wrap::-webkit-scrollbar-thumb {
      background: #c7c3bb;
      border: 3px solid #f1f1ef;
      border-radius: 999px;
    }
    table {
      width: max-content;
      min-width: 3600px;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      padding: 0;
      text-align: left;
      vertical-align: top;
      font-size: 12px;
      line-height: 1.42;
      overflow: hidden;
      text-overflow: ellipsis;
      overflow-wrap: normal;
      word-break: normal;
      background: var(--panel);
    }
    th {
      padding: 8px 10px;
      position: sticky;
      top: 0;
      z-index: 3;
      background: var(--panel-2);
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
      font-weight: 700;
      white-space: nowrap;
      box-shadow: inset 0 -1px 0 var(--border-strong);
    }
    td {
      white-space: normal;
    }
    .cell-content {
      max-height: 92px;
      overflow: auto;
      padding: 9px 10px;
    }
    .cell-content::-webkit-scrollbar { width: 7px; height: 7px; }
    .cell-content::-webkit-scrollbar-thumb {
      background: #d6d2ca;
      border-radius: 999px;
    }
    .case-id-cell .cell-content,
    .status-cell .cell-content {
      max-height: none;
      overflow: visible;
    }
    th:first-child,
    td:first-child {
      position: sticky;
      left: 0;
      z-index: 2;
      background: var(--panel);
      box-shadow: inset -1px 0 0 var(--border), inset 0 -1px 0 var(--border);
    }
    th:first-child {
      z-index: 4;
      background: var(--panel-2);
    }
    tbody tr:nth-child(even) td { background: #fcfcfb; }
    tbody tr:nth-child(even) td:first-child { background: #fcfcfb; }
    tr:hover td { background: color-mix(in srgb, var(--accent), transparent 96%); }
    tr:hover td:first-child { background: color-mix(in srgb, var(--accent), transparent 96%); }
    td:nth-child(2),
    td:nth-child(4),
    td:nth-child(7),
    td:nth-child(8),
    td:nth-child(9),
    td:nth-child(14),
    td:nth-child(15),
    td:nth-child(16),
    td:nth-child(17),
    td:nth-child(22),
    td:nth-child(23) {
      overflow-wrap: anywhere;
    }
    td:nth-child(1),
    td:nth-child(5),
    td:nth-child(6),
    td:nth-child(10),
    td:nth-child(11),
    td:nth-child(12),
    td:nth-child(13),
    td:nth-child(18),
    td:nth-child(19),
    td:nth-child(20),
    td:nth-child(21) {
      white-space: nowrap;
    }
    .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 62px;
      border-radius: 999px;
      padding: 3px 8px;
      font-weight: 800;
      font-size: 11px;
    }
    .tag-list {
      display: inline-flex;
      max-width: 220px;
      color: var(--accent);
      font-weight: 750;
      overflow-wrap: anywhere;
    }
    .PENDING { background: #f1f1ef; color: var(--pending); }
    .RUNNING { background: #e8f0ff; color: var(--running); }
    .PASS { background: #dbf3e2; color: var(--pass); }
    .FAIL { background: #fde2df; color: var(--fail); }
    .SKIP { background: #eceff3; color: var(--skip); }
    .evidence-link {
      display: inline-flex;
      margin-bottom: 6px;
      color: var(--accent);
      font-weight: 700;
      text-decoration: none;
    }
    .evidence-shot {
      display: block;
      width: 92px;
      max-width: 100%;
      max-height: 58px;
      object-fit: contain;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel-2);
    }
    @media (max-width: 900px) {
      .report-shell { padding: 10px; }
      .hero { flex-direction: column; }
      .report-actions { justify-content: flex-start; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .table-wrap { max-height: calc(100dvh - 300px); }
      table { min-width: 3000px; }
    }
    @media print {
      html, body, .report-shell { height: auto; max-height: none; overflow: visible; }
      .table-wrap { max-height: none; overflow: visible; }
      .report-actions { display: none; }
    }
  </style>
</head>
<body>
  <main class="report-shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Core Platform QA</p>
        <h1>Automated Test Results</h1>
        <p class="run-meta">Run status: ${sanitize(runStatus)} | Total cases: ${reportRows.length} | Updated: ${sanitize(new Date().toLocaleString())}</p>
      </div>
      <nav class="report-actions" aria-label="Report exports">
        <a href="/">Back to Dashboard</a>
        <a href="${sanitize(this.csvFilename)}">CSV</a>
        <a href="${sanitize(this.jsonFilename)}">JSON</a>
      </nav>
    </header>
    <section class="summary" aria-label="Result summary">
      <article class="metric"><span>Total</span><strong>${reportRows.length}</strong></article>
      <article class="metric"><span>Pending</span><strong class="PENDING">${counts.PENDING}</strong></article>
      <article class="metric"><span>Running</span><strong class="RUNNING">${counts.RUNNING}</strong></article>
      <article class="metric"><span>Passed</span><strong class="PASS">${counts.PASS}</strong></article>
      <article class="metric"><span>Failed</span><strong class="FAIL">${counts.FAIL}</strong></article>
      <article class="metric"><span>Skipped</span><strong class="SKIP">${counts.SKIP}</strong></article>
    </section>
    <section class="table-card" aria-label="Test case results">
      <div class="table-head">
        <h2>Test Case Results</h2>
        <span>Scroll inside the table to inspect wide result fields.</span>
      </div>
      <div class="table-wrap">
        <table>
          <colgroup>
            <col style="width: 140px" />
            <col style="width: 210px" />
            <col style="width: 170px" />
            <col style="width: 320px" />
            <col style="width: 120px" />
            <col style="width: 150px" />
            <col style="width: 240px" />
            <col style="width: 360px" />
            <col style="width: 300px" />
            <col style="width: 150px" />
            <col style="width: 140px" />
            <col style="width: 150px" />
            <col style="width: 150px" />
            <col style="width: 240px" />
            <col style="width: 260px" />
            <col style="width: 210px" />
            <col style="width: 260px" />
            <col style="width: 120px" />
            <col style="width: 110px" />
            <col style="width: 130px" />
            <col style="width: 150px" />
            <col style="width: 260px" />
            <col style="width: 240px" />
          </colgroup>
          <thead>
            <tr>
              <th>Test Case ID</th>
              <th>Tags</th>
              <th>Module / Suite</th>
              <th>Test Case Title</th>
              <th>Surface</th>
              <th>Feature Area</th>
              <th>Pre-conditions</th>
              <th>Test Steps</th>
              <th>Test Data</th>
              <th>Input Source</th>
              <th>Requested By</th>
              <th>Performed By</th>
              <th>Fields Updated</th>
              <th>Direct URL</th>
              <th>Expected Result</th>
              <th>Actual Result</th>
              <th>What this test proves</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Testing Level</th>
              <th>Automation Status</th>
              <th>Bug Report</th>
              <th>Screenshot</th>
            </tr>
          </thead>
          <tbody>
${htmlRows}
          </tbody>
        </table>
      </div>
    </section>
  </main>
</body>
</html>`;

    const outputPath = path.join(this.outputFolder, this.filename);
    fs.writeFileSync(outputPath, html, "utf8");
    const csvPath = path.join(this.outputFolder, this.csvFilename);
    const csvHeader = [
      "Test Case ID",
      "Tags",
      "Module / Suite",
      "Test Case Title",
      "Surface",
      "Feature Area",
      "Pre-conditions",
      "Test Steps",
      "Test Data",
      "Input Source",
      "Requested By",
      "Performed By",
      "Fields Updated",
      "Direct URL",
      "Expected Result",
      "Actual Result",
      "What this test proves",
      "Status",
      "Priority",
      "Testing Level",
      "Automation Status",
      "Bug Report",
      "Screenshot"
    ];
    const csvRows = reportRows.map((row) =>
      [
        row.id,
        row.tags,
        row.moduleSuite,
        row.testCaseTitle,
        row.surface,
        row.featureArea,
        row.precondition,
        row.inputAction,
        row.testData,
        row.executionSource,
        row.requestedBy,
        row.performedBy,
        row.fieldsUpdated,
        row.directUrl,
        row.expectedResult,
        row.actualResult,
        row.proof,
        row.status,
        row.priority,
        row.testingLevel,
        row.automationStatus,
        row.bugReport ?? "",
        [row.evidenceNotes?.join("; ") ?? "", row.screenshotPaths?.join("; ") ?? ""]
          .filter(Boolean)
          .join("; ")
      ]
        .map(csvCell)
        .join(",")
    );
    fs.writeFileSync(csvPath, `${csvHeader.map(csvCell).join(",")}\n${csvRows.join("\n")}\n`, "utf8");
    fs.writeFileSync(
      path.join(this.outputFolder, this.jsonFilename),
      JSON.stringify(
        {
          runStatus,
          updatedAt: new Date().toISOString(),
          total: reportRows.length,
          counts,
          rows: reportRows
        },
        null,
        2
      ),
      "utf8"
    );
    if (writePdf) {
      await writePdfFromHtml(outputPath);
    }
  }
}
