/**
 * Authoring node — strict case + abstract-plan authoring (LangGraph migration, Phase 4).
 *
 * Provider-neutral per the architecture plan: the agent's provider/model resolve through the SAME
 * Settings-backed routing the legacy pipeline uses (resolveProviderForAgent/resolveModelForAgent), so
 * per-agent overrides keep working. OpenAI API-key routes go through the Responses structured client
 * (constrained decoding); Anthropic/Gemini (and any account-mode CLI) go through the existing
 * buildProvider adapters' generateObject. Either way, strict schema validation is the single authority
 * and a step/case is NEVER silently dropped.
 *
 * This node OWNS the one-repair loop from plan Section 10.5: exactly ONE second model call quoting the
 * validation issues, then a typed SCHEMA_INVALID_OUTPUT failure. Refusals get NO retry (MODEL_REFUSAL).
 * Transient transport failures are returned classified — the graph's node policy owns those retries.
 * Like its sibling nodes it never throws: every failure comes back as `errors: WorkflowError[]`.
 */
import { z } from 'zod';
import {
  resolveProviderForAgent, resolveModelForAgent, resolveEffortForAgent,
  getProviderCredentials, buildProvider,
} from '../../../../ai/orchestrator';
import { callOpenAIResponsesStructured } from '../../../../ai/openai/responsesClient';
import { canonicalAgent, systemPromptFor } from '../../../../ai/systemPrompts';
import type { ProviderName } from '../../../../ai/providers/types';
import { testCasesSchema } from '../../../../shared/schemas';
import { PLAN_ACTIONS, PLAN_ASSERTS, parseTestPlanStrict, type TestPlan } from '../../compiler/testPlan';
import { renderTargetCatalogForPrompt } from '../../compiler/renderCatalogForPrompt';
import type { EvidenceGraph } from '../../graph/evidenceGraph';
import { classifyError, WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, type WorkflowError } from '../errors';
import type { MissionRef, UsageRecord } from '../state';

/** One authored case in the established shared-schema shape — downstream review/plan nodes consume this. */
export type AuthoredTestCase = z.infer<typeof testCasesSchema>['test_cases'][number];
type CasesWire = z.infer<typeof testCasesSchema>;

export interface AuthorTestCasesInput {
  mission: MissionRef | null;
  /** Normalized user goal/prompt text (WorkflowRequest.goal). */
  goal: string;
  /** The chat's code-grounded feature analysis (behaviors, validation rules, derivations, payload, edges).
   * Rendered into the prompt so the writer authors the REAL behaviors, not just what the bare DOM implies. */
  understanding?: string;
  /** 0 = complexity-driven (model chooses a defensible count); >0 = exact count. */
  requestedCaseCount: number;
  /** Grounding vocabulary — rendered via renderTargetCatalogForPrompt, never dumped raw. */
  evidenceGraph: EvidenceGraph | null;
  /** Settings identity for provider/model/effort routing; defaults to the legacy case-authoring agent. */
  agent?: string;
  system?: string;
  signal?: AbortSignal;
  /** Topbar per-run provider/model/effort — authoritative over Settings, like the legacy path. */
  overrides?: { provider?: string; model?: string; effort?: string };
  /** True when the site has stored Settings credentials — authors are told auth is handled externally. */
  hasStoredCredentials?: boolean;
  /** Coverage "gaps": existing case titles to NOT duplicate — author only genuinely new behaviors. */
  avoidCaseTitles?: string[];
}

export interface AuthorTestCasesResult {
  cases: AuthoredTestCase[];
  usage: UsageRecord[];
  errors: WorkflowError[];
}

export interface AuthorAbstractPlanInput {
  mission: MissionRef | null;
  /** ONE reviewed case — the graph fans this node out per case (reducer keyed by case ID). */
  testCase: { title: string; description?: string; steps?: Array<{ action?: string; expected?: string }> };
  evidenceGraph: EvidenceGraph | null;
  /** Defaults to the legacy plan-authoring agent so existing Settings overrides keep applying. */
  agent?: string;
  system?: string;
  signal?: AbortSignal;
  /** Topbar per-run provider/model/effort — authoritative over Settings, like the legacy path. */
  overrides?: { provider?: string; model?: string; effort?: string };
  /** True when the site has stored Settings credentials — authors are told auth is handled externally. */
  hasStoredCredentials?: boolean;
}

export interface AuthorAbstractPlanResult {
  plan: TestPlan | null;
  usage: UsageRecord[];
  errors: WorkflowError[];
}

