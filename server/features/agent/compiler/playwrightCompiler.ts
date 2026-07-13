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

// Actions/assertions are emitted through MissionRunner's reveal-then-act helpers (not raw locator calls), so
// every interaction first reveals hover-gated controls (column filter/sort/wrap triggers, row menus, …).
function emitAction(step: ActionStep, spec: string): string {
  const v = JSON.stringify(step.value ?? '');
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

function emitAssert(step: AssertStep, spec: string): string {
  const v = JSON.stringify(step.value ?? '');
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
    plan.steps.forEach((step: PlanStep, i: number) => {
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
      body.push(isActionStep(step) ? emitAction(step, spec) : emitAssert(step as AssertStep, spec));
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
