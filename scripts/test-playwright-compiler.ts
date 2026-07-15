/**
 * PlaywrightCompiler tests (Phase 4). Proves deterministic compilation: a grounded plan → a spec that uses
 * MissionRunner + verified locators and passes the validation gate (zero forbidden constructs); an ungrounded
 * target → explicit diagnostic + a marker comment, never a guessed locator.
 *   npx tsx scripts/test-playwright-compiler.ts   (npm run test:compiler)
 */
import { buildMissionContext } from '../server/features/agent/mission/missionContext';
import { buildEvidenceGraphFromRun } from '../server/features/agent/graph/evidenceGraph';
import { playwrightCompiler } from '../server/features/agent/compiler/playwrightCompiler';
import { validateCompiledOutput } from '../server/features/agent/compiler/validateCompiledOutput';
import type { TestPlan } from '../server/features/agent/compiler/testPlan';
import { semanticPlanFromCase } from '../server/features/agent/compiler/semanticPlanner';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const vs = (id: string, role: string, label: string, selector: string, selectorType: string, uniqueness = true) => ({
  id, elementType: role, role, label, selector, selectorType, verified: uniqueness,
  verificationStatus: uniqueness ? 'verified' : 'not_unique', confidence: 'verified-live',
  provenance: 'LIVE_DOM', visibility: true, uniqueness, sourceEvidenceId: 'dom', fallbackSelector: null,
});

