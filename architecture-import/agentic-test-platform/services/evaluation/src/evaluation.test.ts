/** ponytail self-check: accuracy = real comparison of agent output vs repo metadata. Run: pnpm -F @atp/evaluation test */
import assert from "node:assert/strict";
import type { ObjectDescriptor, TestCase } from "@atp/shared";
import { buildCatalog, defaultRenderProfile } from "@atp/grounding";
import { scoreAgainstRepo } from "./index.ts";

const descriptor: ObjectDescriptor = {
  object: { id: "o", api_name: "leave_request", label: "Leave Request", id_prefix: "lve", app: "hr" },
  fields: [
    { id: "1", api_name: "id", label: "ID", type: "text", required: true, searchable: false },
    { id: "2", api_name: "start_date", label: "Start Date", type: "date", required: true, searchable: false },
    { id: "3", api_name: "end_date", label: "End Date", type: "date", required: true, searchable: false },
  ],
  picklists: {}, layouts: [], validationRules: [], permissions: [],
};
const catalog = buildCatalog(descriptor, defaultRenderProfile);

// 1) a fully grounded output (every field + locator exists in the repo) scores 100
const goodCase: TestCase = {
  code: "TC", title: "create", object: "leave_request", kind: "ui", technique: "crud", suiteTypes: ["sanity"], priority: "p1",
  preconditions: [], steps: [{ action: "fill", target: { object: "leave_request", field: "start_date" }, expected: "ok" }], expectedResult: "ok", requirementRefs: [],
};
const goodScript = `await page.getByLabel('Start Date').fill('2026-07-01'); await page.getByLabel('End Date').fill('2026-07-02');`;
const good = scoreAgainstRepo(descriptor, { cases: [goodCase], script: goodScript, catalog });
assert.equal(good.score, 100, JSON.stringify(good.mismatches));
assert.equal(good.level, "high");

// 2) a HALLUCINATED field + an ungrounded locator drop the score, and are reported
const badCase: TestCase = { ...goodCase, steps: [{ action: "fill", target: { object: "leave_request", field: "vacation_days" }, expected: "ok" }] };
const badScript = `await page.getByLabel('Vacation Days').fill('3');`;
const bad = scoreAgainstRepo(descriptor, { cases: [badCase], script: badScript, catalog });
assert.ok(bad.score < 100, "hallucinated references must lower the score");
assert.ok(bad.mismatches.some((m) => m.kind === "field" && m.value === "vacation_days"));
assert.ok(bad.mismatches.some((m) => m.kind === "locator"));
// 1 object ok + 1 bad field + 1 ungrounded locator -> 1/3 matched
assert.equal(bad.matched, 1);
assert.equal(bad.total, 3);
assert.equal(bad.score, 33);

console.log("✓ evaluation self-check passed (accuracy = agent-output ⟷ repo-metadata agreement)");
