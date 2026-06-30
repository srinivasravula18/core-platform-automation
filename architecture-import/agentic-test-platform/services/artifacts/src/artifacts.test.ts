/** ponytail self-check: artifact validation + markdown serialization. Run: pnpm -F @atp/artifacts test */
import assert from "node:assert/strict";
import { TestCaseSchema, TestPlanSchema, testPlanToMarkdown, rtmToMarkdown } from "./index.ts";

// zod rejects a malformed case
assert.equal(TestCaseSchema.safeParse({ code: "x" }).success, false);

// a well-formed case validates
const ok = TestCaseSchema.safeParse({
  code: "TC-1", title: "t", object: "leave_request", kind: "ui", technique: "crud",
  suiteTypes: ["sanity"], priority: "p1", preconditions: [], steps: [{ action: "a", expected: "b" }],
  expectedResult: "r", requirementRefs: [],
});
assert.equal(ok.success, true);

const plan = TestPlanSchema.parse({
  identifier: "TP-HR-1", scope: "HR app", featuresToTest: ["leave_request CRUD"], featuresNotToTest: [],
  approach: "risk-based", passFailCriteria: "all p1 pass", suspensionCriteria: "env down", deliverables: ["report"],
  environment: "qa", responsibilities: "QA agents", schedule: "on demand", risks: ["stale metadata"], approvals: ["lead"],
});
const md = testPlanToMarkdown(plan);
assert.ok(md.includes("# Test Plan TP-HR-1") && md.includes("leave_request CRUD"));

const rtm = rtmToMarkdown(
  [{ code: "REQ-1", description: "create leave", type: "functional", priority: "p1", status: "approved" }],
  [{ requirement: "REQ-1", cases: ["TC-1"] }],
);
assert.ok(rtm.includes("REQ-1") && rtm.includes("TC-1"));

console.log("✓ artifacts self-check passed (zod schemas + serializers)");
