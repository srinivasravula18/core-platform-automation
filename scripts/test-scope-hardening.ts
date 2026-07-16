/**
 * Phase 1 — Mission-scope hardening tests. Proves:
 *   1. isMutationIntent detects data-mutating goals (and leaves read-only checks alone).
 *   2. The Test Data Engine treats reserved sentinels / template placeholders as leads, never fill values.
 *   3. The compiler derives mutationIntent deterministically from the plan and emits it in MISSION.
 *   npx tsx scripts/test-scope-hardening.ts   (npm run test:scope-hardening)
 */
import { isMutationIntent, ALL_APPS_ID } from '../server/features/agent/appTargeting';
import { TestDataEngine } from '../server/features/agent/testdata';
import { buildMissionContext } from '../server/features/agent/mission/missionContext';
import { buildEvidenceGraphFromRun } from '../server/features/agent/graph/evidenceGraph';
import { playwrightCompiler } from '../server/features/agent/compiler/playwrightCompiler';
import type { TestPlan } from '../server/features/agent/compiler/testPlan';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

function main() {
  console.log('isMutationIntent: data-mutating goals detected');
  ok(isMutationIntent('Create 2 test cases that create a new account'), 'create');
  ok(isMutationIntent('update the customer phone number'), 'update');
  ok(isMutationIntent('delete an existing vendor record'), 'delete');
  ok(isMutationIntent('edit the profile and save'), 'edit/save');
  ok(isMutationIntent('register a new user'), 'register');
  ok(isMutationIntent('Fill the form and submit it'), 'submit');

  console.log('isMutationIntent: read-only goals stay read-only');
  ok(!isMutationIntent('verify the list view loads'), 'verify list');
  ok(!isMutationIntent('check sorting on the accounts grid'), 'check sorting');
  ok(!isMutationIntent('test pagination and filters on the list view'), 'pagination/filters');
  ok(!isMutationIntent('view the dashboard and count the widgets'), 'view dashboard');
  ok(!isMutationIntent('search for records across the grid'), 'search');

  console.log('Test Data Engine: reserved sentinels and template placeholders are leads, not values');
  const engine = new TestDataEngine('scope-hardening-seed');
  const sem = { label: 'Account Name', role: 'textbox' };
  ok(engine.fillValue(sem, '__all_apps__') !== '__all_apps__', '__sentinel__ replaced');
  ok(engine.fillValue(sem, '{{account_name}}') !== '{{account_name}}', '{{template}} replaced');
  ok(engine.fillValue(sem, '<enter value>') !== '<enter value>', '<angle placeholder> replaced');
  ok(engine.fillValue(sem, 'reserved') !== 'reserved', '"reserved" replaced');
  ok(engine.fillValue(sem, 'TBD') !== 'TBD', '"TBD" replaced');
  ok(engine.fillValue(sem, 'change me') !== 'change me', '"change me" replaced');
  ok(engine.fillValue(sem, 'your company') !== 'your company', '"your …" replaced');
  ok(engine.fillValue(sem, 'Acme Corporation') === 'Acme Corporation', 'meaningful value KEPT verbatim');

  console.log('compiler: mutationIntent derived from the plan (field-set + submit click), emitted in MISSION');
  const vs = (id: string, role: string, label: string, selector: string, selectorType: string) => ({
    id, elementType: role, role, label, selector, selectorType, verified: true,
    verificationStatus: 'verified', confidence: 'verified-live',
    provenance: 'LIVE_DOM', visibility: true, uniqueness: true, sourceEvidenceId: 'dom', fallbackSelector: null,
  });
  const run: any = { id: 'run-scope', selector_registry: { verified_selectors: [
    vs('s_name', 'textbox', 'Name *', '#name', 'css'),
    vs('s_create', 'button', 'Create', '[data-testid="create"]', 'testid'),
    vs('s_grid', 'button', 'Refresh', '#refresh', 'css'),
  ] } };
  const graph = buildEvidenceGraphFromRun(run, { platform: 'Keystone', application: 'CRM', module: 'accounts' });
  const mission = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://h/keystone/', runtimeSurface: 'keystone', application: { id: 'app9', name: 'CRM' }, module: { id: 'accounts', name: 'Account' } });

  const mutationPlan: TestPlan = { mission: mission.executionScope, title: 'create account', steps: [
    { action: 'FILL', target: 'Name *', value: 'x' },
    { action: 'CLICK', target: 'Create' },
  ] };
  const rMut = playwrightCompiler.compile({ mission, plan: mutationPlan, evidenceGraph: graph, run });
  ok(rMut.ok, 'mutation plan compiles');
  ok(rMut.code.includes('"mutationIntent":true'), 'fill + submit click → mutationIntent:true');

  const readOnlyPlan: TestPlan = { mission: mission.executionScope, title: 'grid check', steps: [
    { action: 'CLICK', target: 'Refresh' },
    { assert: 'VISIBLE', target: 'Create' },
  ] };
  const rRead = playwrightCompiler.compile({ mission, plan: readOnlyPlan, evidenceGraph: graph, run });
  ok(rRead.ok, 'read-only plan compiles');
  ok(rRead.code.includes('"mutationIntent":false'), 'no field-set → mutationIntent:false');

  // Filling a search box without a submit click is NOT a mutation (read-only sweeps keep working).
  const fillNoSubmit: TestPlan = { mission: mission.executionScope, title: 'filter grid', steps: [
    { action: 'FILL', target: 'Name *', value: 'acme' },
    { action: 'CLICK', target: 'Refresh' },
  ] };
  const rFilter = playwrightCompiler.compile({ mission, plan: fillNoSubmit, evidenceGraph: graph, run });
  ok(rFilter.code.includes('"mutationIntent":false'), 'fill WITHOUT a submit-intent click → mutationIntent:false');

  console.log('all-apps mutation pairing: the runner receives the exact pair verify() rejects');
  const allAppsMission = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://h/keystone/', runtimeSurface: 'keystone', application: { id: ALL_APPS_ID, name: 'All apps' }, module: { id: 'accounts', name: 'Account' } });
  const rAll = playwrightCompiler.compile({ mission: allAppsMission, plan: mutationPlan, evidenceGraph: graph, run });
  ok(rAll.code.includes(`"${ALL_APPS_ID}"`) && rAll.code.includes('"mutationIntent":true'),
    'compiled MISSION carries __all_apps__ + mutationIntent:true — runner verify() throws MISSION SCOPE VIOLATION');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
