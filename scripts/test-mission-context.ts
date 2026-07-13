/**
 * MissionContext tests (Phase 1 + Phase 2 shape). Proves the domain invariants that must be impossible.
 *   npx tsx scripts/test-mission-context.ts   (npm run test:mission)
 */
import {
  buildMissionContext, missionContextFromRun, withModule, isMissionExecutable,
  platformTypeFromSurface, runtimeSurfaceFromSurface, moduleFromUrl, describeMission, stripAppScopedParams,
  buildMissionVerificationSnippet, renderMissionContextForPrompt, collapseDoubledLabels,
  finalizeMissionFromInspectedSurface, needsExplicitListViewModule, sameMissionEvidenceScope,
} from '../server/features/agent/mission/missionContext';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

console.log('ADMIN: no application, no appId in URL');
{
  const mc = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/', application: { id: 'app123', name: 'X' } as any, module: { id: 'objects', name: 'Objects' } });
  eq(mc.platformType, 'ADMIN', 'platformType ADMIN');
  eq(mc.runtimeSurface, null, 'ADMIN runtimeSurface null');
  eq(mc.application, null, 'ADMIN application ALWAYS null (even when passed)');
  ok(!mc.targetUrl.includes('appId'), 'ADMIN targetUrl has NO appId');
  ok(mc.targetUrl.includes('nav=objects'), 'ADMIN targetUrl carries module nav');
  eq(mc.executionScope, 'ADMIN/objects', 'ADMIN executionScope');
  ok(isMissionExecutable(mc), 'ADMIN executable without an application');
}

console.log('RUNTIME: requires application; appId + runtimeSurface');
{
  const mc = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/', runtimeSurface: 'keystone', application: { id: 'app21vhj4w', name: 'CRM' }, module: { id: 'accounts', name: 'Account' } });
  eq(mc.platformType, 'RUNTIME', 'platformType RUNTIME');
  eq(mc.runtimeSurface, 'keystone', 'runtimeSurface preserved');
  eq(mc.application, { id: 'app21vhj4w', name: 'CRM' }, 'application {id,name} preserved');
  ok(mc.targetUrl.includes('appId=app21vhj4w') && mc.targetUrl.includes('nav=accounts'), 'RUNTIME targetUrl carries appId + module');
  eq(mc.executionScope, 'RUNTIME/keystone/CRM/accounts', 'RUNTIME executionScope');
  ok(isMissionExecutable(mc), 'RUNTIME with application is executable');
}

console.log('RUNTIME without application: not executable');
{
  const mc = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/', runtimeSurface: 'keystone', module: { id: 'accounts', name: 'Account' } });
  eq(mc.application, null, 'no application → null');
  ok(!isMissionExecutable(mc), 'RUNTIME without application is NOT executable');
  ok(mc.executionScope.includes('UNRESOLVED_APPLICATION'), 'scope flags unresolved application');
  ok(!mc.targetUrl.includes('appId'), 'no appId when unresolved');
}

console.log('Extended shape: platform label + tab (Phase 1)');
{
  const admin = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/', module: { id: 'objects', name: 'Objects' } });
  eq(admin.platform, 'Admin', 'ADMIN default platform label');
  eq(admin.tab, null, 'ADMIN tab null by default');

  const ks = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/', runtimeSurface: 'keystone', application: { id: 'app9', name: 'CRM' } });
  eq(ks.platform, 'Keystone', 'RUNTIME keystone → platform "Keystone"');

  const explicit = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/shockwave/', runtimeSurface: 'shockwave', platform: 'Shockwave Prod', application: { id: 'app9', name: 'CRM' } });
  eq(explicit.platform, 'Shockwave Prod', 'explicit platform label respected');

  const withTab = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/', runtimeSurface: 'keystone', application: { id: 'app9', name: 'CRM' }, module: { id: 'accounts', name: 'Account' }, tab: { id: 'details', name: 'Details' } });
  eq(withTab.tab, { id: 'details', name: 'Details' }, 'tab {id,name} preserved');
  eq(withTab.executionScope, 'RUNTIME/keystone/CRM/accounts/details', 'tab appended to executionScope');
  ok(describeMission(withTab).endsWith('→ Details'), 'describeMission includes tab');

  const remoduled = withModule(withTab, { id: 'opportunity', name: 'Opportunity' });
  eq(remoduled.tab, null, 'withModule resets tab (tabs are module-scoped)');
  eq(remoduled.platform, 'Keystone', 'withModule preserves platform label');
}

console.log('Immutability + immutable navigation');
{
  const mc = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/' });
  ok(Object.isFrozen(mc), 'frozen');
  try { (mc as any).platformType = 'RUNTIME'; } catch { /* strict throws */ }
  eq(mc.platformType, 'ADMIN', 'cannot mutate platformType');
  const rt = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/', runtimeSurface: 'keystone', application: { id: 'app1', name: 'CRM' }, module: { id: 'accounts', name: 'Account' } });
  const rt2 = withModule(rt, { id: 'opportunity', name: 'Opportunity' });
  ok(rt2 !== rt && Object.isFrozen(rt2), 'withModule → new frozen context');
  eq(rt.module?.id, 'accounts', 'original module unchanged');
  eq(rt2.module?.id, 'opportunity', 'new module applied');
  eq(rt2.application?.id, 'app1', 'application preserved across module change');
  eq(rt2.runtimeSurface, 'keystone', 'runtimeSurface preserved across module change');
  ok(rt2.targetUrl.includes('appId=app1') && rt2.targetUrl.includes('nav=opportunity'), 'new targetUrl keeps app, swaps nav');
}

