/**
 * PlaywrightCompiler (Phase 4) — the FIRST backend implementing the `Compiler` interface. It turns an
 * abstract Test Plan + verified evidence into a deterministic Playwright spec. It NEVER invents selectors,
 * URLs, appIds, labels, roles, waits, login, or navigation: every locator comes from the Grounding Engine
 * (verified evidence), and navigation/login/verification are delegated to the emitted MissionRunner. Any
 * target that cannot be uniquely grounded becomes an explicit diagnostic (AMBIGUOUS/UNRESOLVED), not a guess.
 */
import type { Compiler, CompileInput, CompileResult, Diagnostic } from './Compiler';
import { resolveTarget } from '../graph/groundingEngine';
import { isActionStep, isAssertStep, CONTEXT_ASSERTS, stampStepIds, type ActionStep, type AssertStep, type PlanStep } from './testPlan';
import { TestDataEngine, type FieldSemantics } from '../testdata';
import { isRequiredFieldNode, type EvidenceNode } from '../graph/evidenceGraph';
import { isAssertionGroundingEnabled } from './assertionGroundingFlag';
import { isBehaviorOracleEnabled } from '../behaviorOracleFlag';

/** A submit-intent CLICK — the button that commits a create/edit. App-agnostic verbs; matched against the
 * grounded control's role+label so completing the form before it fires makes create/submit flows succeed. */
function isSubmitClick(step: PlanStep, node: EvidenceNode | null): boolean {
  if (!isActionStep(step) || step.action !== 'CLICK' || String(node?.role || '').toLowerCase() !== 'button') return false;
  // Include wizard-advance verbs (Next/Continue/Proceed): a multi-step create commits the current step and
  // triggers its validation, so it must count as the submit for required-completion + observe-then-assert.
  return /^(save|create|submit|add|confirm|finish|done|next|continue|proceed|save\s*&\s*new|create\s*&\s*new|save and new|create and new)\b/i.test(String(node?.label || '').trim());
}

/** A negative/validation case deliberately leaves fields empty (that emptiness IS the test) — never auto-complete it. */
function isNegativeCase(plan: { title?: string | null }): boolean {
  const t = String(plan?.title || '');
  // Positive create cases often say "with (all) required fields" — that fills them, it is NOT a validation test.
  if (/\bwith\s+(all\s+)?required\b/i.test(t)) return false;
  return /\b(empty|blank|without|missing|invalid|blocked|required\s+error|validation|negative|cannot|not\s+allowed|leave\s+\w+\s+empty|no\s+\w+\s+(provided|entered))\b/i.test(t)
    // Requirement-enforcement intent: "<field> is required", "is mandatory", "requires a …", "must be entered".
    || /\bis\s+(required|mandatory)\b|\brequires?\s+(a|an|the)\b|\bmust\s+(be\s+)?(provided|entered|filled|specified|set|selected)\b/i.test(t);
}

const VALIDATION_ASSERTS = new Set(['VERIFY_VALIDATION', 'VERIFY_ERROR']);
const FILL_ACTIONS = new Set(['FILL', 'SELECT', 'CHECK']);
const FIELD_TOUCH_ACTIONS = new Set(['FILL', 'SELECT', 'CHECK', 'UNCHECK', 'CLEAR']);
const FORM_CONTROL_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox', 'checkbox', 'radio', 'switch']);

/** Observe-then-assert hygiene: a validation assert can only be true AFTER a submit, on a field that is EMPTY at
 * submit. The plan author scatters expectValidation before the submit and on fields it just filled (both always
 * fail). Deterministically drop those — grounded in the plan's own fill/clear/submit structure. */
