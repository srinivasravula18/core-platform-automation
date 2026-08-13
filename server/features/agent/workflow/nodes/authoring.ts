/**
 * Authoring node — strict case + abstract-plan authoring (LangGraph migration, Phase 4).
 *
 * Every model turn runs on the single Codex runtime through buildProvider().generateObject, which uses
 * Codex's native structured output (constrained decoding). Model/effort still resolve through the SAME
 * Settings-backed routing the rest of the app uses (resolveModelForAgent/resolveEffortForAgent), so
 * per-agent overrides keep working. Strict schema validation remains the single authority and a
 * step/case is NEVER silently dropped.
 *
 * This node OWNS the one-repair loop from plan Section 10.5: exactly ONE second model call quoting the
 * validation issues, then a typed SCHEMA_INVALID_OUTPUT failure. Refusals get NO retry (MODEL_REFUSAL).
 * Transient transport failures are returned classified — the graph's node policy owns those retries.
 * Like its sibling nodes it never throws: every failure comes back as `errors: WorkflowError[]`.
 */
import { z } from 'zod';
import {
  resolveProviderForAgent, resolveModelForAgent, resolveEffortForAgent, buildProvider,
} from '../../../../ai/orchestrator';
import { canonicalAgent, systemPromptFor } from '../../../../ai/systemPrompts';
import type { ProviderName } from '../../../../ai/providers/types';
import { testCasesSchema } from '../../../../shared/schemas';
import { PLAN_ACTIONS, PLAN_ASSERTS, CONTEXT_ASSERTS, parseTestPlanStrict, type TestPlan } from '../../compiler/testPlan';
import { renderTargetCatalogForPrompt } from '../../compiler/renderCatalogForPrompt';
import { resolveTarget } from '../../graph/groundingEngine';
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
  /** Backend object/field metadata block (renderMetadataForPrompt) — authoritative required/readonly truth (RC-0).
   * The catalog stays the locator authority; this only sharpens which fields are required/read-only. */
  metadataHint?: string;
  /** Observe-then-assert: the OBSERVED FORM BEHAVIOR block — authors validation cases from measurement, not guesses. */
  behaviorHint?: string;
  /** Settings identity for model/effort routing; defaults to the legacy case-authoring agent. */
  agent?: string;
  system?: string;
  signal?: AbortSignal;
  /** Topbar per-run model/effort — authoritative over Settings, like the legacy path. */
  overrides?: { model?: string; effort?: string };
  /** True when the site has stored Settings credentials — authors are told auth is handled externally. */
  hasStoredCredentials?: boolean;
  /** Coverage "gaps": existing case titles to NOT duplicate — author only genuinely new behaviors. */
  avoidCaseTitles?: string[];
  /** P4 critic feedback — when the CriticAgent refutes a draft, its objections are folded into a single
   * revision pass so the author addresses them (the author↔critic negotiation). Empty on the first pass. */
  critique?: string;
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
  /** Authoritative backend field truth (required/readonly/type) — the plan stage was previously starved of
   * this, so it mis-picked assertions. Same block the case author gets (renderMetadataForPrompt). */
  metadataHint?: string;
  /** Observe-then-assert: OBSERVED FORM BEHAVIOR block — grounds the plan's validation asserts on measurement. */
  behaviorHint?: string;
  /** The chat's code-grounded analysis of the feature — grounds the EXPECTED side of assertions on real
   * behavior instead of invented headings/data. */
  understanding?: string;
  /** Defaults to the legacy plan-authoring agent so existing Settings overrides keep applying. */
  agent?: string;
  system?: string;
  signal?: AbortSignal;
  /** Topbar per-run model/effort — authoritative over Settings, like the legacy path. */
  overrides?: { model?: string; effort?: string };
  /** True when the site has stored Settings credentials — authors are told auth is handled externally. */
  hasStoredCredentials?: boolean;
}

export interface AuthorAbstractPlanResult {
  plan: TestPlan | null;
  usage: UsageRecord[];
  errors: WorkflowError[];
}

// ---------------------------------------------------------------------------------------------
// Wire schema — strict structured output rejects `.optional()`, so the transport shape is
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
    sourceStep: z.number().int().positive().nullable(),
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
}

