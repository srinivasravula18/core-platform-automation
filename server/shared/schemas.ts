import { z } from 'zod';

function stringifyField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => stringifyField(item)).filter(Boolean).join('; ');
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map((item) => stringifyField(item)).filter(Boolean).join('; ');
  return value === undefined || value === null ? '' : String(value);
}

function scriptFilename(value: string, fallback: string): string {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || fallback}.spec.ts`;
}

function fallbackScript(title: string): string {
  return `import { test, expect } from '@playwright/test';\n\ntest('${title.replace(/'/g, "\\'")}', async ({ page }) => {\n  await page.goto('/');\n  // Add your assertions here\n});`;
}

export const appFlowsSchema = z.object({
  flows: z.array(z.object({
    name: z.string().describe('Name of the user flow'),
    description: z.string().describe('Detailed description of the flow'),
    pages: z.array(z.string()).describe('Pages involved'),
  }))
});

export const testCasesSchema = z.object({
  test_cases: z.array(z.object({
    title: z.string(),
    description: z.string(),
    preconditions: z.string(),
    tags: z.array(z.string()),
    priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
    type: z.enum(['Manual', 'Automated', 'Both']),
    steps: z.array(z.object({
      action: z.string(),
      expected: z.string()
    }))
  }))
});

const playwrightScriptItemSchema = z.preprocess((value) => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : { code: value };
  const title = stringifyField(raw.test_case_title || raw.title || raw.name || raw.testName || raw.test_name || raw.caseTitle || raw.case_title) || 'Generated Playwright script';
  const filename = stringifyField(raw.filename || raw.file || raw.path) || scriptFilename(title, 'generated-playwright-script');
  const code = stringifyField(raw.code || raw.script || raw.source || raw.content || raw.playwright || raw.test || raw.body) || fallbackScript(title);
  return { ...raw, test_case_title: title, filename, code };
}, z.object({
  test_case_title: z.string(),
  filename: z.string(),
  code: z.string()
}));

export const playwrightScriptsSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return { scripts: value };
  if (!value || typeof value !== 'object') return { scripts: [] };
  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.scripts)) return raw;
  if (Array.isArray(raw.playwright_scripts)) return { ...raw, scripts: raw.playwright_scripts };
  if (Array.isArray(raw.tests)) return { ...raw, scripts: raw.tests };
  return { ...raw, scripts: [] };
}, z.object({
  scripts: z.array(playwrightScriptItemSchema)
}));

// ===== Structured Test Plan IR (Evidence-Graph Phase 3) =====
// Re-exported from the compiler so all schema consumers import from one place. The IR is abstract QA intent
// (semantic steps over enumerated targets); the deterministic Compiler — not the LLM — produces Playwright.
// `playwrightScriptsSchema` above remains for the legacy LLM-writes-code path until the compiler is default.
export {
  testPlanSchema, planStepSchema, actionStepSchema, assertStepSchema,
  PLAN_ACTIONS, PLAN_ASSERTS, parseTestPlan,
  type TestPlan, type PlanStep, type ActionStep, type AssertStep, type PlanAction, type PlanAssert,
} from '../features/agent/compiler/testPlan';

// ===== Failure investigation (bug-investigation framework, Phase 3) =====
// Strict wire schemas for the LLM investigator + intent-outcome judge. Every observation must carry its own
// confidence AND the verification methods that support it — fabricated certainty is unrepresentable.

/** One investigator observation: a statement, its confidence, and what verified it. */
export const observationSchema = z.object({
  statement: z.string().min(1),
  confidence: z.number().min(0).max(1),
  verifiedBy: z.array(z.string()).default([]),
});
export type Observation = z.infer<typeof observationSchema>;

export const FAILURE_CLASSIFICATIONS = [
  'functional', 'ui', 'ux', 'validation', 'data', 'search', 'filter', 'sorting', 'synchronization',
  'state', 'permission', 'auth', 'api', 'performance', 'a11y', 'workflow', 'regression',
  'automation_issue', 'environment', 'unknown',
] as const;
export type FailureClassificationKind = typeof FAILURE_CLASSIFICATIONS[number];

export const failureClassificationSchema = z.object({
  classification: z.enum(FAILURE_CLASSIFICATIONS),
  rootCauseArea: z.string().default(''),
  confidence: z.number().min(0).max(1),
  observations: z.array(observationSchema).default([]),
  severity: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(),
  suggestedAreas: z.array(z.string()).default([]),
});
export type FailureClassification = z.infer<typeof failureClassificationSchema>;

/** Intent-outcome judge verdict: did the app accomplish what the case INTENDED (not just pass assertions)? */
export const intentOutcomeSchema = z.object({
  intentSatisfied: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().default(''),
  observations: z.array(observationSchema).default([]),
});
export type IntentOutcome = z.infer<typeof intentOutcomeSchema>;
