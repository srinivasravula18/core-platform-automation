/**
 * PlaywrightCompiler (Phase 4) — the FIRST backend implementing the `Compiler` interface. It turns an
 * abstract Test Plan + verified evidence into a deterministic Playwright spec. It NEVER invents selectors,
 * URLs, appIds, labels, roles, waits, login, or navigation: every locator comes from the Grounding Engine
 * (verified evidence), and navigation/login/verification are delegated to the emitted MissionRunner. Any
 * target that cannot be uniquely grounded becomes an explicit diagnostic (AMBIGUOUS/UNRESOLVED), not a guess.
 */
import type { Compiler, CompileInput, CompileResult, Diagnostic } from './Compiler';
import { resolveTarget } from '../graph/groundingEngine';
import { isActionStep, type ActionStep, type AssertStep, type PlanStep } from './testPlan';
import { TestDataEngine, type FieldSemantics } from '../testdata';
import { isRequiredFieldNode, type EvidenceNode } from '../graph/evidenceGraph';

/** A submit-intent CLICK — the button that commits a create/edit. App-agnostic verbs; matched against the
 * grounded control's role+label so completing the form before it fires makes create/submit flows succeed. */
function isSubmitClick(step: PlanStep, node: EvidenceNode | null): boolean {
  if (!isActionStep(step) || step.action !== 'CLICK' || String(node?.role || '').toLowerCase() !== 'button') return false;
  return /^(save|create|submit|add|confirm|finish|done|save\s*&\s*new|create\s*&\s*new|save and new|create and new)\b/i.test(String(node?.label || '').trim());
}

/** A negative/validation case deliberately leaves fields empty (that emptiness IS the test) — never auto-complete it. */
function isNegativeCase(plan: { title?: string | null }): boolean {
  return /\b(empty|blank|without|missing|invalid|blocked|required\s+error|validation|negative|cannot|not\s+allowed|leave\s+\w+\s+empty|no\s+\w+\s+(provided|entered))\b/i.test(String(plan?.title || ''));
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
    // Higher-level VERIFY_* intents expand to a deterministic (reveal-then-)visible assertion; richer
    // expansions (row counts, sort order, filter effects) are added by later backends without changing the IR.
    case 'VISIBLE':
    case 'VERIFY_TABLE':
    case 'VERIFY_FILTER':
    case 'VERIFY_SORT':
    case 'VERIFY_PAGINATION':
    case 'VERIFY_LOOKUP':
    case 'VERIFY_PERMISSION':
    case 'VERIFY_VALIDATION':
    case 'VERIFY_ERROR': return `  await runner.expectVisible(${spec});`;
    case 'NOT_VISIBLE': return `  await runner.expectHidden(${spec});`;
    case 'ENABLED': return `  await runner.expectEnabled(${spec});`;
    case 'DISABLED': return `  await runner.expectDisabled(${spec});`;
    case 'HAS_TEXT': return `  await runner.expectText(${spec}, ${v});`;
    case 'NOT_HAS_TEXT': return `  await runner.expectNotText(${spec}, ${v});`;
    case 'HAS_VALUE': return `  await runner.expectValue(${spec}, ${v});`;
    case 'COUNT_GT': return `  await runner.expectCountGt(${spec}, Number(${v} || 0));`;
    default: return `  // INVALID_STEP assert: ${String((step as any).assert)}`;
  }
}