/** Per-run overrides from the Agent Console topbar — authoritative over Settings, same as the legacy path. */
export interface ModelOverrides {
  model?: string;
  effort?: string;
}

/** Same Settings-backed resolution chain getOrchestrator uses, so per-agent overrides keep working. */
function resolveRoute(agentName: string, overrides?: ModelOverrides): ModelRoute {
  const agent = canonicalAgent(agentName);
  const provider = resolveProviderForAgent(agent);
  // Topbar model accepted verbatim (the UI only offers models the runtime serves).
  const model = (overrides?.model || '').trim() || resolveModelForAgent(agent, provider);
  return { provider, model, effort: resolveEffortForAgent(agent, provider, overrides?.effort) };
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

interface ModelCallSpec<TWire> {
  node: string;
  route: ModelRoute;
  schema: z.ZodType<TWire>;
  system: string;
  prompt: string;
  signal?: AbortSignal;
}

/** Exactly ONE model round-trip through the Codex runtime's native structured output. */
async function callModelOnce<TWire>(spec: ModelCallSpec<TWire>): Promise<ModelAttempt> {
  const started = Date.now();
  const base = { node: spec.node, timestamp: new Date().toISOString() };
  const failedUsage = (): UsageRecord => ({ ...base, modelName: spec.route.model, latencyMs: Date.now() - started });

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

  const first = await callModelOnce<TWire>({ node: spec.node, route, schema: spec.schema, system: spec.system, prompt: spec.prompt, signal: spec.signal });
  usage.push(first.usage);
  if (first.transportError) return { value: null, usage, errors: [first.transportError] };
  if (first.refusal !== null) return { value: null, usage, errors: [refusalError(spec.node, first.refusal)] };
  const firstEval = evaluate(first);
  if (firstEval.value !== null) return { value: firstEval.value, usage, errors: [] };

  // Exactly ONE repair call — schema-invalid only; refusals and transport failures never reach here twice.
  const second = await callModelOnce<TWire>({ node: spec.node, route, schema: spec.schema, system: spec.system, prompt: buildRepairPrompt(spec.prompt, firstEval.issues, first.raw), signal: spec.signal });
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
    : 'Generate at least 5 distinct test cases, and more when the evidenced behavior supports them. Cover a distinct evidenced behavior per case (happy path, each validation rule, negative paths, observed disabled/empty/permission states); never pad with duplicates or invented behavior.';
  const avoid = input.avoidCaseTitles?.length
    ? `\nGAP MODE: the user ALREADY has these test cases — do NOT re-author them or trivial rewordings; author only genuinely NEW behaviors not covered below:\n${input.avoidCaseTitles.slice(0, 40).map((t) => `- ${t}`).join('\n')}`
    : '';
  // P4: the critic's objections to the previous draft — fix EVERY one in this revision.
  const critiqueBlock = String(input.critique || '').trim()
    ? `\nCRITIC REVIEW OF YOUR PREVIOUS DRAFT — you MUST resolve every objection in this revision:\n${String(input.critique).trim().slice(0, 3000)}\n`
    : '';
  // The chat's code-grounded analysis — the writer's SOURCE OF BEHAVIORS. Bounded so the prompt stays sane;
  // the catalog stays the locator authority (every step still names a real catalog control).
  const understanding = String(input.understanding || '').trim();
  const understandingBlock = understanding
    ? `\nVERIFIED FEATURE ANALYSIS (code-grounded — author cases that COVER these real behaviors, rules, derivations, validations, and edges; each step must still target a control from the catalog below):\n${understanding.slice(0, 6000)}\n`
    : '';
  // RC-0: backend object/field metadata — authoritative required/readonly truth, distinct from the DOM catalog.
  const metadataBlock = String(input.metadataHint || '').trim()
    ? `\n${String(input.metadataHint).trim().slice(0, 4000)}\n`
    : '';
  // Observe-then-assert: measured form behaviour — the strongest authority for validation cases.
  const behaviorBlock = String(input.behaviorHint || '').trim()
    ? `\n${String(input.behaviorHint).trim().slice(0, 2500)}\n`
    : '';
  return `Author test cases for this goal.
GOAL: ${input.goal}
${countLine}
${renderMissionRefForPrompt(input.mission)}${authNote(input.hasStoredCredentials)}${understandingBlock}${metadataBlock}${behaviorBlock}${avoid}${critiqueBlock}
${catalog}
CASE RULES:
- Each case: short plain-English title naming ONE behavior; one-sentence description; a concrete, NON-EMPTY precondition.
- PRECONDITIONS ARE REQUIRED: state in one plain sentence the exact state that must already be true before the steps run — the signed-in role/permissions, which app/surface is open, and any records/metadata that must already exist (e.g. "Signed in as an Admin with the Sales app open and at least one account present"). This is where setup/login belongs, so keep it out of the title, description, and steps; never leave it empty.
- STEPS: each step is one specific user action naming a real on-screen control from the catalog evidence, paired with its own observable expected result. No vague steps, no invented labels, no login/authentication steps.
- When a VERIFIED FEATURE ANALYSIS is provided, author a case for EACH distinct behavior/rule/edge in it that the live catalog can exercise (derivations, per-field validation, state changes, disabled/empty states) — do not collapse it to a few generic open/cancel cases.
- A happy-path create/submit case MUST include a fill step for EVERY catalog field marked (required) before the save/create step; a partially filled form fails to submit.
- Do not invent a value or interaction merely because a visible label contains a required marker. Only FILL/SELECT a role that accepts values, using a value or option proven by the catalog/analysis. Preserve observed defaults unless the requested behavior explicitly changes them.
- Cover the highest-value behaviors the evidence supports first (happy path, negative/validation, disabled/empty/permission states).
- OBJECT/RECORD GOALS: when the goal targets a business object/record and the catalog exposes its form or list, cover each applicable dimension with a focused case — create/read/update/delete lifecycle, per-required-field validation, negative/boundary input, observed permission/read-only states, and lookup/relationship fields — never one generic "validate object" case; skip a dimension only when the catalog proves it is not exercisable.
- tags use @ format (e.g. @regression, @ui, @positive, @negative); set priority and type per case.`;
}

function buildPlanPrompt(input: AuthorAbstractPlanInput, catalog: string): string {
  const steps = Array.isArray(input.testCase.steps) ? input.testCase.steps : [];
  const stepLines = steps.map((s) => `- ${s?.action || ''} => ${s?.expected || ''}`).join('\n') || '- (no source steps provided)';
  const understanding = String(input.understanding || '').trim();
  const understandingBlock = understanding ? `\nVERIFIED FEATURE ANALYSIS (ground the EXPECTED side of asserts on these real behaviors — do not invent headings/messages/data):\n${understanding.slice(0, 3000)}\n` : '';
  const metadataBlock = String(input.metadataHint || '').trim() ? `\n${String(input.metadataHint).trim().slice(0, 3000)}\n` : '';
  const behaviorBlock = String(input.behaviorHint || '').trim() ? `\n${String(input.behaviorHint).trim().slice(0, 2500)}\n` : '';
  return `Author ONE abstract test plan as JSON for the reviewed test case below — NOT Playwright code.
${renderMissionRefForPrompt(input.mission)}${authNote(input.hasStoredCredentials)}${understandingBlock}${metadataBlock}${behaviorBlock}
${catalog}
REVIEWED TEST CASE:
Title: ${input.testCase.title || ''}
Description: ${input.testCase.description || ''}
Steps:
${stepLines}
PLAN RULES:
- Every plan operation must set sourceStep to the 1-based reviewed-case step it implements. Keep operations for each sourceStep together and map every reviewed step exactly; low-level operations may share one sourceStep.
- steps: [{action|assert, target, value?}] — exactly ONE verb per step (set the unused verb to null).
- Actions: ${PLAN_ACTIONS.join(', ')}. Asserts: ${PLAN_ASSERTS.join(', ')}.
- Every locator-bearing target (CLICK/FILL/asserts) MUST be a catalog name verbatim. OPEN_MODULE is mission-scoped navigation intent — its target is advisory and needs no catalog match.
- OPEN_MODULE may appear at most once, only for initial navigation. Never use it as a placeholder for a reviewed action or assertion.
- MATCH THE ASSERT TO THE TARGET'S [role] (shown in the catalog): HAS_VALUE ONLY on an editable text field ([textbox]/[searchbox]/[spinbutton]/[combobox]); use CHECKED/UNCHECKED for a [checkbox]/[radio]/[switch] (never HAS_VALUE — a toggle has no text value); use VISIBLE/NOT_VISIBLE for a [heading]/[columnheader]/static control; ENABLED/DISABLED for interactive controls. An assert whose type does not fit the target's role will be dropped.
- Never assert a specific heading, message, or ROW DATA that is not proven by the catalog or the verified analysis — do not invent an expected label/record (e.g. a specific row value) the evidence does not establish. To confirm a record you CREATED in this test, use ROW_IN_LIST with the value the test entered, not a pre-existing row.
- Context asserts (URL_MATCHES, HAS_STATUS, EMPTY_STATE, ERROR_STATE, ROW_IN_LIST, FOUND_IN_GLOBAL_SEARCH) are page-scoped: their target/value is the EXPECTED TEXT (a URL fragment, a status/error message, or row text), never a catalog name. Use ROW_IN_LIST after creating a record to confirm it appears in its list, and FOUND_IN_GLOBAL_SEARCH to cross-check it via global search.
- To VERIFY a record you created, assert it with ROW_IN_LIST (value = the name you entered) — do NOT author a manual FILL into a search box and then look: the search control is unreachable if the form is still open, and a page-scoped ROW_IN_LIST is robust. Only add a search FILL when SEARCH/FILTER behavior is itself the thing under test.
- Translate EVERY source step into plan steps — never drop or merge away behavior.
- CREATE/SUBMIT flows: before any save/create/submit CLICK, emit a FILL (or SELECT) for EVERY catalog field marked (required). A form submitted with an empty required field is rejected — this is the #1 cause of failed creates.
- TRANSFORMED FIELDS: when a step fills a field and a later step checks that field (or a field derived from it) and the case is about a normalization/derivation, the HAS_VALUE value MUST be the app's transformed OUTPUT, never the value that was filled. When the exact transformed output is not known from the catalog/analysis, do NOT emit HAS_VALUE with the typed input — emit VERIFY_VALIDATION describing the expected property (e.g. the value is lowercased / trimmed / spaces replaced) instead.
- NEVER emit HAS_VALUE with an empty value to mean "auto-populated"/"non-empty"/"derived" — an empty HAS_VALUE asserts the field is BLANK and fails a correctly auto-filled field; use VERIFY_VALIDATION for the expected property instead. NOT_VISIBLE belongs on headings/static controls that truly disappear, NEVER on an input/combobox you filled or that stays on-screen.
- UNIQUENESS PLACEHOLDERS: express run-uniqueness only as a {{unique}} token inside a value (e.g. "Version App {{unique}}"); never author bracket placeholders like [unique] — they are typed and asserted literally.
- Never turn a value-bearing action into a bare CLICK. Only SELECT a [combobox]/[listbox] with a catalog-proven option; do not invent generic values such as "available option" for a [button]. Preserve observed defaults unless this case explicitly tests changing them.
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

export function caseCountIssues(cases: unknown[], requestedCaseCount: number): string[] {
  if (requestedCaseCount > 0 && cases.length !== requestedCaseCount) {
    return [`Expected exactly ${requestedCaseCount} test case(s), but received ${cases.length}.`];
  }
  if (requestedCaseCount === 0 && cases.length < 5) {
    return [`Auto mode requires at least 5 distinct grounded test cases, but received ${cases.length}.`];
  }
  return [];
}

function validatePlan(wire: unknown): { value: TestPlan | null; issues: string[] } {
  const { plan, issues } = parseTestPlanStrict(stripNullsDeep(wire));
  return { value: plan, issues };
}

/** P6: every locator-bearing target must match a verified catalog entry. Uses the
 * compiler's own resolveTarget so it can never false-reject a target the compiler WOULD resolve — it flags
 * ONLY targets with no catalog candidate at all (an invented/mis-phrased name), which is exactly the
 * naming-variance the repair call can fix. OPEN_MODULE + context asserts carry advisory text targets, skipped. */
export function catalogTargetIssues(plan: TestPlan, graph: EvidenceGraph | null): string[] {
  if (!graph) return [];
  const issues: string[] = [];
  plan.steps.forEach((step, i) => {
    if ('action' in step && step.action === 'OPEN_MODULE') return;
    if ('assert' in step && CONTEXT_ASSERTS.has(step.assert)) return;
    const target = String((step as { target?: string }).target || '').trim();
    if (!target) return;
    const r = resolveTarget(target, graph);
    // node === null with UNRESOLVED means candidates() found nothing — a target name absent from the catalog.
    // (An ambiguous/untrusted match keeps node !== null; that is a grounding issue, not a naming one — never flag it.)
    if (r.status === 'UNRESOLVED_SELECTOR' && r.node === null) {
      issues.push(`Step ${i + 1} targets "${target}", which is not a verified catalog control — use an EXACT target name from the catalog above, or remove the step.`);
    }
  });
  return issues;
}

/** Navigation is setup, not a substitute for the reviewed case's actual interactions/assertions. */
export function planSemanticIssues(plan: TestPlan): string[] {
  const navigationSteps = plan.steps.filter((step) => 'action' in step && step.action === 'OPEN_MODULE').length;
  return navigationSteps > 1
    ? [`OPEN_MODULE may appear at most once, but the plan contains ${navigationSteps}; replace placeholder navigation steps with the reviewed actions/assertions they implement.`]
    : [];
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
      system: input.system || CASE_AUTHORING_SYSTEM,
      prompt: buildCasesPrompt(input, catalog),
      validate: (wire) => {
        const validated = validateCases(wire);
        if (!validated.value) return validated;
        const issues = caseCountIssues(validated.value, input.requestedCaseCount);
        return issues.length ? { value: null, issues } : validated;
      },
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
      system: input.system || PLAN_AUTHORING_SYSTEM,
      prompt: buildPlanPrompt(input, catalog),
      validate: (wire) => {
        let { value, issues } = validatePlan(wire);
        const sourceCount = input.testCase.steps?.length ?? 0;
        if (value && sourceCount) {
          const invalid = value.steps
            .map((step, index) => ({ step, index }))
            .filter(({ step }) => !step.sourceStep || step.sourceStep > sourceCount)
            .map(({ index }) => `Plan step ${index + 1} must set sourceStep to a reviewed-case step from 1 through ${sourceCount}.`);
          const mapped = new Set(value.steps.map((step) => step.sourceStep).filter((step): step is number => !!step));
          const missing = Array.from({ length: sourceCount }, (_, index) => index + 1).filter((step) => !mapped.has(step));
          const sourceOrder = value.steps.map((step) => step.sourceStep || 0);
          const outOfOrder = sourceOrder.some((step, index) => index > 0 && step < sourceOrder[index - 1]);
          if (invalid.length || missing.length || outOfOrder) {
            return { value: null, issues: [
              ...invalid,
              ...(missing.length ? [`No plan operation maps reviewed-case step(s): ${missing.join(', ')}.`] : []),
              ...(outOfOrder ? ['Plan operations must stay in sourceStep order so each reviewed case step compiles into one trace group.'] : []),
            ] };
          }
          value = {
            ...value,
            sourceStepCount: sourceCount,
            mappedSourceSteps: [...mapped].map((step) => step - 1),
            steps: value.steps.map((step) => ({ ...step, id: `case:${step.sourceStep! - 1}` })),
          };
        }
        // P6: reject an otherwise-valid plan whose targets are not in the catalog, so the ONE repair call
        // re-authors them with exact catalog names before the all-or-nothing compiler drops the case.
        if (value) {
          const semanticIssues = planSemanticIssues(value);
          if (semanticIssues.length) return { value: null, issues: semanticIssues };
        }
        if (value) {
          const targetIssues = catalogTargetIssues(value, input.evidenceGraph);
          if (targetIssues.length) return { value: null, issues: targetIssues };
        }
        return { value, issues };
      },
      signal: input.signal,
      overrides: input.overrides,
    });
    return { plan: r.value, usage: r.usage, errors: r.errors };
  } catch (error) {
    const err = new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION, error instanceof Error ? error.message : 'Plan authoring failed.', undefined, 'generate_abstract_plans');
    return { plan: null, usage: [], errors: [err.toWorkflowError()] };
  }
}