function invalidValidationSteps(plan: { steps: PlanStep[]; title?: string | null }, evidenceGraph: any, run: any): Set<number> {
  const drops = new Set<number>();
  // On a negative case the compiler turns HAS_VALUE into expectValidation (see below), so those obey the same
  // placement rules as VERIFY_VALIDATION — treat them as validation asserts here too.
  const negative = isNegativeCase(plan);
  const isValidationAssert = (s: PlanStep) => isAssertStep(s) && (VALIDATION_ASSERTS.has(s.assert) || (negative && s.assert === 'HAS_VALUE'));
  const resolved = plan.steps.map((s) => { const g = resolveTarget(String((s as any).target || ''), evidenceGraph, run); return g.status === 'RESOLVED' ? { sel: (g.selector as string ?? null), node: g.node } : { sel: null, node: null }; });
  const sel = resolved.map((r) => r.sel);
  // A rejected negative-case submit keeps the modal open, so NOT_VISIBLE on any live form control is wrong.
  // stateTag==='form' is not reliably set (portal timing/dedup/inline forms), so also detect the control from
  // the plan's own structure: an editable/toggle role, a required field, or a target the plan fills/clears.
  const touchedSelectors = new Set<string>();
  plan.steps.forEach((s, i) => { if (isActionStep(s) && FIELD_TOUCH_ACTIONS.has(s.action) && sel[i]) touchedSelectors.add(sel[i] as string); });
  const isOpenFormControl = (i: number): boolean => {
    const node = resolved[i].node;
    if (node?.stateTag === 'form') return true;
    if (FORM_CONTROL_ROLES.has(String(node?.role || '').toLowerCase())) return true;
    if (node && isRequiredFieldNode(node)) return true;
    return !!sel[i] && touchedSelectors.has(sel[i] as string);
  };
  if (negative) plan.steps.forEach((s, i) => {
    if (isAssertStep(s) && s.assert === 'NOT_VISIBLE' && isOpenFormControl(i)) drops.add(i);
  });
  let submitIdx = -1;
  plan.steps.forEach((s, i) => {
    if (submitIdx >= 0 || !isActionStep(s) || s.action !== 'CLICK') return;
    if (resolved[i].node && isSubmitClick(s, resolved[i].node)) submitIdx = i;
  });
  const filled = new Map<string, boolean>();
  plan.steps.forEach((s, i) => {
    if ((submitIdx >= 0 && i >= submitIdx) || !isActionStep(s) || !sel[i]) return;
    if (FILL_ACTIONS.has(s.action)) filled.set(sel[i] as string, true);
    else if (s.action === 'CLEAR') filled.set(sel[i] as string, false);
  });
  // Only prune validation asserts when a submit exists (else the app may validate on blur — leave it to the
  // critic). Drop a validation assert placed BEFORE that submit, or targeting a field that is FILLED at submit.
  if (submitIdx < 0) return drops;
  plan.steps.forEach((s, i) => {
    if (!isValidationAssert(s)) return;
    if (i < submitIdx) { drops.add(i); return; }                         // asserted before the submit that triggers it
    if (sel[i] && filled.get(sel[i] as string) === true) drops.add(i);   // asserted on a field that is filled at submit
  });
  return drops;
}

/** A create/open TRIGGER — the toolbar control ("New"/"Add"/"+") that reveals a create dialog/drawer, as
 * opposed to the in-dialog submit ("Create"/"Save"). Same app-agnostic label-convention philosophy as
 * isRequiredFieldNode: never a hardcoded name. Used to auto-open the modal a plan's fields live inside. */
function isCreateOpenerNode(node: EvidenceNode | null): boolean {
  if (!node) return false;
  const role = String(node.role || '').toLowerCase();
  if (role !== 'button' && role !== 'link') return false;
  const label = String(node.label || '').trim();
  if (!label) return false;
  // In-dialog submit/dismiss controls are NOT openers — excluding them avoids mistaking Create/Save/Cancel for New.
  if (/^(save|create|submit|confirm|finish|done|ok|apply|cancel|close|discard|delete|remove)\b/i.test(label)) return false;
  return label === '+' || /(^|\s)(new|add)(\s|$)/i.test(label);
}

/** In-dialog dismiss control (Cancel/Close/Discard) — its presence in a plan implies a dialog must be open. */
function isDialogDismissNode(node: EvidenceNode | null): boolean {
  if (String(node?.role || '').toLowerCase() !== 'button') return false;
  return /^(cancel|close|discard|dismiss)\b/i.test(String(node?.label || '').trim());
}

/** Pick the single best create opener from the verified evidence: prefer an exact "New", then "New <noun>"/
 * "Add <noun>", then "+", then the shortest label — deterministic so the same run always injects the same click. */
function pickCreateOpener(nodes: EvidenceNode[]): EvidenceNode | null {
  const candidates = nodes.filter((n) => n.selector && n.uniqueness === true && n.confidence === 'verified-live'
    && n.provenance === 'LIVE_DOM' && isCreateOpenerNode(n));
  if (!candidates.length) return null;
  const rank = (n: EvidenceNode) => {
    const l = String(n.label || '').trim().toLowerCase();
    if (l === 'new') return 0;
    if (/^new\b/.test(l)) return 1;
    if (/^add\b/.test(l)) return 2;
    if (l === '+') return 3;
    return 4;
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b)
    || String(a.label || '').length - String(b.label || '').length)[0];
}

