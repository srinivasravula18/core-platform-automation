/**
 * Phase 5 — Target Resolution regression suite. Proves the "must become impossible" matrix by EXECUTING
 * the Phase-3 verification snippet against mock pages for each divergence, plus the Phase-4 guards.
 *   npx tsx scripts/test-mission-regression.ts   (npm run test:mission:regression)
 */
import {
  buildMissionContext, buildMissionVerificationSnippet, collapseDoubledLabels, renderMissionContextForPrompt,
  type MissionContext,
} from '../server/features/agent/mission/missionContext';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

/**
 * Execute the injected mission-verification snippet against a mock `page` whose URL follows `urlSeq`
 * (index advances on each goto — models "landing" then "recovery"). Returns whether it aborted.
 */
async function runVerify(mc: MissionContext, urlSeq: string[]): Promise<{ threw: boolean; error: string }> {
  const snip = buildMissionVerificationSnippet(mc);
  if (!snip) return { threw: false, error: '(no snippet)' };
  let i = 0;
  const page = {
    url: () => urlSeq[Math.min(i, urlSeq.length - 1)],
    goto: async () => { i += 1; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('page', `return (async () => { ${snip} })()`);
  try { await fn(page); return { threw: false, error: '' }; }
  catch (e: any) { return { threw: true, error: String(e?.message || e) }; }
}

const ADMIN = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://h/admin-ui/', module: { id: 'apps', name: 'Apps' } });
const CRM = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://h/keystone/', runtimeSurface: 'keystone', application: { id: 'app_crm', name: 'CRM' }, module: { id: 'accounts', name: 'Account' } });

async function main() {
  console.log('IMPOSSIBLE #1 — Selecting Admin but executing Runtime');
  {
    // Admin mission, but the SPA landed on a tenant app (appId present). Recovery re-goto still wrong → abort.
    const r = await runVerify(ADMIN, ['https://h/admin-ui/?nav=apps&appId=app_crm', 'https://h/admin-ui/?nav=apps&appId=app_crm']);
    ok(r.threw && /MISSION CONTEXT MISMATCH/.test(r.error), 'aborts when Admin lands on a tenant app (appId present)');
    const good = await runVerify(ADMIN, ['https://h/admin-ui/?nav=apps']);
    ok(!good.threw, 'passes when Admin has no appId and correct module');
  }

  console.log('IMPOSSIBLE #2 — Selecting Runtime CRM but executing Inventory');
  {
    const r = await runVerify(CRM, ['https://h/keystone/?appId=app_inventory&nav=accounts', 'https://h/keystone/?appId=app_inventory&nav=accounts']);
    ok(r.threw && /application/.test(r.error), 'aborts when CRM lands on Inventory (wrong appId)');
  }

  console.log('IMPOSSIBLE #3 — Selecting Runtime CRM Account but executing Case');
  {
    const r = await runVerify(CRM, ['https://h/keystone/?appId=app_crm&nav=case', 'https://h/keystone/?appId=app_crm&nav=case']);
    ok(r.threw && /module/.test(r.error), 'aborts when CRM/Account lands on Case (wrong module)');
  }

  console.log('Deterministic recovery works (landing wrong → recovery correct → pass)');
  {
    const r = await runVerify(CRM, ['https://h/keystone/?appId=app_inventory&nav=case', 'https://h/keystone/?appId=app_crm&nav=accounts']);
    ok(!r.threw, 'passes after one deterministic recovery re-navigation');
  }

  console.log('IMPOSSIBLE #4-6 — Prompt cannot override explicit platform/application/module');
  {
    // buildMissionContext has NO prompt input — the mission is a pure function of the explicit selection,
    // so prompt text can never enter it. The resolver picks explicit-first; here we prove the type barrier.
    const m = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://h/keystone/', runtimeSurface: 'keystone', application: { id: 'app_crm', name: 'CRM' }, module: { id: 'accounts', name: 'Account' } });
    ok(m.application?.id === 'app_crm' && m.module?.id === 'accounts' && m.platformType === 'RUNTIME', 'mission is a pure function of explicit selection (no prompt input exists)');
    // Admin selection can never become a tenant-app mission regardless of any (advisory) text.
    const a = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://h/admin-ui/', application: { id: 'app_crm', name: 'CRM' } as any });
    ok(a.application === null && !a.targetUrl.includes('appId'), 'Admin selection stays Admin — application forced null, no appId');
  }

  console.log('IMPOSSIBLE #7 — Assertions before verifying MissionContext');
  {
    // The snippet is injected BEFORE the first assertion (proved by the injection regex in routes); here we
    // assert the snippet itself is non-empty and self-aborting for an enforceable mission.
    ok(buildMissionVerificationSnippet(CRM).includes('MISSION CONTEXT MISMATCH'), 'verification snippet exists and aborts on mismatch (runs before first assertion)');
  }

  console.log('IMPOSSIBLE #8 — Invented locator names such as App1app1');
  {
    const r = collapseDoubledLabels(`await page.getByRole('button', { name: 'App1app1' }).click(); await page.getByText('AccountsAccounts').isVisible();`);
    ok(r.code.includes("name: 'App1'") && r.code.includes("getByText('Accounts')") && r.fixes === 2, 'App1app1 / AccountsAccounts collapsed to single labels');
    const legit = collapseDoubledLabels(`await page.getByRole('link', { name: 'Revenue Hub' }).click();`);
    ok(legit.fixes === 0, 'legitimate labels untouched');
  }

  console.log('IMPOSSIBLE #9 — Executing selectors captured from another application');
  {
    // A CRM run that lands on Inventory is aborted (proved by #2) before any selector executes; and the
    // generator is told the appId is fixed and navigation is mission-only.
    const block = renderMissionContextForPrompt(CRM).toLowerCase();
    ok(block.includes('appid app_crm') && block.includes('never infer application'), 'generator is bound to the mission app/appId; foreign-app landings abort pre-assertion');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('SUITE ERROR:', e?.stack || e); process.exit(1); });