function actionFitsRole(step: ActionStep, roleValue: unknown): boolean {
  const role = String(roleValue || '').toLowerCase();
  if (step.action === 'SELECT') return ['combobox', 'listbox', 'select'].includes(role);
  if (step.action === 'FILL' || step.action === 'CLEAR') return ['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(role);
  if (step.action === 'CHECK' || step.action === 'UNCHECK') return ['checkbox', 'radio', 'switch'].includes(role);
  if (step.action === 'CLICK') return ['button', 'link', 'tab', 'checkbox', 'radio', 'switch', 'menuitem', 'option', 'columnheader', 'row', 'textbox', 'searchbox', 'combobox'].includes(role);
  return true;
}

export class PlaywrightCompiler implements Compiler {
  readonly name = 'playwright';

  compile(input: CompileInput): CompileResult {
    const { mission, plan, evidenceGraph, run } = input;
    const diagnostics: Diagnostic[] = [];
    if (!plan?.steps?.length) {
      return { code: '', diagnostics: [{ kind: 'EMPTY_PLAN', message: 'Plan has no steps.' }], ok: false };
    }

    // Seed from the run-UNIQUE id (falling back to mission scope) so every case in the run shares ONE
    // coherent identity (consistency) while distinct runs get distinct identities — no cross-run duplicate
    // name/email/code. The optional backend schema drives API-acceptance-conformant values.
    const engine = new TestDataEngine((run as any)?.id || mission.executionScope || 'testflow', input.objectSchema);

    const missionJson = JSON.stringify({
      platform: mission.platform,
      platformType: mission.platformType,
      runtimeSurface: mission.runtimeSurface,
      application: mission.application,
      module: mission.module,
      tab: mission.tab,
      targetUrl: mission.targetUrl,
      executionScope: mission.executionScope,
    });

    const body: string[] = [];
    // Values the engine resolved for fills/selects — later assertions must expect the SAME resolved
    // values, or every expectValue after a generated fill fails on the plan's placeholder text.
    const resolvedBySelector = new Map<string, string>();
    const planToResolved = new Map<string, string>();

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

    plan.steps.forEach((step: PlanStep, i: number) => {
      // Complete the form's remaining required fields immediately BEFORE the submit click fires.
      if (i === submitIndex) emitRequiredCompletion();
      // OPEN_MODULE is mission-owned navigation: emit runner.openModule() and never ground it as a locator.
      if (isActionStep(step) && step.action === 'OPEN_MODULE') {
        body.push('  await runner.openModule();');
        return;
      }
      const target = (step as any).target as string;
      const g = resolveTarget(target, evidenceGraph, run);
      if (g.status !== 'RESOLVED') {
        diagnostics.push({ kind: g.status, target, stepIndex: i, message: g.reason || g.status });
        // Emit an explicit marker — NEVER a guessed locator.
        body.push(`  // ${g.status}: "${target}" — ${g.reason || ''}`);
        return;
      }
      if (isActionStep(step) && !actionFitsRole(step, g.node?.role)) {
        diagnostics.push({ kind: 'INVALID_STEP', target, stepIndex: i, message: `${step.action} is incompatible with role "${g.node?.role || 'unknown'}".` });
        body.push(`  // INVALID_STEP: ${step.action} cannot target role "${g.node?.role || 'unknown'}" (${JSON.stringify(target)})`);
        return;
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
        }
        body.push(emitAction(step, spec, value));
      } else {
        const assertStep = step as AssertStep;
        const raw = String(assertStep.value ?? '');
        const swappable = assertStep.assert === 'HAS_VALUE' || assertStep.assert === 'HAS_TEXT' || assertStep.assert === 'NOT_HAS_TEXT';
        // Deliberate empty-value expectations ("field stays blank") are never rewritten.
        const value = swappable && raw.trim()
          ? (assertStep.assert === 'HAS_VALUE' && resolvedBySelector.has(g.selector as string)
            ? resolvedBySelector.get(g.selector as string)
            : (planToResolved.get(raw.trim().toLowerCase()) ?? raw))
          : raw;
        body.push(emitAssert(assertStep, spec, value));
      }
    });

    const title = String(plan.title || plan.module || plan.mission || 'compiled mission').replace(/`/g, "'");
    const code =
      `import { test, expect } from '@playwright/test';\n` +
      `import { MissionRunner } from './mission-runner';\n\n` +
      `const MISSION = ${missionJson} as const;\n\n` +
      `test(${JSON.stringify(title)}, async ({ page }) => {\n` +
      `  const runner = new MissionRunner(page, MISSION as any);\n` +
      `  await runner.startMission();\n` +
      `${body.join('\n')}\n` +
      `});\n`;

    return { code, diagnostics, ok: diagnostics.length === 0 };
  }
}

export const playwrightCompiler = new PlaywrightCompiler();