// ---------------------------------------------------------------------------------------------
// Wire schema — OpenAI strict structured outputs reject `.optional()`, so the transport shape is
// required-but-nullable; nulls are stripped before parseTestPlanStrict, which stays the sole authority.
// ---------------------------------------------------------------------------------------------

const testPlanWireSchema = z.object({
  mission: z.string().nullable(),
  module: z.string().nullable(),
  title: z.string().nullable(),
  steps: z.array(z.object({
    action: z.enum(PLAN_ACTIONS).nullable(),
    assert: z.enum(PLAN_ASSERTS).nullable(),
    target: z.string(),
    value: z.string().nullable(),
  })),
});
type TestPlanWire = z.infer<typeof testPlanWireSchema>;

/** Drop explicit nulls so the wire shape reads as optional-omitted to the strict schema. */
function stripNullsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullsDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== null) out[k] = stripNullsDeep(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Provider routing + single model call (no retries here beyond the one owned repair call).
// ---------------------------------------------------------------------------------------------

interface ModelRoute {
  provider: ProviderName;
  model: string;
  effort: 'low' | 'medium' | 'high';
  apiKey: string;
  /** True only for OpenAI in API-key mode — account/CLI OpenAI still routes through buildProvider. */
  useResponsesApi: boolean;
}

/** Per-run overrides from the Agent Console topbar — authoritative over Settings, same as the legacy path. */
export interface ModelOverrides {
  provider?: string;
  model?: string;
  effort?: string;
}

function isProviderNameStr(v: unknown): v is ProviderName {
  return v === 'gemini' || v === 'openai' || v === 'anthropic';
}

/** Same Settings-backed resolution chain getOrchestrator uses, so per-agent overrides keep working. */
function resolveRoute(agentName: string, overrides?: ModelOverrides): ModelRoute {
  const agent = canonicalAgent(agentName);
  const provider = isProviderNameStr(overrides?.provider) && getProviderCredentials(overrides.provider as ProviderName)
    ? (overrides!.provider as ProviderName)
    : resolveProviderForAgent(agent);
  // Topbar model accepted verbatim (the UI only offers models valid for the selected provider).
  const model = (overrides?.model || '').trim() || resolveModelForAgent(agent, provider);
  const effort = resolveEffortForAgent(agent, provider, overrides?.effort);
  const creds = getProviderCredentials(provider);
  const apiKey = creds?.authMode === 'api_key' ? creds.apiKey : '';
  return { provider, model, effort, apiKey, useResponsesApi: provider === 'openai' && Boolean(apiKey) };
}

interface ModelAttempt {
  /** Transport-parsed object (wire-shaped) — strict validation happens in the caller's validate step. */
  raw: unknown;
  refusal: string | null;
  /** Transport-level parse detail, quoted into the single repair prompt. */
  invalidDetail: string | null;
  /** Non-schema failure (network/auth/config) — terminal for this node; the graph owns transient retries. */
  transportError: WorkflowError | null;
  usage: UsageRecord;
}

function toTransportError(error: unknown, node: string): WorkflowError {
  const message = error instanceof Error ? error.message : String(error ?? 'Model call failed.');
  return new WorkflowRuntimeError(classifyError(error), message, undefined, node).toWorkflowError();
}

/** A throw with no HTTP status whose message reads schema/parse-flavored is repairable, not transport. */
function schemaInvalidDetailFromThrow(error: unknown): string | null {
  const status = (error as any)?.status ?? (error as any)?.statusCode;
  // Only a real HTTP FAILURE status (>=400) is transport. Providers stamp a bad-JSON/schema throw with
  // status 200 ("call succeeded, output was malformed") — that IS repairable, so it must not bail here.
  if (typeof status === 'number' && status >= 400) return null;
  const message = error instanceof Error ? error.message : String(error ?? '');
  // Match the actual JSON.parse / schema-validation error shapes, incl. "is not valid JSON" and "Unexpected token".
  return /no object generated|did not match|could not parse|(in)?valid json|not valid json|unexpected token|unexpected (end|non-whitespace)|json\.parse|unterminated string|bad control character|schema|type validation/i.test(message)
    ? message : null;
}

/** The Responses client folds SDK throws into rawContent — keep transport failures out of the repair loop. */
function transportDetailFromRawContent(rawContent: string): WorkflowError | null {
  if (/\b429\b|rate limit|timeout|timed out|econn|enotfound|eai_again|socket|fetch failed|network|connection/i.test(rawContent)) {
    return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.NETWORK_TRANSIENT, rawContent.slice(0, 500)).toWorkflowError();
  }
  if (/\b401\b|\b403\b|api key|unauthorized|authentication/i.test(rawContent)) {
    return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.AUTH_FAILURE, rawContent.slice(0, 500)).toWorkflowError();
  }
  return null;
}

