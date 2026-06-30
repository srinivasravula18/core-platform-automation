/** Test-artifact domain types (ISTQB-flavoured), shared across generators/orchestrator/db. */

export type SuiteType = "sanity" | "regression" | "bvt" | "api";

export type TestTechnique =
  | "crud"
  | "equivalence-partition"
  | "boundary-value"
  | "negative-required"
  | "negative-type"
  | "reference-integrity"
  | "access-control"
  | "validation-rule"
  | "business-flow";

export type TestKind = "ui" | "api";
export type Priority = "p1" | "p2" | "p3";

export interface TestStep {
  action: string; // human-readable action
  /** (object, field) the step targets, if any — resolved to a grounded locator at script-gen */
  target?: { object: string; field: string };
  data?: unknown;
  expected: string;
}

export interface TestCase {
  code: string; // e.g. TC-LEAVE_REQUEST-REQ-END_DATE
  title: string;
  object: string;
  kind: TestKind;
  technique: TestTechnique;
  suiteTypes: SuiteType[];
  priority: Priority;
  preconditions: string[];
  steps: TestStep[];
  expectedResult: string;
  /** requirement codes this case covers (for the RTM) */
  requirementRefs: string[];
}

/** API request shape produced by the payload mutator / mcp-api-test. */
export type PayloadVariant = "valid" | "boundary" | "invalid";

export interface ApiRequestCase {
  caseId: string;
  object: string;
  variant: PayloadVariant;
  rationale: string;
  method: "POST" | "GET" | "PATCH" | "DELETE";
  path: string; // e.g. /api/data/leave_request
  body?: Record<string, unknown>;
  /** expected outcome: status class + (optionally) which field/rule should reject it */
  expect: { statusClass: "2xx" | "4xx"; reason?: string };
}