// Actions/assertions are emitted through MissionRunner's reveal-then-act helpers (not raw locator calls), so
// every interaction first reveals hover-gated controls (column filter/sort/wrap triggers, row menus, …).
// `value` is the already-resolved fill/select value (Test Data Engine output or the plan's explicit value).
function emitAction(step: ActionStep, spec: string, value: string): string {
  const v = JSON.stringify(value ?? '');
  switch (step.action) {
    // OPEN_MODULE is handled before grounding (mission-scoped navigation, no locator) — see compile().
    case 'CLICK': return `  await runner.click(${spec});`;
    case 'FILL': return `  await runner.fill(${spec}, ${v});`;
    case 'SELECT': return `  await runner.select(${spec}, ${v});`;
    case 'CHECK': return `  await runner.check(${spec});`;
    case 'UNCHECK': return `  await runner.uncheck(${spec});`;
    case 'HOVER': return `  await runner.hover(${spec});`;
    case 'PRESS': return `  await runner.press(${spec}, ${v});`;
    case 'CLEAR': return `  await runner.clear(${spec});`;
    default: return `  // INVALID_STEP action: ${String((step as any).action)}`;
  }
}

/** Assemble the Test Data Engine's input from the grounded evidence node (label/role/semanticName + fieldMeta). */
function fieldSemanticsFromNode(node: EvidenceNode | null): FieldSemantics {
  const fm = node?.fieldMeta ?? undefined;
  return {
    label: node?.label ?? null, role: node?.role ?? null, semanticName: node?.semanticName ?? null,
    name: fm?.name ?? null, id: fm?.id ?? null, placeholder: fm?.placeholder ?? null, ariaLabel: fm?.ariaLabel ?? null,
    autocomplete: fm?.autocomplete ?? null, type: fm?.type ?? null, options: fm?.options ?? null,
    maxLength: fm?.maxLength ?? null, minLength: fm?.minLength ?? null, pattern: fm?.pattern ?? null,
    min: fm?.min ?? null, max: fm?.max ?? null, required: fm?.required ?? null,
  };
}

/** Resolve the concrete value for a value-bearing action via the Test Data Engine (FILL/SELECT), else the plan value. */
function resolveStepValue(engine: TestDataEngine, step: ActionStep, node: EvidenceNode | null): string {
  if (step.action === 'FILL') return engine.fillValue(fieldSemanticsFromNode(node), step.value);
  if (step.action === 'SELECT') return engine.selectValue(fieldSemanticsFromNode(node), step.value);
  return String(step.value ?? '');
}

// `value` is the already-resolved expectation (threaded from the engine's fill/select output when the
// assertion cites a value the engine replaced — a plan-placeholder expectation would otherwise always fail).
function emitAssert(step: AssertStep, spec: string, value?: string): string {
  const v = JSON.stringify(value ?? step.value ?? '');
  switch (step.assert) {
    case 'VISIBLE':
    // Intents with no runner-side enrichment yet stay a deterministic (reveal-then-)visible assertion.
    case 'VERIFY_PAGINATION':
    case 'VERIFY_LOOKUP':
    case 'VERIFY_PERMISSION': return `  await runner.expectVisible(${spec});`;
    // Real VERIFY_* expansions (Phase 4): richer runner-owned checks over the SAME grounded target.
    case 'VERIFY_TABLE': return `  await runner.expectTable(${spec}, ${v});`;
    case 'VERIFY_FILTER': return `  await runner.expectFiltered(${spec}, ${v});`;
    case 'VERIFY_SORT': return `  await runner.expectSorted(${spec}, ${v});`;
    case 'VERIFY_VALIDATION': return `  await runner.expectValidation(${spec}, ${v});`;
    case 'VERIFY_ERROR': return `  await runner.expectErrorState(${v});`;
    case 'NOT_VISIBLE': return `  await runner.expectHidden(${spec});`;
    case 'ENABLED': return `  await runner.expectEnabled(${spec});`;
    case 'DISABLED': return `  await runner.expectDisabled(${spec});`;
    case 'HAS_TEXT': return `  await runner.expectText(${spec}, ${v});`;
    case 'NOT_HAS_TEXT': return `  await runner.expectNotText(${spec}, ${v});`;
    case 'HAS_VALUE': return `  await runner.expectValue(${spec}, ${v});`;
    case 'CHECKED': return `  await runner.expectChecked(${spec}, "true");`;
    case 'UNCHECKED': return `  await runner.expectChecked(${spec}, "false");`;
    case 'COUNT_GT': return `  await runner.expectCountGt(${spec}, Number(${v} || 0));`;
    default: return `  // INVALID_STEP assert: ${String((step as any).assert)}`;
  }
}

