/**
 * PlaywrightCompiler tests (Phase 4). Proves deterministic compilation: a grounded plan → a spec that uses
 * MissionRunner + verified locators and passes the validation gate (zero forbidden constructs); an ungrounded
 * target → explicit diagnostic + a marker comment, never a guessed locator.
 *   npx tsx scripts/test-playwright-compiler.ts   (npm run test:compiler)
 */
import { buildMissionContext } from '../server/features/agent/mission/missionContext';
import { MISSION_RUNNER_SOURCE } from '../server/features/agent/compiler/missionRunner.template';
import { buildEvidenceGraphFromRun } from '../server/features/agent/graph/evidenceGraph';
import { playwrightCompiler } from '../server/features/agent/compiler/playwrightCompiler';
import { validateCompiledOutput } from '../server/features/agent/compiler/validateCompiledOutput';
import type { TestPlan } from '../server/features/agent/compiler/testPlan';
import { semanticPlanFromCase } from '../server/features/agent/compiler/semanticPlanner';
import { catalogTargetIssues } from '../server/features/agent/workflow/nodes/authoring';
import { renderTargetCatalogForPrompt } from '../server/features/agent/compiler/renderCatalogForPrompt';

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
  ok(r3.diagnostics[0].severity === 'blocking', 'EMPTY_PLAN is blocking');

  console.log('P2 severity: a skippable assertion failure still ships a script; a blocking action failure drops the case');
  {
    // Only failure is an ASSERT on an ungrounded target → skippable → the case still compiles its good steps.
    const partial: TestPlan = { mission: runtime.executionScope, title: 'partial', steps: [
      { action: 'FILL', target: 'Search', value: 'acme' }, // grounds fine
      { assert: 'VISIBLE', target: 'Ghost' },              // ungrounded ASSERT → skippable
    ] };
    const rp = playwrightCompiler.compile({ mission: runtime, plan: partial, evidenceGraph: graph, run });
    ok(rp.ok, 'a case whose ONLY failure is an ungrounded assertion still ships a script (was previously dropped)');
    ok(rp.diagnostics.length === 1 && rp.diagnostics[0].severity === 'skippable', 'the ungrounded assertion is classified skippable');
    ok(rp.code.includes('await runner.fill('), 'the groundable action step is still emitted');
    ok(rp.code.includes('// UNRESOLVED_SELECTOR: "Ghost"'), 'the skipped assertion is marked, never guessed');

    // An ungrounded ACTION step is blocking → the case is dropped.
    const blocked: TestPlan = { mission: runtime.executionScope, title: 'blocked', steps: [
      { action: 'FILL', target: 'Search', value: 'acme' },
      { action: 'CLICK', target: 'Ghost' }, // ungrounded ACTION → blocking
    ] };
    const rb = playwrightCompiler.compile({ mission: runtime, plan: blocked, evidenceGraph: graph, run });
    ok(!rb.ok, 'a case with an ungrounded ACTION step is still dropped (blocking)');
    ok(rb.diagnostics.some((d) => d.severity === 'blocking'), 'the ungrounded action is classified blocking');
  }

  console.log('P2 template: an unresolved {{token}} in an assertion fails loud (skippable), never emitted as a literal');
  {
    // Fill and assert on DIFFERENT fields (the production shape) so the token cannot thread through resolvedBySelector.
    const tpl: TestPlan = { mission: runtime.executionScope, title: 'template', steps: [
      { action: 'FILL', target: 'Label *', value: 'unique_label' },
      { assert: 'HAS_VALUE', target: 'API Name *', value: '{{run_unique_app_api_name}}' },
    ] };
    const rt = playwrightCompiler.compile({ mission: runtime, plan: tpl, evidenceGraph: graph, run });
    ok(rt.ok, 'the case still ships — the unresolved-template assertion is skippable, not fatal');
    ok(rt.diagnostics.some((d) => d.kind === 'UNRESOLVED_TEMPLATE' && d.severity === 'skippable'), 'an UNRESOLVED_TEMPLATE diagnostic is raised');
    ok(!rt.code.split('\n').some((l) => !l.trim().startsWith('//') && l.includes('{{run_unique_app_api_name}}')), 'the raw template token appears only in a skip comment, never in executable code');
    ok(rt.code.includes('await runner.fill('), 'the fill step is still emitted');
  }

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

  console.log('required-field completion: create/submit flows fill EVERY required field the plan omitted');
  {
    const formRun: any = { id: 'run-reqfill', selector_registry: { verified_selectors: [
      vs('rf_label', 'textbox', 'Label *', '#f-label', 'css'),
      vs('rf_api', 'textbox', 'API Name *', '#f-api', 'css'),
      vs('rf_prefix', 'textbox', 'Prefix *', '#f-prefix', 'css'),
      vs('rf_parent', 'combobox', 'Parent App *', '#f-parent', 'css'),
      vs('rf_version', 'textbox', 'Version', '#f-version', 'css'), // optional — no required marker
      vs('rf_create', 'button', 'Create', 'role=button[name="Create"]', 'role'),
    ] } };
    const formGraph = buildEvidenceGraphFromRun(formRun, { platform: 'Admin', module: 'apps' });
    // Plan fills ONLY Label then clicks Create — exactly the "50% filled → submit fails" case.
    const partial: TestPlan = { mission: runtime.executionScope, title: 'Create app with required fields', steps: [
      { action: 'FILL', target: 'Label', value: 'unique_label' },
      { action: 'CLICK', target: 'Create' },
    ] };
    const rc = playwrightCompiler.compile({ mission: runtime, plan: partial, evidenceGraph: formGraph, run: formRun });
    ok(rc.ok, 'partial create plan compiles');
    ok(/runner\.fill\(\{[^}]*#f-label/.test(rc.code), 'plan-named Label is filled');
    ok(/runner\.fill\(\{[^}]*#f-api/.test(rc.code), 'omitted required API Name is auto-filled');
    ok(/runner\.fill\(\{[^}]*#f-prefix/.test(rc.code), 'omitted required Prefix is auto-filled');
    ok(/runner\.select\(\{[^}]*#f-parent/.test(rc.code), 'omitted required Parent App (combobox) is auto-selected');
    ok(!/#f-version/.test(rc.code), 'optional Version (no marker) is NOT auto-filled');
    const createAt = rc.code.indexOf('runner.click');
    ok(rc.code.indexOf('#f-api') < createAt && rc.code.indexOf('#f-parent') < createAt, 'all required completions happen BEFORE the Create click');

    // Negative/validation case: the emptiness IS the test — completion must not fire.
    const neg: TestPlan = { mission: runtime.executionScope, title: 'Create is blocked when API Name is empty', steps: [
      { action: 'FILL', target: 'Label', value: 'x' },
      { action: 'CLICK', target: 'Create' },
    ] };
    const rn = playwrightCompiler.compile({ mission: runtime, plan: neg, evidenceGraph: formGraph, run: formRun });
    ok(!/#f-api/.test(rn.code), 'negative "API Name empty" case leaves API Name empty (no auto-complete)');
    ok(!/#f-prefix/.test(rn.code) && !/#f-parent/.test(rn.code), 'negative case does not auto-fill any required field');
  }

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

  console.log('context asserts (Phase 4): page-scoped, never grounded, runner-owned');
  {
    const ctxPlan: TestPlan = { mission: runtime.executionScope, title: 'create + cross-check', steps: [
      { action: 'FILL', target: 'Search', value: 'acme' },
      { assert: 'URL_MATCHES', target: 'page url', value: 'appId=app9' },
      { assert: 'HAS_STATUS', target: 'status toast', value: 'saved successfully' },
      { assert: 'EMPTY_STATE', target: 'grid', value: 'No records found' },
      { assert: 'ERROR_STATE', target: 'form', value: 'Name is required' },
      { assert: 'ROW_IN_LIST', target: 'not-a-catalog-name', value: 'Acme Corp' },
      { assert: 'FOUND_IN_GLOBAL_SEARCH', target: 'search', value: 'Acme Corp' },
    ] };
    const rc = playwrightCompiler.compile({ mission: runtime, plan: ctxPlan, evidenceGraph: graph, run });
    ok(rc.ok, `context asserts compile clean without grounding (diags: ${JSON.stringify(rc.diagnostics.map((d) => d.kind))})`);
    ok(rc.code.includes('await runner.expectUrl("appId=app9");'), 'URL_MATCHES → runner.expectUrl');
    ok(rc.code.includes('await runner.expectStatusRegion("saved successfully");'), 'HAS_STATUS → runner.expectStatusRegion');
    ok(rc.code.includes('await runner.expectEmptyState("No records found");'), 'EMPTY_STATE → runner.expectEmptyState');
    ok(rc.code.includes('await runner.expectErrorState("Name is required");'), 'ERROR_STATE → runner.expectErrorState');
    ok(rc.code.includes('await runner.expectRowInList("Acme Corp");'), 'ROW_IN_LIST → runner.expectRowInList');
    ok(rc.code.includes('await runner.searchGlobalFor("Acme Corp");'), 'FOUND_IN_GLOBAL_SEARCH → runner.searchGlobalFor');
    const gate2 = validateCompiledOutput(rc.code);
    ok(gate2.ok, 'context-assert spec passes the prohibited-pattern gate');

    // Value threading: a generated fill value must thread into the later row/search expectations.
    const threadPlan: TestPlan = { mission: runtime.executionScope, title: 'create app', steps: [
      { action: 'FILL', target: 'Label *', value: 'unique_label' },
      { assert: 'ROW_IN_LIST', target: 'apps list', value: 'unique_label' },
    ] };
    const rt = playwrightCompiler.compile({ mission: runtime, plan: threadPlan, evidenceGraph: graph, run });
    const fillM = /runner\.fill\(\{[^}]*create-app-label[^}]*\}, ("[^"]+")\)/.exec(rt.code);
    const rowM = /runner\.expectRowInList\(("[^"]+")\)/.exec(rt.code);
    ok(!!fillM && !!rowM && fillM[1] === rowM[1], `ROW_IN_LIST expects the ENGINE-RESOLVED value (${fillM?.[1]} vs ${rowM?.[1]})`);
  }

  console.log('real VERIFY_* expansions (Phase 4)');
  {
    const vPlan: TestPlan = { mission: runtime.executionScope, title: 'grid checks', steps: [
      { assert: 'VERIFY_TABLE', target: 'New', value: '' },
      { assert: 'VERIFY_FILTER', target: 'New', value: 'acme' },
      { assert: 'VERIFY_SORT', target: 'New', value: 'asc' },
      { assert: 'VERIFY_VALIDATION', target: 'Label *', value: 'required' },
      { assert: 'VERIFY_ERROR', target: 'New', value: 'Something went wrong' },
      { assert: 'VERIFY_PAGINATION', target: 'New' },
    ] };
    const rv = playwrightCompiler.compile({ mission: runtime, plan: vPlan, evidenceGraph: graph, run });
    ok(rv.ok, 'VERIFY plan compiles');
    ok(rv.code.includes('await runner.expectTable('), 'VERIFY_TABLE → expectTable');
    ok(rv.code.includes('await runner.expectFiltered('), 'VERIFY_FILTER → expectFiltered');
    ok(rv.code.includes('await runner.expectSorted('), 'VERIFY_SORT → expectSorted');
    ok(rv.code.includes('await runner.expectValidation('), 'VERIFY_VALIDATION → expectValidation');
    ok(rv.code.includes('await runner.expectErrorState("Something went wrong");'), 'VERIFY_ERROR → expectErrorState');
    ok(rv.code.includes('await runner.expectVisible('), 'VERIFY_PAGINATION stays a visibility assertion');
    ok(validateCompiledOutput(rv.code).ok, 'VERIFY expansions pass the gate');
  }

  console.log('MissionRunner template exposes every Phase 4 helper');
  {
    const src = MISSION_RUNNER_SOURCE;
    for (const helper of ['expectUrl', 'expectStatusRegion', 'expectEmptyState', 'expectErrorState', 'expectRowInList', 'searchGlobalFor', 'expectTable', 'expectFiltered', 'expectSorted', 'expectValidation']) {
      ok(src.includes(`async ${helper}(`), `runner has ${helper}()`);
    }
  }

  console.log('P6 catalogTargetIssues: an invented target is flagged; catalog names + advisory targets are not');
  {
    // 'New' and 'Search' are real catalog controls; 'Nonexistent Widget' is not.
    const good: TestPlan = { mission: runtime.executionScope, steps: [
      { action: 'OPEN_MODULE', target: 'anything-advisory' },   // advisory → never validated
      { action: 'CLICK', target: 'New' },                        // real catalog control
      { assert: 'ROW_IN_LIST', target: 'not-a-catalog-name', value: 'x' }, // context assert → advisory
    ] };
    eq(catalogTargetIssues(good, graph), [], 'no issues for catalog + advisory targets');
    const bad: TestPlan = { mission: runtime.executionScope, steps: [
      { action: 'CLICK', target: 'New' },
      { action: 'FILL', target: 'Nonexistent Widget', value: 'x' }, // invented → flagged
    ] };
    const issues = catalogTargetIssues(bad, graph);
    ok(issues.length === 1 && /Nonexistent Widget/.test(issues[0]), 'an invented, non-catalog target is flagged for repair');
    eq(catalogTargetIssues(bad, null), [], 'no graph → no issues (never blocks when the catalog is absent)');
  }

  console.log('HAS_VALUE on a checkbox → expectChecked (not toHaveValue, which always fails on a checkbox)');
  {
    const cbRun: any = { id: 'run-cb', selector_registry: { verified_selectors: [
      vs('cb', 'checkbox', 'system_admin', 'tr:has-text("system_admin") input[type="checkbox"]', 'row-key'),
      vs('tb', 'textbox', 'Search', '#search', 'css'),
    ] } };
    const cbGraph = buildEvidenceGraphFromRun(cbRun, { platform: 'Admin', module: 'roles' });
    const cbPlan: TestPlan = { mission: runtime.executionScope, title: 'select row', steps: [
      { action: 'CHECK', target: 'system_admin' },
      { assert: 'HAS_VALUE', target: 'system_admin', value: 'true' },
    ] };
    const rcb = playwrightCompiler.compile({ mission: runtime, plan: cbPlan, evidenceGraph: cbGraph, run: cbRun });
    ok(rcb.ok, 'checkbox plan compiles');
    ok(rcb.code.includes('runner.expectChecked('), 'HAS_VALUE on a checkbox emits expectChecked');
    ok(!/expectValue\([^)]*checkbox|expectValue\([^)]*system_admin/.test(rcb.code), 'never emits expectValue (toHaveValue) for the checkbox');
    // A textbox HAS_VALUE still uses expectValue (unchanged).
    const tbPlan: TestPlan = { mission: runtime.executionScope, title: 'search value', steps: [
      { action: 'FILL', target: 'Search', value: 'acme' },
      { assert: 'HAS_VALUE', target: 'Search', value: 'acme' },
    ] };
    const rtb = playwrightCompiler.compile({ mission: runtime, plan: tbPlan, evidenceGraph: cbGraph, run: cbRun });
    ok(rtb.code.includes('runner.expectValue('), 'a textbox HAS_VALUE still uses expectValue');
  }

  console.log('CHECKED/UNCHECKED verb → expectChecked; role↔assert gate drops HAS_VALUE on a non-text role');
  {
    const g2Run: any = { id: 'run-g2', selector_registry: { verified_selectors: [
      vs('cb2', 'checkbox', 'system_admin', 'tr:has-text("system_admin") input[type="checkbox"]', 'row-key'),
      vs('hd2', 'heading', 'Apps', 'role=heading[name="Apps"]', 'role'),
    ] } };
    const g2 = buildEvidenceGraphFromRun(g2Run, { platform: 'Admin', module: 'apps' });
    // CHECKED verb compiles to expectChecked.
    const chk: TestPlan = { mission: runtime.executionScope, title: 'checked', steps: [{ assert: 'CHECKED', target: 'system_admin' }] };
    const rchk = playwrightCompiler.compile({ mission: runtime, plan: chk, evidenceGraph: g2, run: g2Run });
    ok(rchk.ok && rchk.code.includes('runner.expectChecked('), 'CHECKED verb compiles to expectChecked');
    // HAS_VALUE on a heading is role-incompatible → skippable diagnostic, never emitted.
    const badAssert: TestPlan = { mission: runtime.executionScope, title: 'bad', steps: [
      { assert: 'VISIBLE', target: 'Apps' },
      { assert: 'HAS_VALUE', target: 'Apps', value: 'x' },
    ] };
    const rba = playwrightCompiler.compile({ mission: runtime, plan: badAssert, evidenceGraph: g2, run: g2Run });
    ok(rba.ok, 'the case still ships (the bad assert is skippable)');
    ok(rba.diagnostics.some((d) => d.kind === 'INVALID_STEP' && d.severity === 'skippable'), 'HAS_VALUE on a heading is flagged skippable');
    ok(!/expectValue\([^)]*heading|expectValue\([^)]*Apps/.test(rba.code), 'toHaveValue is never emitted for the heading');
    ok(rba.code.includes('runner.expectVisible('), 'the compatible VISIBLE assert on the heading still emits');
  }

  console.log('State-model: form-tagged controls are grouped in the catalog + the opener is injected before them');
  {
    const smRun: any = { id: 'run-sm', selector_registry: { verified_selectors: [
      vs('new', 'button', 'New', '[data-testid="new"]', 'testid'),        // page opener
      vs('grid', 'columnheader', 'Label', 'role=columnheader[name="Label"]', 'role'), // page control
      { ...vs('flabel', 'textbox', 'App Label *', '#app-label', 'css'), stateTag: 'form' },     // modal field
      { ...vs('fhead', 'heading', 'New App', 'role=heading[name="New App"]', 'role'), stateTag: 'form' }, // modal heading
    ] } };
    const smGraph = buildEvidenceGraphFromRun(smRun, { platform: 'Admin', module: 'apps' });
    // Catalog groups page vs form controls.
    const cat = renderTargetCatalogForPrompt(smGraph);
    ok(/PAGE \/ LIST CONTROLS/.test(cat) && /CREATE\/EDIT FORM/.test(cat), 'catalog splits page controls from form controls');
    ok(cat.indexOf('New App') > cat.indexOf('CREATE/EDIT FORM'), 'the modal heading is listed under the form section');
    // Plan asserts the modal heading first — the compiler must inject the New opener BEFORE it.
    const smPlan: TestPlan = { mission: runtime.executionScope, title: 'create form opens', steps: [
      { assert: 'VISIBLE', target: 'New App' },
    ] };
    const rsm = playwrightCompiler.compile({ mission: runtime, plan: smPlan, evidenceGraph: smGraph, run: smRun });
    ok(rsm.ok, 'form-heading plan compiles');
    const openerAt = rsm.code.indexOf('data-testid');
    const headAt = rsm.code.indexOf('New App');
    ok(openerAt > 0 && headAt > 0 && openerAt < headAt, 'the create opener is injected BEFORE asserting the modal heading (was: heading asserted on the list → not visible)');
  }

  console.log('Negative/validation case: HAS_VALUE → expectValidation (not toHaveValue, which fails on auto-derive/empty)');
  {
    const nvRun: any = { id: 'run-nv', selector_registry: { verified_selectors: [
      vs('lbl', 'textbox', 'Label *', '#lbl', 'css'),
      vs('api', 'textbox', 'API Name *', '#api', 'css'),
    ] } };
    const nvGraph = buildEvidenceGraphFromRun(nvRun, { platform: 'Admin', module: 'apps' });
    // Negative title: "API Name is required to create an App" → HAS_VALUE becomes a validation check.
    const neg: TestPlan = { mission: runtime.executionScope, title: 'API Name is required to create an App', steps: [
      { action: 'CLICK', target: 'Create' as any },
      { assert: 'HAS_VALUE', target: 'API Name *', value: 'something' },
    ] };
    // No Create control in the catalog → the CLICK is unresolved (skippable), but the assert still compiles.
    const rneg = playwrightCompiler.compile({ mission: runtime, plan: neg, evidenceGraph: nvGraph, run: nvRun });
    ok(rneg.code.includes('runner.expectValidation('), 'negative-case HAS_VALUE compiles to expectValidation');
    ok(!/expectValue\([^)]*#api/.test(rneg.code), 'negative case never emits toHaveValue on the field');
    // Positive create title with "required fields" is NOT negative → HAS_VALUE stays a value check.
    const pos: TestPlan = { mission: runtime.executionScope, title: 'App is created with all required fields', steps: [
      { action: 'FILL', target: 'Label *', value: 'x' },
      { assert: 'HAS_VALUE', target: 'Label *', value: 'x' },
    ] };
    const rpos = playwrightCompiler.compile({ mission: runtime, plan: pos, evidenceGraph: nvGraph, run: nvRun });
    ok(rpos.code.includes('runner.expectValue('), 'positive "with required fields" case keeps expectValue');
    ok(!rpos.code.includes('expectValidation('), 'positive case is not treated as a validation case');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