interface ModelCallSpec<TWire> {
  node: string;
  route: ModelRoute;
  schema: z.ZodType<TWire>;
  schemaName: string;
  system: string;
  prompt: string;
  signal?: AbortSignal;
}

/** Exactly ONE model round-trip; provider branching lives here and nowhere else. */
async function callModelOnce<TWire>(spec: ModelCallSpec<TWire>): Promise<ModelAttempt> {
  const started = Date.now();
  const base = { node: spec.node, timestamp: new Date().toISOString() };
  const failedUsage = (): UsageRecord => ({ ...base, modelName: spec.route.model, latencyMs: Date.now() - started });

  if (spec.route.useResponsesApi) {
    try {
      const r = await callOpenAIResponsesStructured<TWire>({
        apiKey: spec.route.apiKey, model: spec.route.model, schema: spec.schema, schemaName: spec.schemaName,
        system: spec.system, prompt: spec.prompt, effort: spec.route.effort, signal: spec.signal,
      });
      const usage: UsageRecord = {
        ...base, modelName: r.model,
        inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, latencyMs: r.latencyMs,
      };
      if (r.refusal !== null) return { raw: null, refusal: r.refusal, invalidDetail: null, transportError: null, usage };
      if (!r.schemaValid || r.object === null) {
        const detail = r.rawContent || 'output did not parse against the schema';
        return { raw: null, refusal: null, invalidDetail: detail, transportError: transportDetailFromRawContent(detail), usage };
      }
      return { raw: r.object, refusal: null, invalidDetail: null, transportError: null, usage };
    } catch (error) {
      return { raw: null, refusal: null, invalidDetail: null, transportError: toTransportError(error, spec.node), usage: failedUsage() };
    }
  }

  try {
    const provider = buildProvider(spec.route.provider, spec.route.model);
    const r = await provider.generateObject<TWire>({
      system: spec.system, prompt: spec.prompt, schema: spec.schema, effort: spec.route.effort, signal: spec.signal,
    });
    const usage: UsageRecord = {
      ...base, modelName: r.model,
      inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens, latencyMs: r.latencyMs,
    };
    return { raw: r.object, refusal: null, invalidDetail: null, transportError: null, usage };
  } catch (error) {
    const detail = schemaInvalidDetailFromThrow(error);
    if (detail !== null) return { raw: null, refusal: null, invalidDetail: detail, transportError: null, usage: failedUsage() };
    return { raw: null, refusal: null, invalidDetail: null, transportError: toTransportError(error, spec.node), usage: failedUsage() };
  }
}

// ---------------------------------------------------------------------------------------------
// The one-repair loop (plan Section 10.5): first call → strict validate → ONE repair call → typed failure.
// ---------------------------------------------------------------------------------------------

function refusalError(node: string, refusal: string): WorkflowError {
  return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.MODEL_REFUSAL, refusal.slice(0, 500), undefined, node).toWorkflowError();
}

/** Repair prompt = original bounded input + quoted issues + bounded echo of the invalid attempt (fix-in-place, never drop). */
function buildRepairPrompt(originalPrompt: string, issues: string[], invalidAttempt: unknown): string {
  const echo = invalidAttempt == null ? '' : `\nYOUR INVALID ATTEMPT (fix it in place — do NOT drop steps or cases):\n${JSON.stringify(invalidAttempt).slice(0, 4000)}\n`;
  return `${originalPrompt}\n\nYOUR PREVIOUS RESPONSE FAILED VALIDATION. Fix EVERY issue below and return the corrected JSON only:\n${issues.map((i) => `- ${i}`).join('\n')}${echo}`;
}

export interface StrictGenerationSpec<TWire, TOut> {
  node: string;
  agent: string;
  schema: z.ZodType<TWire>;
  schemaName: string;
  system: string;
  prompt: string;
  /** Strict authority over the transport-shaped output — returns the value or quotable issues, never coerces. */
  validate: (wire: unknown) => { value: TOut | null; issues: string[] };
  signal?: AbortSignal;
  overrides?: ModelOverrides;
}