console.log('Helpers');
{
  eq(platformTypeFromSurface('Admin App', 'https://host/admin-ui/'), 'ADMIN', 'platformType admin');
  eq(platformTypeFromSurface('Keystone', 'https://host/keystone/'), 'RUNTIME', 'platformType keystone→RUNTIME');
  eq(runtimeSurfaceFromSurface('Keystone', 'https://host/keystone/'), 'keystone', 'runtimeSurface keystone');
  eq(runtimeSurfaceFromSurface('Shockwave', 'https://host/shockwave/'), 'shockwave', 'runtimeSurface shockwave');
  eq(moduleFromUrl('https://host/admin-ui/?nav=users&appId=x'), 'users', 'moduleFromUrl');
  ok(!stripAppScopedParams('https://host/admin-ui/?appId=x&nav=y&object=z').match(/appId|nav|object/), 'stripAppScopedParams');
}

console.log('Backward-compatible mapper from run');
{
  const adminRun = { app_url: 'https://host/admin-ui/?nav=objects&appId=leaked', application_context: { app: { name: 'Admin App' } } };
  const amc = missionContextFromRun(adminRun);
  eq(amc.platformType, 'ADMIN', 'mapper: admin surface → ADMIN');
  eq(amc.application, null, 'mapper: admin has null application even if URL leaked an appId');
  ok(!amc.targetUrl.includes('leaked'), 'mapper: admin targetUrl strips the leaked appId');
  eq(amc.module?.id, 'objects', 'mapper: module from url');

  const runtimeRun = { app_url: 'https://host/keystone/?nav=accounts&appId=app9', target_core_app_id: 'app9', target_app_label: 'CRM', appName: 'Keystone' };
  const rmc = missionContextFromRun(runtimeRun);
  eq(rmc.platformType, 'RUNTIME', 'mapper: keystone → RUNTIME');
  eq(rmc.runtimeSurface, 'keystone', 'mapper: runtimeSurface keystone');
  eq(rmc.application, { id: 'app9', name: 'CRM' }, 'mapper: runtime application from target_core_app_id');
  ok(describeMission(rmc).startsWith('Runtime (keystone) → CRM'), 'describeMission runtime');
}

console.log('Phase 3: mission verification snippet');
{
  const admin = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/', module: { id: 'apps', name: 'Apps' } });
  const sAdmin = buildMissionVerificationSnippet(admin);
  ok(sAdmin.includes('MISSION VERIFICATION'), 'admin snippet present');
  ok(sAdmin.includes('"surfacePath":"/admin-ui"'), 'admin verified by surface path (admin-ui), not appId absence');
  ok(sAdmin.includes('"enforceAppId":false'), 'admin does NOT pin an appId (admin-ui self-assigns its own)');
  ok(sAdmin.includes('"nav":"apps"'), 'admin enforces module nav');
  ok(sAdmin.includes('page.goto("https://host/admin-ui/?nav=apps")'), 'admin snippet recovers to mission URL');
  ok(sAdmin.includes('throw new Error'), 'admin snippet aborts on mismatch');

  const rt = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/', runtimeSurface: 'keystone', application: { id: 'app9', name: 'CRM' }, module: { id: 'accounts', name: 'Account' } });
  const sRt = buildMissionVerificationSnippet(rt);
  ok(sRt.includes('"enforceAppId":true') && sRt.includes('"appId":"app9"'), 'runtime enforces exact appId');
  ok(sRt.includes('"nav":"accounts"'), 'runtime enforces module');

  // Nothing enforceable → empty snippet (backward compat: legacy runs untouched).
  const bare = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/' });
  eq(buildMissionVerificationSnippet(bare), '', 'runtime with no app + no module → empty snippet');
  eq(buildMissionVerificationSnippet(null), '', 'null mission → empty snippet');
}

