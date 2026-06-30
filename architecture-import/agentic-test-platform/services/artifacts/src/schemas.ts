import { z } from "zod";

/** ISTQB test case (zod-validated form of @atp/shared TestCase). */
export const TestStepSchema = z.object({
  action: z.string(),
  target: z.object({ object: z.string(), field: z.string() }).optional(),
  data: z.unknown().optional(),
  expected: z.string(),
});

export const TestCaseSchema = z.object({
  code: z.string(),
  title: z.string(),
  object: z.string(),
  kind: z.enum(["ui", "api"]),
  technique: z.string(),
  suiteTypes: z.array(z.enum(["sanity", "regression", "bvt", "api"])),
  priority: z.enum(["p1", "p2", "p3"]),
  preconditions: z.array(z.string()),
  steps: z.array(TestStepSchema),
  expectedResult: z.string(),
  requirementRefs: z.array(z.string()),
});

export const RequirementSchema = z.object({
  code: z.string(),
  description: z.string(),
  type: z.enum(["functional", "nfr", "access"]),
  priority: z.enum(["p1", "p2", "p3"]),
  sourceRef: z.string().optional(),
  status: z.enum(["provisional", "approved"]).default("provisional"),
});

/** IEEE-829 test plan. */
export const TestPlanSchema = z.object({
  identifier: z.string(),
  scope: z.string(),
  featuresToTest: z.array(z.string()),
  featuresNotToTest: z.array(z.string()),
  approach: z.string(),
  passFailCriteria: z.string(),
  suspensionCriteria: z.string(),
  deliverables: z.array(z.string()),
  environment: z.string(),
  responsibilities: z.string(),
  schedule: z.string(),
  risks: z.array(z.string()),
  approvals: z.array(z.string()),
});

export type TestPlan = z.infer<typeof TestPlanSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