/** Exported for sibling nodes (investigation/analyst) — the ONE sanctioned strict-generation seam. */
export async function generateStrictObject<TWire, TOut>(spec: StrictGenerationSpec<TWire, TOut>): Promise<{ value: TOut | null; usage: UsageRecord[]; errors: WorkflowError[] }> {
  const usage: UsageRecord[] = [];
  let route: ModelRoute;
  try {
    route = resolveRoute(spec.agent, spec.overrides);
  } catch (error) {
    return { value: null, usage, errors: [toTransportError(error, spec.node)] };
  }

  const evaluate = (attempt: ModelAttempt): { value: TOut | null; issues: string[] } =>
    attempt.raw == null
      ? { value: null, issues: [attempt.invalidDetail || 'model returned no parseable output'] }
      : spec.validate(attempt.raw);

  const first = await callModelOnce<TWire>({ node: spec.node, route, schema: spec.schema, schemaName: spec.schemaName, system: spec.system, prompt: spec.prompt, signal: spec.signal });
  usage.push(first.usage);
  if (first.transportError) return { value: null, usage, errors: [first.transportError] };
  if (first.refusal !== null) return { value: null, usage, errors: [refusalError(spec.node, first.refusal)] };
  const firstEval = evaluate(first);
  if (firstEval.value !== null) return { value: firstEval.value, usage, errors: [] };

  // Exactly ONE repair call — schema-invalid only; refusals and transport failures never reach here twice.
  const second = await callModelOnce<TWire>({ node: spec.node, route, schema: spec.schema, schemaName: spec.schemaName, system: spec.system, prompt: buildRepairPrompt(spec.prompt, firstEval.issues, first.raw), signal: spec.signal });
  usage.push(second.usage);
  if (second.transportError) return { value: null, usage, errors: [second.transportError] };
  if (second.refusal !== null) return { value: null, usage, errors: [refusalError(spec.node, second.refusal)] };
  const secondEval = evaluate(second);
  if (secondEval.value !== null) return { value: secondEval.value, usage, errors: [] };

  const err = new WorkflowRuntimeError(
    WORKFLOW_ERROR_CLASSES.SCHEMA_INVALID_OUTPUT,
    `Model output failed strict validation after the single repair call: ${secondEval.issues.slice(0, 5).join('; ')}`,
    { firstAttemptIssues: firstEval.issues, repairAttemptIssues: secondEval.issues, provider: route.provider, model: route.model },
    spec.node,
  );
  return { value: null, usage, errors: [err.toWorkflowError()] };
}

// ---------------------------------------------------------------------------------------------
// Prompt assembly — app-agnostic; all app facts arrive via mission/catalog inputs, never hardcoded.
// ---------------------------------------------------------------------------------------------

// House-style parity: the graph engine reuses the legacy caseWriter persona verbatim (title/step/tag/priority
// conventions, "every step has its own expected result", 3-8 steps) so graph and legacy cases read identically
// in review; the addendum layers the graph's stricter evidence rule on top.
const CASE_AUTHORING_SYSTEM = `${systemPromptFor('caseWriter')}

Additional non-negotiable constraints for this run:
- Every referenced control, label, or navigation target MUST come from the provided verified evidence — never invent labels, selectors, or URLs.
- Return ONLY JSON matching the schema.`;

const PLAN_AUTHORING_SYSTEM = 'You author ABSTRACT test plans — semantic QA intent only, never code. Reference ONLY target names from the provided catalog verbatim; emit no selectors, URLs, roles, aria, css, xpath, waits, login, or navigation. Return only JSON matching the schema.';

/** MissionRef is advisory scope for authoring — deliberately URL-free so the model can never author navigation. */
function renderMissionRefForPrompt(mission: MissionRef | null): string {
  if (!mission) return 'MISSION SCOPE: (not resolved — scope strictly to the goal text and catalog evidence).';
  const parts = [`platform=${mission.platform}`, `type=${mission.platformType}`];
  if (mission.runtimeSurface) parts.push(`surface=${mission.runtimeSurface}`);
  if (mission.moduleId) parts.push(`module=${mission.moduleId}`);
  if (mission.tabId) parts.push(`tab=${mission.tabId}`);
  return `MISSION SCOPE (advisory context — never author navigation/URLs from it): ${parts.join(', ')}; scope=${mission.executionScope}`;
}

