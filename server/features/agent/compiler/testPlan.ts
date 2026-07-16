/**
 * Structured Test Plan IR (Phase 3) — the ONLY thing the LLM is allowed to emit. It is abstract QA intent:
 * a list of semantic steps that reference enumerated semantic targets (from the Evidence-Graph catalog). It
 * contains NO selectors, URLs, roles, aria, css, xpath, waits, login, or navigation — those are the
 * deterministic Compiler's job. Closed enums make invalid intent unrepresentable; the Grounding Engine +
 * validation gate reject any target that is not a verified catalog entry.
 */
import { z } from 'zod';

/** Concrete interactions. OPEN_MODULE is navigation intent resolved by MissionRunner, not a raw goto. */
export const PLAN_ACTIONS = ['OPEN_MODULE', 'CLICK', 'FILL', 'SELECT', 'CHECK', 'UNCHECK', 'HOVER', 'PRESS', 'CLEAR'] as const;
/** Observations. VERIFY_* are higher-level QA intents the Compiler expands into concrete assertions. */
export const PLAN_ASSERTS = [
  'VISIBLE', 'NOT_VISIBLE', 'ENABLED', 'DISABLED', 'HAS_TEXT', 'NOT_HAS_TEXT', 'HAS_VALUE', 'COUNT_GT',
  'VERIFY_TABLE', 'VERIFY_FILTER', 'VERIFY_SORT', 'VERIFY_PAGINATION', 'VERIFY_LOOKUP', 'VERIFY_PERMISSION',
  'VERIFY_VALIDATION', 'VERIFY_ERROR',
  // Multi-level context asserts (bug-investigation framework, Phase 4): mission/page-scoped observations the
  // MissionRunner owns — their target is ADVISORY TEXT (like OPEN_MODULE), never grounded to a locator.
  'URL_MATCHES', 'HAS_STATUS', 'EMPTY_STATE', 'ERROR_STATE', 'ROW_IN_LIST', 'FOUND_IN_GLOBAL_SEARCH',
] as const;

/** Asserts whose target is advisory text (URL fragments, expected messages, row text) — the compiler must
 * NOT ground them against the evidence catalog; MissionRunner resolves them against the live page. */
export const CONTEXT_ASSERTS = new Set<string>([
  'URL_MATCHES', 'HAS_STATUS', 'EMPTY_STATE', 'ERROR_STATE', 'ROW_IN_LIST', 'FOUND_IN_GLOBAL_SEARCH',
]);

export type PlanAction = typeof PLAN_ACTIONS[number];
export type PlanAssert = typeof PLAN_ASSERTS[number];

export interface ActionStep { action: PlanAction; target: string; value?: string }
export interface AssertStep { assert: PlanAssert; target: string; value?: string }
export type PlanStep = ActionStep | AssertStep;

export interface TestPlan {
  /** Echo of MissionContext.executionScope / platform — advisory; never authored by the LLM as navigation. */
  mission: string;
  module?: string;
  title?: string;
  steps: PlanStep[];
  /** Present on deterministic plans so partial source-case translation cannot pass silently. */
  sourceStepCount?: number;
  mappedSourceSteps?: number[];
}

// A single, permissive step object (NOT strict — extra keys like `expected`/`description` are ignored, not
// fatal). Exactly one of action|assert is required. This is far easier for a provider's structured output
// than a strict discriminated union, which was the root cause of every step being rejected (PLAN_MISSING).
export const planStepSchema = z.object({
  action: z.enum(PLAN_ACTIONS).optional(),
  assert: z.enum(PLAN_ASSERTS).optional(),
  target: z.string().min(1),
  value: z.string().optional(),
}).refine((s) => (!!s.action) !== (!!s.assert), { message: 'each step needs exactly one of action|assert' });

// Kept for back-compat with any importer; both now alias the permissive step.
export const actionStepSchema = planStepSchema;
export const assertStepSchema = planStepSchema;

const ACTION_SET = new Set<string>(PLAN_ACTIONS as readonly string[]);
const ASSERT_SET = new Set<string>(PLAN_ASSERTS as readonly string[]);
const asStr = (v: unknown): string | undefined => (v == null ? undefined : String(v));
const snapEnum = (v: unknown): string | undefined => {
  const s = asStr(v);
  if (!s) return undefined;
  return s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
};

/**
 * Tolerant normalizer for real model output. Unwraps common wrappers, coerces a bare steps array, maps alt
 * keys, snaps enum casing, and DROPS steps that still don't fit (rather than failing the whole plan). Runs
 * inside the schema via z.preprocess, so the provider's parse and parseTestPlan both benefit.
 */