function main() {
  const runtime = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://h/keystone/', runtimeSurface: 'keystone', application: { id: 'app9', name: 'CRM' }, module: { id: 'accounts', name: 'Account' } });
  const run: any = { selector_registry: { verified_selectors: [
    vs('sel_nav', 'button', 'Accounts', 'getByRole(button,Accounts)', 'role'),
    vs('sel_new', 'button', 'New', '[data-testid="new"]', 'testid'),
    vs('sel_search', 'textbox', 'Search', '#search', 'css'),
    vs('sel_refresh', 'button', 'Refresh list view', '#refresh', 'css'),
    vs('sel_roles', 'heading', 'Roles', 'h3', 'css'),
    vs('sel_label', 'textbox', 'Label *', '#create-app-label', 'css'),
    vs('sel_api', 'textbox', 'API Name *', '#create-app-api', 'css'),
    vs('sel_prefix', 'textbox', 'Prefix *', '#create-app-prefix', 'css'),
    vs('sel_version', 'textbox', 'Version', '#create-app-version', 'css'),
    vs('sel_apps', 'button', 'Apps', 'x', 'role', false), // not unique
  ] } };
  const graph = buildEvidenceGraphFromRun(run, { platform: 'Keystone', application: 'CRM', module: 'accounts' });

  const plan: TestPlan = {
    mission: runtime.executionScope, module: 'Account', title: 'accounts smoke',
    steps: [
      { action: 'OPEN_MODULE', target: 'Accounts' },
      { assert: 'VISIBLE', target: 'New' },
      { action: 'FILL', target: 'Search', value: 'acme' },
      { assert: 'VERIFY_TABLE', target: 'New' },
    ],
  };

  console.log('happy path');
  const r = playwrightCompiler.compile({ mission: runtime, plan, evidenceGraph: graph, run });
  ok(r.ok, 'compiles with zero diagnostics');
  ok(r.code.includes("import { MissionRunner } from './mission-runner'"), 'imports MissionRunner');
  ok(r.code.includes('await runner.startMission();'), 'navigation via MissionRunner only');
  ok(r.code.includes('await runner.openModule();'), 'OPEN_MODULE → mission-scoped runner.openModule(), not a click');
  ok(r.code.includes('await runner.expectVisible('), 'assert via reveal-then-act helper');
  ok(r.code.includes('await runner.fill('), 'fill via helper');
  ok(r.code.includes('data-testid'), 'verified locator embedded');

  console.log('OPEN_MODULE needs no locator evidence (target is advisory, never grounded)');
  const navOnly: TestPlan = { mission: runtime.executionScope, steps: [{ action: 'OPEN_MODULE', target: 'not-a-catalog-name' }] };
  const rNav = playwrightCompiler.compile({ mission: runtime, plan: navOnly, evidenceGraph: graph, run });
  ok(rNav.ok && rNav.diagnostics.length === 0, 'OPEN_MODULE with an ungrounded target still compiles clean');
  ok(rNav.code.includes('await runner.openModule();') && !rNav.code.includes('UNRESOLVED'), 'no grounding diagnostic for OPEN_MODULE');

  console.log('validation gate passes on compiled output');
  const gate = validateCompiledOutput(r.code);
  ok(gate.ok, `no forbidden constructs (violations: ${JSON.stringify(gate.violations.map((v) => v.rule))})`);
  ok(!/page\.goto|new URL|loginIfNeeded|\.first\(/.test(r.code), 'no goto/new URL/login/.first in spec');

  console.log('runtime appId lives ONLY in the MISSION entry, not re-derived');
  ok(r.code.includes('app9'), 'mission carries the appId');
  ok(!/searchParams/.test(r.code), 'no searchParams manipulation');

  console.log('assertions expect the ENGINE-RESOLVED values (fill ↔ expectValue stay consistent)');
  {
    const p: TestPlan = { mission: runtime.executionScope, title: 'create app', steps: [
      { action: 'FILL', target: 'Label *', value: 'unique_label' },
      { assert: 'HAS_VALUE', target: 'Label *', value: 'unique_label' },
      { action: 'FILL', target: 'API Name *', value: 'unique_api_name' },
      { assert: 'HAS_VALUE', target: 'API Name *', value: 'unique_api_name' },
      { assert: 'HAS_VALUE', target: 'Prefix *', value: '' },
    ] };
    const rc = playwrightCompiler.compile({ mission: runtime, plan: p, evidenceGraph: graph, run });
    ok(rc.ok, 'threading plan compiles');
    ok(!rc.code.includes('"unique_label"'), 'placeholder fill value replaced by a generated value');
    const fillLabel = /runner\.fill\(\{[^}]*create-app-label[^}]*\}, ("[^"]+")\)/.exec(rc.code);
    const expectLabel = /runner\.expectValue\(\{[^}]*create-app-label[^}]*\}, ("[^"]*")\)/.exec(rc.code);
    ok(!!fillLabel && !!expectLabel && fillLabel[1] === expectLabel[1], `expectValue matches the resolved fill (${fillLabel?.[1]} vs ${expectLabel?.[1]})`);
    const fillApi = /runner\.fill\(\{[^}]*create-app-api[^}]*\}, ("[^"]+")\)/.exec(rc.code);
    ok(!!fillApi && /^"[a-z]+_\d{2}"$/.test(fillApi[1]), `api name resolved to an identifier shape (${fillApi?.[1]})`);
    ok(/expectValue\(\{[^}]*create-app-prefix[^}]*\}, ""\)/.test(rc.code), 'deliberate empty-value expectation stays ""');
  }

  console.log('ungrounded target → diagnostic + marker, never a guess');
  const bad: TestPlan = { mission: runtime.executionScope, steps: [
    { action: 'CLICK', target: 'Apps' },       // not unique → withheld from the graph
    { action: 'CLICK', target: 'Ghost' },      // missing → UNRESOLVED
  ] };
  const r2 = playwrightCompiler.compile({ mission: runtime, plan: bad, evidenceGraph: graph, run });
  ok(!r2.ok, 'not ok when targets cannot be grounded');
  eq(r2.diagnostics.map((d) => d.kind).sort(), ['UNRESOLVED_SELECTOR', 'UNRESOLVED_SELECTOR'], 'both diagnostics reported');
  ok(r2.code.includes('// UNRESOLVED_SELECTOR: "Apps"') && r2.code.includes('// UNRESOLVED_SELECTOR: "Ghost"'), 'markers emitted, no guessed locator');
  ok(!r2.code.includes('.first('), 'never emits .first() for the ambiguous target');

  console.log('empty plan');
  const r3 = playwrightCompiler.compile({ mission: runtime, plan: { mission: 'x', steps: [] }, evidenceGraph: graph, run });
  ok(!r3.ok && r3.diagnostics[0].kind === 'EMPTY_PLAN', 'empty plan → EMPTY_PLAN diagnostic');

  console.log('semantic planner maps reviewed language to verified catalog targets');
  const semantic = semanticPlanFromCase({ title: 'Create app form', steps: [
    { action: 'Open the Apps page if needed.', expected: 'Apps is shown with New, Label, API Name, Version, Prefix, and Parent App.' },
    { action: 'Click the unique New button.' },
    { action: 'Verify Label is visible.' },
    { action: 'Verify API Name and Prefix are visible.' },
    { action: 'Verify Version is visible and do not click Create.' },
  ] }, graph, runtime);
  ok(!!semantic, 'straightforward semantic case produces a deterministic plan');
  eq(semantic?.steps.map((step: any) => step.action || `${step.assert}:${step.target}`), [
    'OPEN_MODULE', 'CLICK', 'VISIBLE:Label', 'VISIBLE:APIName', 'VISIBLE:Prefix', 'VISIBLE:Version',
  ], 'maps open/click/multi-field assertions without including negated Create');
  const semanticCompiled = playwrightCompiler.compile({ mission: runtime, plan: semantic!, evidenceGraph: graph, run });
  ok(semanticCompiled.ok, 'semantic plan compiles using verified selectors only');
  ok(semanticCompiled.code.includes('#create-app-label') && semanticCompiled.code.includes('#create-app-version'), 'compiled script carries verified Create App fields');
  ok(semanticCompiled.code.indexOf('runner.click') < semanticCompiled.code.indexOf('#create-app-label'), 'later-state form fields are asserted only after clicking New');
  ok(!semanticCompiled.code.includes('label":"Create"'), 'negated Create action is not turned into a positive assertion');

  console.log('semantic selection uses the target role, never the English verb alone');
  const buttonSelect = semanticPlanFromCase({ title: 'refresh', steps: [
    { action: 'Select "Refresh list view".', expected: 'Refresh list view is visible.' },
  ] }, graph, runtime);
  eq((buttonSelect?.steps[0] as any)?.action, 'CLICK', 'Select on a button maps to CLICK');
  ok(!JSON.stringify(buttonSelect).includes('SELECT'), 'button plan contains no SELECT action');

  console.log('semantic row selection and replacement preserve every source step');
  const rowRun: any = { selector_registry: { verified_selectors: [
    ...run.selector_registry.verified_selectors,
    vs('row-system', 'row', 'system_admin', 'role=row[name="system_admin"]', 'role+name'),
    vs('check-system', 'checkbox', 'system_admin', 'tr:has-text("system_admin") input[type="checkbox"]', 'row-key'),
    vs('delete', 'button', 'Delete', '[aria-label="Delete"]', 'aria-label'),
  ] } };
  const rowGraph = buildEvidenceGraphFromRun(rowRun, { platform: 'Admin', application: null, module: 'roles' });
  const rowPlan = semanticPlanFromCase({ title: 'selection reset', steps: [
    { action: 'Select the checkbox in the "system_admin" row.', expected: 'Delete becomes enabled.' },
    { action: 'Replace "system_admin" with "new" in the "Search" box.', expected: 'system_admin is not displayed.' },
    { action: 'Inspect the "Delete" button.', expected: 'The "Delete" button is disabled.' },
  ] }, rowGraph, runtime)!;
  eq((rowPlan.steps[0] as any)?.action, 'CHECK', 'row selection prefers the verified checkbox over clicking its row');
  ok(rowPlan.steps.some((step: any) => step.action === 'FILL' && step.value === 'new'), 'replace uses the new quoted value');
  ok(rowPlan.steps.some((step: any) => step.assert === 'DISABLED'), 'disabled expectation maps to DISABLED');
  eq(rowPlan.mappedSourceSteps, [0, 1, 2], 'all source steps are mapped');

  const genericRoles = semanticPlanFromCase({ title: 'filtered rows', steps: [
    { action: 'Review every displayed role row.', expected: 'Nonmatching roles such as "system_admin" are not visible.' },
  ] }, rowGraph, runtime)!;
  ok(!genericRoles.steps.some((step: any) => step.target === 'Roles'), 'generic plural roles does not target the Roles heading');

  console.log('compiler rejects incompatible action/element pairs');
  const incompatible: TestPlan = { mission: runtime.executionScope, steps: [{ action: 'SELECT', target: 'Roles', value: 'system_admin' }] };
  const badAction = playwrightCompiler.compile({ mission: runtime, plan: incompatible, evidenceGraph: graph, run });
  ok(!badAction.ok && badAction.diagnostics[0]?.kind === 'INVALID_STEP', 'SELECT targeting a heading is rejected');
  ok(!badAction.code.includes('runner.select('), 'invalid SELECT is never emitted');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
