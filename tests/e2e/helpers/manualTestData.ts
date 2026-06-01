import fs from "node:fs";

type ManualRow = {
  target?: string;
  action?: string;
  inputValue?: string;
  expectedValue?: string;
  notes?: string;
};

type ManualContext = {
  mode?: string;
  requestedBy?: string;
  performedBy?: string;
  mappings?: Array<{
    mode?: string;
    datasetName?: string;
    rows?: ManualRow[];
  }>;
};

let cachedContext: ManualContext | null | undefined;

const normalize = (value: string) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

export const manualTestDataContext = () => {
  if (cachedContext !== undefined) return cachedContext;
  const contextPath = process.env.MANUAL_TEST_DATA_CONTEXT || "";
  if (!contextPath || !fs.existsSync(contextPath)) {
    cachedContext = null;
    return cachedContext;
  }
  try {
    cachedContext = JSON.parse(fs.readFileSync(contextPath, "utf8")) as ManualContext;
  } catch {
    cachedContext = null;
  }
  return cachedContext;
};

export const isManualTestDataRun = () => manualTestDataContext()?.mode === "manual";

export const allManualRows = () =>
  (manualTestDataContext()?.mappings || [])
    .filter((mapping) => mapping.mode === "dataset")
    .flatMap((mapping) => mapping.rows || []);

export const manualValueForTargets = (targets: string[], fallback = "") => {
  const wanted = targets.map(normalize).filter(Boolean);
  if (wanted.length === 0) return fallback;
  const row = allManualRows().find((item) => {
    const haystack = normalize(`${item.target || ""} ${item.action || ""} ${item.notes || ""}`);
    return wanted.some((target) => haystack.includes(target));
  });
  return String(row?.inputValue || row?.expectedValue || fallback);
};

export const manualFieldValueMap = () => {
  const values: Record<string, string> = {};
  for (const row of allManualRows()) {
    const target = String(row.target || "").trim();
    const input = String(row.inputValue || "").trim();
    if (!target || !input) continue;
    values[target] = input;
  }
  return values;
};

export const manualDatasetLabel = () =>
  (manualTestDataContext()?.mappings || [])
    .filter((mapping) => mapping.mode === "dataset")
    .map((mapping) => mapping.datasetName)
    .filter(Boolean)
    .join(", ");