export function normalizeTestPlanInput(raw: unknown): unknown {
  let o: any = raw;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return raw; } }
  if (o && typeof o === 'object' && !Array.isArray(o)) o = o.plan ?? o.testPlan ?? o.test_plan ?? o.result ?? o;
  if (Array.isArray(o)) o = { steps: o };
  if (!o || typeof o !== 'object') return raw;

  let steps: any[] = o.steps ?? o.plan_steps ?? o.actions ?? o.items ?? [];
  if (!Array.isArray(steps)) steps = [];
  const normSteps = steps.map((s: any) => {
    if (!s || typeof s !== 'object') return null;
    const target = asStr(s.target ?? s.element ?? s.selectorName ?? s.name ?? s.control ?? s.locator);
    if (!target) return null;
    const assert = snapEnum(s.assert ?? s.expect ?? s.verify ?? s.verification);
    const action = snapEnum(s.action ?? s.step ?? s.type ?? s.do);
    const out: any = { target };
    if (assert && ASSERT_SET.has(assert)) out.assert = assert;
    else if (action && ACTION_SET.has(action)) out.action = action;
    else return null; // no recognizable verb → drop the step rather than fail the plan
    if (s.value != null) out.value = asStr(s.value);
    return out;
  }).filter(Boolean);

  return { mission: asStr(o.mission), module: asStr(o.module), title: asStr(o.title), steps: normSteps };
}

const testPlanObjectSchema = z.object({
  mission: z.string().optional(),
  module: z.string().optional(),
  title: z.string().optional(),
  steps: z.array(planStepSchema).min(1),
});

export const testPlanSchema = z.preprocess(normalizeTestPlanInput, testPlanObjectSchema);

export function isActionStep(s: PlanStep): s is ActionStep {
  return typeof (s as ActionStep).action === 'string';
}
export function isAssertStep(s: PlanStep): s is AssertStep {
  return typeof (s as AssertStep).assert === 'string';
}

/** Validate untyped JSON into a TestPlan (returns null on failure — caller decides how to recover). */
export function parseTestPlan(json: unknown): TestPlan | null {
  const r = testPlanSchema.safeParse(json);
  return r.success ? (r.data as TestPlan) : null;
}

// ===== Strict variant (LangGraph authoring path) — ADDITIVE; the tolerant schema above stays the live legacy path =====

/** v2 adds the strict no-normalizer parse for the graph path; the tolerant v1 behavior is unchanged. */
export const TEST_PLAN_SCHEMA_VERSION = 2;

/**
 * Strict plan schema: NO preprocess/normalizer — steps must already match planStepSchema exactly (unknown
 * keys are stripped, never fatal), and any step without a valid action/assert verb fails the WHOLE parse.
 * Guarantee for the graph path: N steps in → N steps out, or an explicit failure — never a silent drop.
 */
export const strictTestPlanSchema = z.object({
  mission: z.string().optional(),
  module: z.string().optional(),
  title: z.string().optional(),
  steps: z.array(planStepSchema).min(1),
});

/** Per-step, model-quotable reasons for a strict-parse failure (1-based indexes, e.g. "step 3: unrecognized action 'SCROLL'"). */
function describeStrictPlanIssues(raw: unknown, error: z.ZodError): string[] {
  const issues: string[] = [];
  const o: any = raw;
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    issues.push(`plan is not a JSON object with a steps array (got ${o === null ? 'null' : Array.isArray(o) ? 'array' : typeof o})`);
    return issues;
  }
  for (const key of ['mission', 'module', 'title'] as const) {
    if (o[key] !== undefined && typeof o[key] !== 'string') issues.push(`${key} must be a string when present`);
  }
  if (!Array.isArray(o.steps)) issues.push('steps is missing or not an array');
  else if (o.steps.length === 0) issues.push('steps is empty — a plan needs at least one step');
  const steps: any[] = Array.isArray(o.steps) ? o.steps : [];
  steps.forEach((s, i) => {
    const n = i + 1;
    if (!s || typeof s !== 'object' || Array.isArray(s)) { issues.push(`step ${n}: not an object`); return; }
    const action = s.action; const assertV = s.assert;
    if (typeof s.target !== 'string' || !s.target.length) issues.push(`step ${n}: missing target (non-empty string required)`);
    if (action !== undefined && !ACTION_SET.has(String(action))) issues.push(`step ${n}: unrecognized action '${String(action)}'`);
    if (assertV !== undefined && !ASSERT_SET.has(String(assertV))) issues.push(`step ${n}: unrecognized assert '${String(assertV)}'`);
    if (action !== undefined && assertV !== undefined) issues.push(`step ${n}: has both action and assert (exactly one allowed)`);
    if (action === undefined && assertV === undefined) issues.push(`step ${n}: no action or assert verb`);
    if (s.value !== undefined && typeof s.value !== 'string') issues.push(`step ${n}: value must be a string`);
  });
  // Anything the structural walk above missed still surfaces via the raw zod issues — never an empty reason list.
  if (!issues.length) for (const zi of error.issues) issues.push(`${zi.path.join('.') || 'plan'}: ${zi.message}`);
  return issues;
}

/** Strict parse for the graph path: returns the plan, or null plus one quotable issue per offending step (for the single repair call). */
export function parseTestPlanStrict(json: unknown): { plan: TestPlan | null; issues: string[] } {
  const r = strictTestPlanSchema.safeParse(json);
  if (r.success) return { plan: r.data as TestPlan, issues: [] };
  return { plan: null, issues: describeStrictPlanIssues(json, r.error) };
}