// Context asserts (Phase 4): mission/page-scoped observations — target is advisory text, never grounded.
// The runner owns the page-level lookups (URL, ARIA status regions, role=row scans, the global searchbox).
function emitContextAssert(step: AssertStep): string {
  const arg = JSON.stringify(String(step.value ?? '').trim() || String(step.target ?? ''));
  switch (step.assert) {
    case 'URL_MATCHES': return `  await runner.expectUrl(${arg});`;
    case 'HAS_STATUS': return `  await runner.expectStatusRegion(${arg});`;
    case 'EMPTY_STATE': return `  await runner.expectEmptyState(${JSON.stringify(String(step.value ?? '').trim())});`;
    case 'ERROR_STATE': return `  await runner.expectErrorState(${arg});`;
    case 'ROW_IN_LIST': return `  await runner.expectRowInList(${arg});`;
    case 'FOUND_IN_GLOBAL_SEARCH': return `  await runner.searchGlobalFor(${arg});`;
    default: return `  // INVALID_STEP context assert: ${String(step.assert)}`;
  }
}

/** Human-readable label for a step's test.step() wrapper — the id prefix is what the runtime actually parses back out. */
function describeStepForLabel(step: PlanStep): string {
  return isActionStep(step) ? `${step.action} ${step.target}` : `${(step as AssertStep).assert} ${(step as AssertStep).target}`;
}

/**
 * Wraps whatever lines a single plan step just pushed onto `body` (from `start` to the current end) in a
 * labeled `test.step()`, so the agent's reporter can report exactly which authored step a raw Playwright
 * action belongs to (core/shared/automationProgress.ts positional matching otherwise has no real identity
 * to key on). No-ops on an empty emission. The id is embedded in the label text — Playwright's reporter
 * API exposes no field for arbitrary step metadata, so the label is the only channel to carry it back.
 */
function wrapEmittedLines(body: string[], start: number, id: string, label: string): void {
  const emitted = body.splice(start);
  if (!emitted.length) return;
  body.push(
    `  await test.step(${JSON.stringify(`[${id}] ${label}`)}, async () => {`,
    ...emitted.map((line) => `  ${line}`),
    `  });`,
  );
}

