/**
 * ponytail self-check for grounding, using the REAL leave_request metadata
 * (verified live via the core_platform_db MCP). Run: pnpm -F @atp/grounding test
 */
import assert from "node:assert/strict";
import type { ObjectDescriptor } from "@atp/shared";
import { defaultRenderProfile, defaultChromeAllow } from "./render-profile.ts";
import { buildCatalog, synthesizeLocator } from "./synthesize.ts";
import { lintScript } from "./selector-lint.ts";

const leaveRequest: ObjectDescriptor = {
  object: { id: "obj0000011", api_name: "leave_request", label: "Leave Request", id_prefix: "lve", app: "hr" },
  fields: [
    { id: "1", api_name: "start_date", label: "Start Date", type: "date", required: true, searchable: false },
    { id: "2", api_name: "end_date", label: "End Date", type: "date", required: true, searchable: false },
    { id: "3", api_name: "leave_type", label: "Leave Type", type: "picklist", required: false, searchable: false },
    { id: "4", api_name: "status", label: "Status", type: "picklist", required: false, searchable: false },
    { id: "5", api_name: "employee_id", label: "Employee", type: "reference", required: false, searchable: false, reference_object: "employee" },
    { id: "6", api_name: "name", label: "Name", type: "text", required: false, searchable: true },
  ],
  picklists: { leave_type: [], status: [] },
  layouts: [],
  validationRules: [],
  permissions: [],
};

// 1) synthesis grounds a real locator from metadata
const startDate = synthesizeLocator("leave_request", leaveRequest.fields[0]!, defaultRenderProfile);
assert.equal(startDate.expression, "page.getByLabel('Start Date')");

const leaveType = synthesizeLocator("leave_request", leaveRequest.fields[2]!, defaultRenderProfile);
assert.equal(leaveType.expression, "page.getByRole('combobox', { name: 'Leave Type' })");

const catalog = buildCatalog(leaveRequest, defaultRenderProfile);
assert.equal(catalog.length, 6);

// 2) a grounded script passes lint
const goodScript = `
  await page.getByLabel('Start Date').fill('2026-07-01');
  await page.getByLabel('End Date').fill('2026-07-05');
  await page.getByRole('combobox', { name: 'Leave Type' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
`;
const good = lintScript(goodScript, catalog, defaultChromeAllow);
assert.equal(good.ok, true, JSON.stringify(good.violations));

// 3) a HALLUCINATED locator hard-fails
const hallucinated = `await page.getByLabel('Starting Date').fill('2026-07-01');`;
const bad = lintScript(hallucinated, catalog, defaultChromeAllow);
assert.equal(bad.ok, false);
assert.equal(bad.violations[0]!.kind, "ungrounded");
assert.ok(bad.candidates.includes("page.getByLabel('Start Date')"), "candidates feed self-heal");

// 4) XPath is banned
const xpath = `await page.locator('//input[@id="x"]').fill('y');`;
const x = lintScript(xpath, catalog, defaultChromeAllow);
assert.equal(x.ok, false);
assert.equal(x.violations[0]!.kind, "xpath");

console.log("✓ grounding self-check passed (synthesize + selector-lint)");