// Auth handling is a fact the authors must know, never a secret they may hold: session injection is
// the execution layer's job, so scripts/cases stay credential-free by construction.
function authNote(hasStoredCredentials?: boolean): string {
  return hasStoredCredentials
    ? '\nAUTHENTICATION: this website has stored login credentials in Settings; every run starts from an already-authenticated session injected by the execution layer. Do NOT write login/logout steps, usernames, or passwords anywhere.'
    : '';
}

function buildCasesPrompt(input: AuthorTestCasesInput, catalog: string): string {
  const countLine = input.requestedCaseCount > 0
    ? `Generate exactly ${input.requestedCaseCount} test case(s).`
    : 'Choose the case count the evidenced behavior genuinely supports — quality over quantity, never pad. A catalog exposing a form, list, or multiple controls almost never supports only one case: author a distinct case per evidenced behavior (happy path, each validation rule, negative paths, observed disabled/empty/permission states) rather than one broad check.';
  const avoid = input.avoidCaseTitles?.length
    ? `\nGAP MODE: the user ALREADY has these test cases — do NOT re-author them or trivial rewordings; author only genuinely NEW behaviors not covered below:\n${input.avoidCaseTitles.slice(0, 40).map((t) => `- ${t}`).join('\n')}`
    : '';
  // The chat's code-grounded analysis — the writer's SOURCE OF BEHAVIORS. Bounded so the prompt stays sane;
  // the catalog stays the locator authority (every step still names a real catalog control).
  const understanding = String(input.understanding || '').trim();
  const understandingBlock = understanding
    ? `\nVERIFIED FEATURE ANALYSIS (code-grounded — author cases that COVER these real behaviors, rules, derivations, validations, and edges; each step must still target a control from the catalog below):\n${understanding.slice(0, 6000)}\n`
    : '';
  return `Author test cases for this goal.
GOAL: ${input.goal}
${countLine}
${renderMissionRefForPrompt(input.mission)}${authNote(input.hasStoredCredentials)}${understandingBlock}${avoid}
${catalog}
CASE RULES:
- Each case: short plain-English title naming ONE behavior; one-sentence description; a concrete, NON-EMPTY precondition.
- PRECONDITIONS ARE REQUIRED: state in one plain sentence the exact state that must already be true before the steps run — the signed-in role/permissions, which app/surface is open, and any records/metadata that must already exist (e.g. "Signed in as an Admin with the Sales app open and at least one account present"). This is where setup/login belongs, so keep it out of the title, description, and steps; never leave it empty.
- STEPS: each step is one specific user action naming a real on-screen control from the catalog evidence, paired with its own observable expected result. No vague steps, no invented labels, no login/authentication steps.
- When a VERIFIED FEATURE ANALYSIS is provided, author a case for EACH distinct behavior/rule/edge in it that the live catalog can exercise (derivations, per-field validation, state changes, disabled/empty states) — do not collapse it to a few generic open/cancel cases.
- A happy-path create/submit case MUST include a fill step for EVERY catalog field marked (required) before the save/create step; a partially filled form fails to submit.
- Cover the highest-value behaviors the evidence supports first (happy path, negative/validation, disabled/empty/permission states).
- OBJECT/RECORD GOALS: when the goal targets a business object/record and the catalog exposes its form or list, cover each applicable dimension with a focused case — create/read/update/delete lifecycle, per-required-field validation, negative/boundary input, observed permission/read-only states, and lookup/relationship fields — never one generic "validate object" case; skip a dimension only when the catalog proves it is not exercisable.
- tags use @ format (e.g. @regression, @ui, @positive, @negative); set priority and type per case.`;
}