function actionFitsRole(step: ActionStep, roleValue: unknown): boolean {
  const role = String(roleValue || '').toLowerCase();
  if (step.action === 'SELECT') return ['combobox', 'listbox', 'select'].includes(role);
  if (step.action === 'FILL' || step.action === 'CLEAR') return ['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(role);
  if (step.action === 'CHECK' || step.action === 'UNCHECK') return ['checkbox', 'radio', 'switch'].includes(role);
  if (step.action === 'CLICK') return ['button', 'link', 'tab', 'checkbox', 'radio', 'switch', 'menuitem', 'option', 'columnheader', 'row', 'textbox', 'searchbox', 'combobox'].includes(role);
  return true;
}

/** The natural action for a grounded role — the verb that role actually supports. Universal (every control
 * class), so any mis-verbed step maps to the right action instead of a per-feature special case. A value-bearing
 * step keeps its value (FILL/SELECT); a value-less one on an editable/choice control is a focus/review CLICK. */
function naturalActionForRole(roleValue: unknown, hasValue: boolean): ActionStep['action'] | null {
  const r = String(roleValue || '').toLowerCase();
  if (['textbox', 'searchbox', 'spinbutton'].includes(r)) return hasValue ? 'FILL' : 'CLICK';
  if (['combobox', 'listbox', 'select'].includes(r)) return hasValue ? 'SELECT' : 'CLICK';
  if (['checkbox', 'radio', 'switch'].includes(r)) return 'CLICK'; // click toggles — role-compatible and safe
  if (['button', 'link', 'tab', 'menuitem', 'option', 'columnheader', 'row'].includes(r)) return 'CLICK';
  return null;
}

/** Recover a role-mismatched action by coercing the verb to the grounded role's natural action instead of
 * dropping the whole case ("Select the API Name textbox" → CLICK/FILL; "Fill the Save button" → CLICK). Returns
 * the coerced step, or null when no safe coercion fits (then it stays a blocking diagnostic). App-agnostic. */
function coerceActionToRole(step: ActionStep, roleValue: unknown): ActionStep | null {
  const hasValue = String((step as any).value ?? '').trim().length > 0;
  const natural = naturalActionForRole(roleValue, hasValue);
  if (!natural || natural === step.action) return null;
  return { ...step, action: natural } as ActionStep;
}

/** Role↔assertion validator — only gates the assertions that are meaningless on a role (a text-value check on a
 * heading/button, a checked-state check on a non-toggle). Everything else (VISIBLE/TEXT/ENABLED…) fits any role. */
function assertFitsRole(assert: string, roleValue: unknown): boolean {
  const role = String(roleValue || '').toLowerCase();
  if (assert === 'HAS_VALUE') return ['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(role);
  if (assert === 'CHECKED' || assert === 'UNCHECKED') return ['checkbox', 'radio', 'switch'].includes(role);
  return true;
}

export class PlaywrightCompiler implements Compiler {
  readonly name = 'playwright';

  compile(input: CompileInput): CompileResult {
    const { mission, evidenceGraph, run } = input;
    let { plan } = input;
    const diagnostics: Diagnostic[] = [];
    if (!plan?.steps?.length) {
      return { code: '', diagnostics: [{ kind: 'EMPTY_PLAN', message: 'Plan has no steps.', severity: 'blocking' }], ok: false };
    }
    // Every step needs an id by the time it's compiled, regardless of which planner authored it — the
    // deterministic planner stamps its own source-attributed ids; this fills in the rest positionally.
    plan = stampStepIds(plan);

    // Seed from the run-UNIQUE id (falling back to mission scope) so every case in the run shares ONE
    // coherent identity (consistency) while distinct runs get distinct identities — no cross-run duplicate
    // name/email/code. The optional backend schema drives API-acceptance-conformant values.
    const engine = new TestDataEngine((run as any)?.id || mission.executionScope || 'testflow', input.objectSchema);

    // Mutation intent, derived deterministically from the plan (never from prompt text): the case commits
    // data only if it sets field values AND clicks a submit-intent control. MissionRunner.verify() uses this
    // to reject data-mutating runs against placeholder app ids (__all_apps__) while read-only sweeps stay legal.
    const FIELD_SET_ACTIONS = new Set(['FILL', 'SELECT', 'CHECK', 'UNCHECK', 'CLEAR']);
    let hasFieldSet = false;
    let hasSubmit = false;
    for (const step of plan.steps) {
      if (!isActionStep(step)) continue;
      if (FIELD_SET_ACTIONS.has(step.action)) hasFieldSet = true;
      if (step.action === 'CLICK') {
        const g = resolveTarget(step.target, evidenceGraph, run);
        if (g.status === 'RESOLVED' && isSubmitClick(step, g.node)) hasSubmit = true;
      }
    }
    const mutationIntent = hasFieldSet && hasSubmit;

    const missionJson = JSON.stringify({
      platform: mission.platform,
      platformType: mission.platformType,
      runtimeSurface: mission.runtimeSurface,
      application: mission.application,
      module: mission.module,
      tab: mission.tab,
      targetUrl: mission.targetUrl,
      executionScope: mission.executionScope,
      mutationIntent,
    });

    const body: string[] = [];
    // Values the engine resolved for fills/selects — later assertions must expect the SAME resolved
    // values, or every expectValue after a generated fill fails on the plan's placeholder text.
    const resolvedBySelector = new Map<string, string>();
    const planToResolved = new Map<string, string>();
    // Selectors the plan deliberately CLEARs — the only fields whose emptiness a HAS_VALUE "" may assert.
    const clearedSelectors = new Set<string>();

    // Required-field completion: the authored plan often fills only the fields the case happened to name, then
    // clicks Save — and the create fails because OTHER required fields are empty. Before the first submit, fill
    // every mandatory field the plan omitted with an API-accepted value (schema-conformant when the backend
    // schema is known). Positive create/submit flows only — negative/validation cases are left untouched.
    // Must be a FILLABLE control — a list column button/header can share a label with a required schema
    // field (e.g. "Account Number"), and filling a button is nonsense. isRequiredFieldNode already gates on
    // role; the schema branch does not, so gate here for both.
    const FILLABLE_ROLES = new Set(['textbox', 'combobox', 'spinbutton', 'listbox']);
    const requiredNodes = isNegativeCase(plan) ? [] : evidenceGraph.nodes.filter((n) =>
      n.selector && n.uniqueness === true && n.confidence === 'verified-live' && n.provenance === 'LIVE_DOM'
      && FILLABLE_ROLES.has(String(n.role || '').toLowerCase())
      && (isRequiredFieldNode(n) || engine.isRequiredBySchema(fieldSemanticsFromNode(n))));
    const plannedSelectors = new Set<string>();
    let submitIndex = -1;
    if (requiredNodes.length) {
      plan.steps.forEach((step, i) => {
        if (!isActionStep(step)) return;
        const g = resolveTarget((step as any).target, evidenceGraph, run);
        if (g.status !== 'RESOLVED') return;
        if (['FILL', 'SELECT', 'CHECK', 'CLEAR'].includes(step.action) && g.selector) plannedSelectors.add(String(g.selector));
        if (submitIndex < 0 && isSubmitClick(step, g.node)) submitIndex = i;
      });
    }
    const missingRequired = submitIndex >= 0 ? requiredNodes.filter((n) => !plannedSelectors.has(String(n.selector))) : [];

    // Modal-open precondition: the create dialog's fields (Label/API Name/…), its submit (Create/Save), and its
    // dismiss (Cancel) only exist in the DOM AFTER a toolbar opener (New/Add/+) is clicked. Authored plans often
    // assume the dialog is already open and jump straight to filling fields — so the fields never appear and every
    // locator times out. If the plan touches dialog-owned controls but never clicks the opener itself, auto-inject
    // that opener click before the first dialog-touching step (mirrors the required-field auto-completion above).
    const openerNode = pickCreateOpener(evidenceGraph.nodes);
    const planAlreadyOpens = plan.steps.some((step) => {
      if (!isActionStep(step) || step.action !== 'CLICK') return false;
      const g = resolveTarget((step as any).target, evidenceGraph, run);
      return g.status === 'RESOLVED' && isCreateOpenerNode(g.node);
    });
    const shouldInjectOpener = !!openerNode && !planAlreadyOpens;
    let openerInjected = false;
    // A step whose target lives inside the create dialog must come after the opener. State-model: ANY control
    // captured in the 'form' state is modal-only (its fields, headings, buttons) — the opener must precede the
    // first step that touches one. Falls back to the required-field/submit/dismiss heuristic for untagged nodes.
    const touchesDialog = (step: PlanStep, node: EvidenceNode | null): boolean => {
      if (node?.stateTag === 'form') return true;
      if (isActionStep(step)) {
        if (['FILL', 'SELECT', 'CLEAR', 'CHECK', 'UNCHECK'].includes(step.action)) return isRequiredFieldNode(node);
        if (step.action === 'CLICK') return isSubmitClick(step, node) || isDialogDismissNode(node);
        return false;
      }
      return isAssertStep(step) && isRequiredFieldNode(node);
    };
    const emitRequiredCompletion = () => {
      for (const node of missingRequired) {
        const spec = JSON.stringify({ selector: node.selector, selectorType: node.selectorType, role: node.role ?? null, label: node.label ?? null });
        const isSelect = ['combobox', 'listbox'].includes(String(node.role || '').toLowerCase());
        const synthetic = { action: isSelect ? 'SELECT' : 'FILL', target: node.semanticName, value: null } as unknown as ActionStep;
        const value = resolveStepValue(engine, synthetic, node);
        resolvedBySelector.set(String(node.selector), value);
        body.push(emitAction(synthetic, spec, value));
      }
      if (missingRequired.length) body.push('  // ^ required fields the plan omitted, auto-completed with API-accepted values so the submit is not blocked by empty required inputs');
    };

    // Observe-then-assert hygiene: validation asserts that can't be true (before the submit, or on a field
    // filled at submit) are dropped so the plan author's scattered expectValidation can't fail the script.
    const validationDrops = isBehaviorOracleEnabled() ? invalidValidationSteps(plan, evidenceGraph, run) : new Set<number>();

    // The step body is unchanged below — only extracted into a named function so the forEach wrapper
    // can measure exactly which lines this one step emitted (for the test.step() wrap), regardless of
    // which of the many early `return`s below fired.
    const runStep = (step: PlanStep, i: number): void => {
      // Complete the form's remaining required fields immediately BEFORE the submit click fires.
      if (i === submitIndex) emitRequiredCompletion();
      if (validationDrops.has(i)) {
        diagnostics.push({ kind: 'INVALID_STEP', target: String((step as any).target || ''), stepIndex: i, message: 'validation assert dropped — not after a submit on an empty field (observe-then-assert)', severity: 'skippable' });
        body.push(`  // dropped validation assert (step ${i + 1}): only valid AFTER a submit, on an empty field`);
        return;
      }
      // OPEN_MODULE is mission-owned navigation: emit runner.openModule() and never ground it as a locator.
      if (isActionStep(step) && step.action === 'OPEN_MODULE') {
        body.push('  await runner.openModule();');
        return;
      }
      // Context asserts are mission/page-scoped: their target is advisory text — never grounded. Expected
      // values the Test Data Engine replaced (e.g. a generated record name) are threaded like HAS_TEXT.
      if (isAssertStep(step) && CONTEXT_ASSERTS.has(step.assert)) {
        const raw = String(step.value ?? '').trim();
        const threaded = raw ? (planToResolved.get(raw.toLowerCase()) ?? raw) : raw;
        body.push(emitContextAssert({ ...step, value: threaded } as AssertStep));
        return;
      }
      const target = (step as any).target as string;
      const g = resolveTarget(target, evidenceGraph, run);
      if (g.status !== 'RESOLVED') {
        // An unresolved ACTION breaks the flow (blocking → drop the case); an unresolved ASSERTION is an
        // observation we simply cannot make (skippable → drop the step, keep the rest of the script).
        diagnostics.push({ kind: g.status, target, stepIndex: i, message: g.reason || g.status, severity: isActionStep(step) ? 'blocking' : 'skippable' });
        // Emit an explicit marker — NEVER a guessed locator.
        body.push(`  // ${g.status}: "${target}" — ${g.reason || ''}`);
        return;
      }
      if (isActionStep(step) && !actionFitsRole(step, g.node?.role)) {
        // Recover instead of dropping the whole case: coerce the verb to the grounded role when a safe mapping
        // exists ("Select the X textbox" → CLICK/FILL). Only a truly un-coercible action stays blocking.
        const coerced = coerceActionToRole(step, g.node?.role);
        if (coerced) {
          diagnostics.push({ kind: 'INVALID_STEP', target, stepIndex: i, message: `${step.action} coerced to ${coerced.action} to fit role "${g.node?.role || 'unknown'}".`, severity: 'skippable' });
          step = coerced;
        } else {
          diagnostics.push({ kind: 'INVALID_STEP', target, stepIndex: i, message: `${step.action} is incompatible with role "${g.node?.role || 'unknown'}".`, severity: 'blocking' });
          body.push(`  // INVALID_STEP: ${step.action} cannot target role "${g.node?.role || 'unknown'}" (${JSON.stringify(target)})`);
          return;
        }
      }
      // Open the create dialog before the first step that touches a control living inside it.
      if (shouldInjectOpener && !openerInjected && touchesDialog(step, g.node)) {
        const oSpec = JSON.stringify({ selector: openerNode!.selector, selectorType: openerNode!.selectorType, role: openerNode!.role ?? null, label: openerNode!.label ?? null });
        body.push(`  await runner.click(${oSpec});`);
        body.push('  // ^ opener auto-injected: the dialog controls below only exist once this control opens the modal');
        openerInjected = true;
      }
      const spec = JSON.stringify({ selector: g.selector, selectorType: g.selectorType, role: g.node?.role ?? null, label: g.node?.label ?? null });
      if (isActionStep(step)) {
        const value = resolveStepValue(engine, step, g.node);
        if (step.action === 'FILL' || step.action === 'SELECT') {
          resolvedBySelector.set(g.selector as string, value);
          const pv = String(step.value ?? '').trim();
          if (pv && pv !== value) planToResolved.set(pv.toLowerCase(), value);
        } else if (step.action === 'CLEAR') {
          resolvedBySelector.delete(g.selector as string); // a cleared field's later empty-value check must stay ""
          clearedSelectors.add(g.selector as string);
        }
        body.push(emitAction(step, spec, value));
      } else {
        const assertStep = step as AssertStep;
        // In a NEGATIVE/validation case, a HAS_VALUE assert expresses "this requirement is enforced" — assert a
        // validation error is shown (robust), not a specific field value (brittle: the field may auto-derive or
        // stay empty, so toHaveValue fails on a correct app). expectValidation confirms the constraint fired.
        if (assertStep.assert === 'HAS_VALUE' && isNegativeCase(plan)) {
          body.push(`  await runner.expectValidation(${spec}, ${JSON.stringify(String(assertStep.value ?? ''))});`);
          return;
        }
        const raw = String(assertStep.value ?? '');
        const swappable = assertStep.assert === 'HAS_VALUE' || assertStep.assert === 'HAS_TEXT' || assertStep.assert === 'NOT_HAS_TEXT';
        // Deliberate empty-value expectations ("field stays blank") are never rewritten.
        let value = swappable && raw.trim()
          ? (assertStep.assert === 'HAS_VALUE' && resolvedBySelector.has(g.selector as string)
            ? resolvedBySelector.get(g.selector as string)
            : (planToResolved.get(raw.trim().toLowerCase()) ?? raw))
          : raw;
        // ASSERTION_GROUNDING_V1: if a non-threaded expectText value only reformats the target's own label,
        // assert the REAL observed text (literal toContainText else fails a correct app).
        if (isAssertionGroundingEnabled() && assertStep.assert === 'HAS_TEXT' && value === raw && raw.trim()) {
          const nodeLabel = String(g.node?.label ?? '').trim();
          const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
          if (nodeLabel && nodeLabel !== raw.trim() && norm(nodeLabel) === norm(raw)) {
            value = nodeLabel;
          }
        }
        // Fail loud on an unresolved {{token}} that survived threading — NEVER emit a literal template as an
        // expectation (toHaveValue('{{run_unique_app_api_name}}') can never pass). Skippable: drop this one
        // assertion and keep the rest of the script (the fill it referenced still ran with a real value).
        if (/\{\{[^}]+\}\}/.test(String(value ?? ''))) {
          diagnostics.push({ kind: 'UNRESOLVED_TEMPLATE', target, stepIndex: i, message: `Assertion expects an unresolved template token ${JSON.stringify(value)} — a generated value must be resolved to its concrete form before it is asserted.`, severity: 'skippable' });
          body.push(`  // UNRESOLVED_TEMPLATE: ${JSON.stringify(value)} — skipped (cannot assert a raw {{token}})`);
          return;
        }
        // A checkbox/radio/switch has no text value — HAS_VALUE on it must assert CHECKED state, not toHaveValue
        // (which always fails). Deterministic role-based correction, independent of what the author emitted.
        const assertRole = String(g.node?.role || '').toLowerCase();
        if (assertStep.assert === 'HAS_VALUE' && ['checkbox', 'radio', 'switch'].includes(assertRole)) {
          body.push(`  await runner.expectChecked(${spec}, ${JSON.stringify(String(value ?? ''))});`);
          return;
        }
        // HAS_VALUE "" is only reliable right after a deliberate CLEAR; on any other field it is a mis-authored
        // "should be empty" for a value that auto-derives/defaults (toHaveValue("") fails a correct app). Drop it.
        if (assertStep.assert === 'HAS_VALUE' && String(value ?? '').trim() === '' && !clearedSelectors.has(g.selector as string)) {
          diagnostics.push({ kind: 'INVALID_STEP', target, stepIndex: i, message: 'HAS_VALUE "" dropped — emptiness is only assertable right after a CLEAR (field may auto-derive/default).', severity: 'skippable' });
          body.push(`  // dropped empty-value assert (step ${i + 1}): field not cleared — cannot assert blank (may auto-derive/default)`);
          return;
        }
        // A VERIFY_VALIDATION in a POSITIVE case on an editable field, whose expected text is NOT error/requirement
        // flavored, is not an error check — it means "the field is correctly populated/valid" (e.g. an auto-derived
        // value). expectValidation hunts for an error element a correct app never shows, so assert a non-empty
        // value instead. Genuine error-intent ("required"/"invalid"/…) stays expectValidation.
        if (assertStep.assert === 'VERIFY_VALIDATION' && !isNegativeCase(plan)
          && ['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(assertRole)
          && !/\b(required|invalid|mandatory|must|error|cannot|not\s+allowed|blocked|missing|empty|blank)\b/i.test(String(assertStep.value ?? ''))) {
          body.push(`  await runner.expectNonEmptyValue(${spec});`);
          return;
        }
        // Role↔assertion gate: a value/checked assert on an incompatible role can never pass — drop that one
        // assertion (skippable: the case still ships its other steps) instead of emitting a guaranteed failure.
        if (!assertFitsRole(assertStep.assert, assertRole)) {
          diagnostics.push({ kind: 'INVALID_STEP', target, stepIndex: i, message: `${assertStep.assert} is incompatible with role "${assertRole || 'unknown'}".`, severity: 'skippable' });
          body.push(`  // INVALID_STEP assert: ${assertStep.assert} on role "${assertRole || 'unknown'}" — skipped`);
          return;
        }
        body.push(emitAssert(assertStep, spec, value));
      }
    };
    plan.steps.forEach((step: PlanStep, i: number) => {
      const start = body.length;
      runStep(step, i);
      wrapEmittedLines(body, start, String((step as any).id || `step:${i}`), describeStepForLabel(step));
    });

    // Fallback must stay user-presentable — it becomes the evidence-card header in the console.
    const title = String(plan.title || plan.module || plan.mission || 'Untitled test case').replace(/`/g, "'");
    const code =
      `import { test, expect } from '@playwright/test';\n` +
      `import { MissionRunner } from './mission-runner';\n\n` +
      `const MISSION = ${missionJson} as const;\n\n` +
      `test(${JSON.stringify(title)}, async ({ page }) => {\n` +
      `  const runner = new MissionRunner(page, MISSION as any);\n` +
      `  await runner.startMission();\n` +
      `${body.join('\n')}\n` +
      `});\n`;

    // ok = no BLOCKING diagnostics. A case whose only failures are skippable (an assertion that couldn't be
    // grounded) still ships a runnable script for its groundable steps, instead of being deleted entirely.
    return { code, diagnostics, ok: diagnostics.every((d) => d.severity !== 'blocking') };
  }
}

export const playwrightCompiler = new PlaywrightCompiler();
