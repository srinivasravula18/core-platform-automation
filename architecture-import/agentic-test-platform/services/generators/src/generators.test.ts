/**
 * ponytail self-check for the payload mutator + case generator, on the real leave_request object.
 * The mutator is load-bearing (it decides what counts as a passing vs failing API contract test),
 * so it gets the explicit check the plan calls for. Run: pnpm -F @atp/generators test
 */
import assert from "node:assert/strict";
import type { ObjectDescriptor } from "@atp/shared";
import { generateRequests, buildValidBody } from "./payload.ts";
import { generateCases } from "./cases.ts";

const leaveRequest: ObjectDescriptor = {
  object: { id: "obj0000011", api_name: "leave_request", label: "Leave Request", id_prefix: "lve", app: "hr" },
  fields: [
    { id: "1", api_name: "id", label: "ID", type: "text", required: true, searchable: false },
    { id: "2", api_name: "start_date", label: "Start Date", type: "date", required: true, searchable: false },
    { id: "3", api_name: "end_date", label: "End Date", type: "date", required: true, searchable: false },
    { id: "4", api_name: "leave_type", label: "Leave Type", type: "picklist", required: false, searchable: false },
    { id: "5", api_name: "status", label: "Status", type: "picklist", required: false, searchable: false },
    { id: "6", api_name: "employee_id", label: "Employee", type: "reference", required: false, searchable: false, reference_object: "employee" },
  ],
  picklists: {
    leave_type: [{ value: "annual", label: "Annual", active: true }, { value: "sick", label: "Sick", active: true }],
    status: [{ value: "pending", label: "Pending", active: true }],
  },
  layouts: [],
  validationRules: [],
  permissions: [{ object: "leave_request", role: "viewer", can_create: false, can_read: true, can_edit: false, can_delete: false }],
};

// valid body excludes server-assigned id, includes required start/end dates
const body = buildValidBody(leaveRequest);
assert.deepEqual(body, { start_date: "2026-07-01", end_date: "2026-07-01" });
assert.equal("id" in body, false, "server-assigned id must not be in the request body");

const reqs = generateRequests(leaveRequest);
const valid = reqs.filter((r) => r.variant === "valid");
assert.equal(valid.length, 1);
assert.equal(valid[0]!.expect.statusClass, "2xx");

// one required-omit case per required field (start_date, end_date) — each expects 4xx
const omits = reqs.filter((r) => r.caseId.includes("-REQ-"));
assert.equal(omits.length, 2);
for (const o of omits) {
  assert.equal(o.expect.statusClass, "4xx");
  // the omitted field must actually be absent from the body
  const field = o.caseId.split("-REQ-")[1]!.toLowerCase();
  assert.equal(o.body && field in o.body, false, `${field} must be omitted in ${o.caseId}`);
}

// picklist enum-violation cases expect 4xx
const enums = reqs.filter((r) => r.caseId.includes("-ENUM-"));
assert.ok(enums.length >= 1);
assert.ok(enums.every((e) => e.expect.statusClass === "4xx"));

// case generator: a create case + per-required negatives + an access-control case for 'viewer'
const cases = generateCases(leaveRequest);
assert.ok(cases.some((c) => c.code === "TC-LEAVE_REQUEST-CREATE" && c.suiteTypes.includes("bvt")));
assert.equal(cases.filter((c) => c.technique === "negative-required").length, 2);
assert.ok(cases.some((c) => c.technique === "access-control" && c.code === "TC-LEAVE_REQUEST-ACL-VIEWER"));

console.log("✓ generators self-check passed (payload mutator + case generator)");