console.log('Phase 4: script generator (mission prompt + locator guard)');
{
  const admin = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/', module: { id: 'apps', name: 'Apps' } });
  const pAdmin = renderMissionContextForPrompt(admin);
  ok(pAdmin.includes('Platform: ADMIN') && pAdmin.includes('Application: NONE'), 'admin prompt: platform + no application');
  ok(pAdmin.includes('never infer application/tab/module/page from the prompt') || pAdmin.includes('NEVER infer application/tab/module/page from the prompt'), 'admin prompt: navigation authority rule');
  ok(pAdmin.includes('App1app1'), 'admin prompt forbids concatenation example');

  const rt = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/', runtimeSurface: 'keystone', application: { id: 'app9', name: 'CRM' }, module: { id: 'accounts', name: 'Account' } });
  const pRt = renderMissionContextForPrompt(rt);
  ok(pRt.includes('Platform: RUNTIME') && pRt.includes('appId app9'), 'runtime prompt: platform + appId');
  ok(pRt.includes('Runtime deployment: keystone'), 'runtime prompt: deployment');
  eq(renderMissionContextForPrompt(null), '', 'null mission → empty prompt block');

  // Locator guard: exact-double concatenation collapsed; legitimate names untouched.
  const r1 = collapseDoubledLabels(`await page.getByRole('button', { name: 'App1app1' }).click();`);
  ok(r1.code.includes("name: 'App1'") && r1.fixes === 1, 'collapse App1app1 → App1');
  const r2 = collapseDoubledLabels(`await page.getByText('AccountsAccounts').click();`);
  ok(r2.code.includes("getByText('Accounts')"), 'collapse getByText doubled → single');
  const r3 = collapseDoubledLabels(`await page.getByRole('link', { name: 'Revenue Hub' }).click();`);
  eq(r3.fixes, 0, 'legitimate name "Revenue Hub" is NOT altered');
}

console.log('Phase 1 (Surface-Consistency Invariant): seal mission from inspected surface');
{
  const throws = (fn: () => unknown, n: string) => { try { fn(); ok(false, `${n} (expected throw)`); } catch { ok(true, n); } };

  // ADMIN module-null enriched from the surface discovery actually landed on (the core bug).
  const bareAdmin = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/' });
  eq(bareAdmin.module, null, 'ADMIN provisional mission starts module-null');
  const sealed = finalizeMissionFromInspectedSurface(bareAdmin, 'https://host/admin-ui/?nav=objects&appId=app21vhj4w');
  ok(sealed !== bareAdmin && Object.isFrozen(sealed), 'seal → new frozen mission');
  eq(sealed.module?.id, 'objects', 'ADMIN module enriched to inspected nav=objects');
  eq(sealed.executionScope, 'ADMIN/objects', 'sealed executionScope carries the module');
  ok(sealed.targetUrl.includes('nav=objects'), 'sealed targetUrl carries nav=objects');
  ok(!sealed.targetUrl.includes('appId'), 'ADMIN self-assigned appId NOT copied into the sealed targetUrl');

  // Existing/explicit module + matching nav → unchanged (same object).
  const adminObjects = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/', module: { id: 'objects', name: 'Objects' } });
  ok(finalizeMissionFromInspectedSurface(adminObjects, 'https://host/admin-ui/?nav=objects') === adminObjects, 'matching module+nav → unchanged mission');

  // Explicit module vs conflicting inspected nav → hard error, before any graph/compiler work.
  throws(() => finalizeMissionFromInspectedSurface(adminObjects, 'https://host/admin-ui/?nav=users'), 'explicit module vs inspected-nav conflict throws');

  // Wrong surface (path) → hard error.
  throws(() => finalizeMissionFromInspectedSurface(bareAdmin, 'https://host/keystone/?nav=accounts'), 'wrong surface path throws');

  // RUNTIME real app: inspected appId must match; a different appId → hard error.
  const rt = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/', runtimeSurface: 'keystone', application: { id: 'app9', name: 'CRM' }, module: { id: 'accounts', name: 'Account' } });
  ok(finalizeMissionFromInspectedSurface(rt, 'https://host/keystone/?appId=app9&nav=accounts') === rt, 'runtime matching appId+nav → unchanged');
  throws(() => finalizeMissionFromInspectedSurface(rt, 'https://host/keystone/?appId=appOTHER&nav=accounts'), 'runtime appId mismatch throws');

  // No inspected nav, module-null → unchanged (nothing to seal); unparseable/empty inputs are no-ops.
  const bareRt = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://host/keystone/', runtimeSurface: 'keystone', application: { id: 'app9', name: 'CRM' } });
  // bareRt defaults to no module; inspected URL has no nav → unchanged.
  ok(finalizeMissionFromInspectedSurface(bareRt, 'https://host/keystone/?appId=app9') === bareRt, 'no inspected nav → unchanged');
  ok(finalizeMissionFromInspectedSurface(bareAdmin, '') === bareAdmin, 'empty inspected url → no-op');
  ok(finalizeMissionFromInspectedSurface(bareAdmin, 'not a url') === bareAdmin, 'unparseable inspected url → no-op');
}

console.log('List-view routing and evidence reuse');
{
  ok(needsExplicitListViewModule('write test cases for list view'), 'generic list view requires a module');
  ok(needsExplicitListViewModule('test list view'), 'bare test-list-view request requires a module');
  ok(!needsExplicitListViewModule('write test cases for the Roles list view'), 'named list view is scoped');
  ok(!needsExplicitListViewModule('test the list view', 'apps'), 'explicit module selection is scoped');

  const roles = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/', module: { id: 'roles', name: 'Roles' } });
  const apps = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/', module: { id: 'apps', name: 'Apps' } });
  ok(sameMissionEvidenceScope(roles, roles), 'same mission may reuse DOM evidence');
  ok(!sameMissionEvidenceScope(roles, apps), 'different module cannot reuse DOM evidence');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
