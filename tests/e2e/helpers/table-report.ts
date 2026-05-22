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
  bugReport?: string;
  screenshotPaths?: string[];
  evidenceNotes?: string[];
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
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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

const defaultTestData = (surface: string) => {
  if (surface === "API") return "Seeded credentials; app, object, and list-view IDs resolved at runtime.";
  if (surface === "Admin") return "Seeded admin credentials; seeded metadata list views.";
  if (surface === "Keystone") return "Seeded Keystone credentials; seeded industry-suite app/object records.";
  return "Seeded local test data.";
};

const actualResultForStatus = (status: Row["status"], failure = "") => {
  if (status === "PASS") return "As expected.";
  if (status === "FAIL") return failure || "Defect raised.";
  if (status === "SKIP") return "Skipped or blocked by precondition.";
  if (status === "RUNNING") return "Execution in progress.";
  return "Not Run.";
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
      input: "Execute test steps.",
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
    input: `Attempt ${niceFeature} as each role.`,
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
    return {
      id: `${levelCode(level)}_${moduleCode(featureArea)}_${String(index + 1).padStart(3, "0")}`,
      moduleSuite: `${meta.surface || "Application"} / ${featureArea}`,
      testCaseTitle: formatTitle(test),
      surface: meta.surface,
      featureArea,
      scenario,
      precondition: meta.precondition,
      inputAction: meta.input,
      testData: meta.testData || defaultTestData(meta.surface),
      expectedResult: meta.expected,
      actualResult: actualResultForStatus(status),
      proof: meta.proof,
      status,
      priority: normalizePriority(meta.priority, level, scenario),
      testingLevel: level,
      automationStatus: normalizeAutomationStatus(meta.automation)
    };
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

    const normalizedStatus = normalizeStatus(result.status);
    const failureSummary = summarizeFailure(result);
    row.status = normalizedStatus;
    row.actualResult = actualResultForStatus(normalizedStatus, failureSummary);
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

    const counts = this.rows.reduce(
      (acc, row) => {
        acc[row.status] += 1;
        return acc;
      },
      { PENDING: 0, RUNNING: 0, PASS: 0, FAIL: 0, SKIP: 0 } as Record<Row["status"], number>
    );
    const htmlRows = this.rows
      .map((row) => {
        const screenshotCell = row.screenshotPaths?.length
          ? row.screenshotPaths
              .map(
                (screenshotPath, index) =>
                  `<a href="${screenshotPath}">View ${index + 1}</a><br/><img src="${screenshotPath}" alt="screenshot ${index + 1}" style="max-width: 220px; max-height: 140px;" />`
              )
              .join("<br/>")
          : "";
        const evidenceNotes = row.evidenceNotes?.length
          ? `<div>${row.evidenceNotes.map((note) => sanitize(note)).join("<br/>")}</div>`
          : "";
        return `<tr>
  <td>${sanitize(row.id)}</td>
  <td>${sanitize(row.moduleSuite)}</td>
  <td>${sanitize(row.testCaseTitle)}</td>
  <td>${sanitize(row.surface)}</td>
  <td>${sanitize(row.featureArea)}</td>
  <td>${sanitize(row.precondition)}</td>
  <td>${sanitize(row.inputAction)}</td>
  <td>${sanitize(row.testData)}</td>
  <td>${sanitize(row.expectedResult)}</td>
  <td>${sanitize(row.actualResult)}</td>
  <td>${sanitize(row.proof)}</td>
  <td class="${row.status}">${row.status}</td>
  <td>${sanitize(row.priority)}</td>
  <td>${sanitize(row.testingLevel)}</td>
  <td>${sanitize(row.automationStatus)}</td>
  <td>${sanitize(row.bugReport ?? "")}</td>
  <td>${evidenceNotes}${screenshotCell}</td>
</tr>`;
      })
      .join("\n");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Automated Test Results</title>
  ${runStatus === "running" ? '<meta http-equiv="refresh" content="5" />' : ""}
  <style>
    body { font-family: Arial, sans-serif; padding: 16px; }
    .summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .pill { border: 1px solid #ccc; border-radius: 999px; padding: 4px 10px; font-size: 13px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    .PENDING { color: #6b6b6b; font-weight: 600; }
    .RUNNING { color: #1d4ed8; font-weight: 600; }
    .PASS { color: #0a7d16; font-weight: 600; }
    .FAIL { color: #b00020; font-weight: 600; }
    .SKIP { color: #6b6b6b; font-weight: 600; }
    img { border: 1px solid #ddd; margin-top: 6px; }
  </style>
</head>
<body>
  <h1>Automated Test Results</h1>
  <p>Run status: ${sanitize(runStatus)} | Total: ${this.rows.length}</p>
  <div class="summary">
    <span class="pill PENDING">Pending: ${counts.PENDING}</span>
    <span class="pill RUNNING">Running: ${counts.RUNNING}</span>
    <span class="pill PASS">Passed: ${counts.PASS}</span>
    <span class="pill FAIL">Failed: ${counts.FAIL}</span>
    <span class="pill SKIP">Skipped: ${counts.SKIP}</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Test Case ID</th>
        <th>Module / Suite</th>
        <th>Test Case Title</th>
        <th>Surface</th>
        <th>Feature Area</th>
        <th>Pre-conditions</th>
        <th>Test Steps</th>
        <th>Test Data</th>
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
</body>
</html>`;

    const outputPath = path.join(this.outputFolder, this.filename);
    fs.writeFileSync(outputPath, html, "utf8");
    const csvPath = path.join(this.outputFolder, this.csvFilename);
    const csvHeader = [
      "Test Case ID",
      "Module / Suite",
      "Test Case Title",
      "Surface",
      "Feature Area",
      "Pre-conditions",
      "Test Steps",
      "Test Data",
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
    const csvRows = this.rows.map((row) =>
      [
        row.id,
        row.moduleSuite,
        row.testCaseTitle,
        row.surface,
        row.featureArea,
        row.precondition,
        row.inputAction,
        row.testData,
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
          total: this.rows.length,
          counts,
          rows: this.rows
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