function buildPlanPrompt(input: AuthorAbstractPlanInput, catalog: string): string {
  const steps = Array.isArray(input.testCase.steps) ? input.testCase.steps : [];
  const stepLines = steps.map((s) => `- ${s?.action || ''} => ${s?.expected || ''}`).join('\n') || '- (no source steps provided)';
  return `Author ONE abstract test plan as JSON for the reviewed test case below — NOT Playwright code.
${renderMissionRefForPrompt(input.mission)}${authNote(input.hasStoredCredentials)}
${catalog}
REVIEWED TEST CASE:
Title: ${input.testCase.title || ''}
Description: ${input.testCase.description || ''}
Steps:
${stepLines}
PLAN RULES:
- steps: [{action|assert, target, value?}] — exactly ONE verb per step (set the unused verb to null).
- Actions: ${PLAN_ACTIONS.join(', ')}. Asserts: ${PLAN_ASSERTS.join(', ')}.
- Every locator-bearing target (CLICK/FILL/asserts) MUST be a catalog name verbatim. OPEN_MODULE is mission-scoped navigation intent — its target is advisory and needs no catalog match.
- Context asserts (URL_MATCHES, HAS_STATUS, EMPTY_STATE, ERROR_STATE, ROW_IN_LIST, FOUND_IN_GLOBAL_SEARCH) are page-scoped: their target/value is the EXPECTED TEXT (a URL fragment, a status/error message, or row text), never a catalog name. Use ROW_IN_LIST after creating a record to confirm it appears in its list, and FOUND_IN_GLOBAL_SEARCH to cross-check it via global search.
- Translate EVERY source step into plan steps — never drop or merge away behavior.
- CREATE/SUBMIT flows: before any save/create/submit CLICK, emit a FILL (or SELECT) for EVERY catalog field marked (required). A form submitted with an empty required field is rejected — this is the #1 cause of failed creates.
- Set unused optional fields (mission/module/title/value) to null.`;
}

// ---------------------------------------------------------------------------------------------
// Strict validators — the authority the wire output must pass; issues are quotable by the repair call.
// ---------------------------------------------------------------------------------------------

function validateCases(wire: unknown): { value: AuthoredTestCase[] | null; issues: string[] } {
  const parsed = testCasesSchema.safeParse(wire);
  if (!parsed.success) {
    return { value: null, issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'test_cases'}: ${i.message}`) };
  }
  if (parsed.data.test_cases.length === 0) return { value: null, issues: ['test_cases is empty — author at least one case'] };
  return { value: parsed.data.test_cases, issues: [] };
}

function validatePlan(wire: unknown): { value: TestPlan | null; issues: string[] } {
  const { plan, issues } = parseTestPlanStrict(stripNullsDeep(wire));
  return { value: plan, issues };
}

// ---------------------------------------------------------------------------------------------
// Node entry points.
// ---------------------------------------------------------------------------------------------

/** LangGraph node: strict structured case authoring (plan node `generate_cases`); never throws. */
export async function authorTestCases(input: AuthorTestCasesInput): Promise<AuthorTestCasesResult> {
  try {
    const catalog = renderTargetCatalogForPrompt(input.evidenceGraph);
    const r = await generateStrictObject<CasesWire, AuthoredTestCase[]>({
      node: 'generate_cases',
      // 'caseWriter' is the legacy Settings identity for case authoring — per-agent overrides keep working.
      agent: input.agent || 'caseWriter',
      schema: testCasesSchema,
      schemaName: 'test_cases',
      system: input.system || CASE_AUTHORING_SYSTEM,
      prompt: buildCasesPrompt(input, catalog),
      validate: validateCases,
      signal: input.signal,
      overrides: input.overrides,
    });
    return { cases: r.value ?? [], usage: r.usage, errors: r.errors };
  } catch (error) {
    // Belt-and-braces: the node contract is return-never-throw, so an escape here is a bug by definition.
    const err = new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION, error instanceof Error ? error.message : 'Case authoring failed.', undefined, 'generate_cases');
    return { cases: [], usage: [], errors: [err.toWorkflowError()] };
  }
}

/** LangGraph node: ONE strict abstract plan for ONE case (plan node `generate_abstract_plans`); never throws. */
export async function authorAbstractPlan(input: AuthorAbstractPlanInput): Promise<AuthorAbstractPlanResult> {
  try {
    const catalog = renderTargetCatalogForPrompt(input.evidenceGraph);
    const r = await generateStrictObject<TestPlanWire, TestPlan>({
      node: 'generate_abstract_plans',
      // 'playwrightCoder' authored plans on the legacy AIQA_COMPILER path — same Settings identity here.
      agent: input.agent || 'playwrightCoder',
      schema: testPlanWireSchema,
      schemaName: 'test_plan',
      system: input.system || PLAN_AUTHORING_SYSTEM,
      prompt: buildPlanPrompt(input, catalog),
      validate: validatePlan,
      signal: input.signal,
      overrides: input.overrides,
    });
    return { plan: r.value, usage: r.usage, errors: r.errors };
  } catch (error) {
    const err = new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION, error instanceof Error ? error.message : 'Plan authoring failed.', undefined, 'generate_abstract_plans');
    return { plan: null, usage: [], errors: [err.toWorkflowError()] };
  }
}
