/**
 * Seed script — populates the database with a realistic dataset on first run
 * so the client demo has something to look at immediately.
 *
 * The seed creates:
 *   - 1 demo website ("Demo App") with 2 users (admin, standard)
 *   - 2 folders (Checkout, Auth)
 *   - 1 test plan
 *   - 2 test suites (Checkout Flow, Auth Flow)
 *   - 6 test cases (3 per suite), some pending review, some approved
 *   - 1 completed run + 1 in-progress run
 *   - 1 defect
 *   - 1 report with a short AI narrative
 *   - 1 Git repository pointing to a local path
 *   - 4 inbox items: 2 pending, 1 approved, 1 rejected
 *
 * Re-running this script is safe — it only seeds when the database is empty.
 */

import { Plans, Suites, Cases, Runs, Defects, Reports, Inbox, isPgEnabled } from './repository';
import { isPostgresEnabled, query, queryOne, uid } from './pool';
import { Activity } from './repository';

export async function runSeedIfEmpty(): Promise<{ seeded: boolean; reason?: string }> {
  if (!isPostgresEnabled()) return { seeded: false, reason: 'postgres disabled' };
  const existing = await queryOne<{ count: string }>('SELECT count(*)::text AS count FROM plans');
  if (existing && Number(existing.count) > 0) return { seeded: false, reason: 'plans already exist' };

  console.log('[seed] empty database, populating demo data…');

  /* ---------- folder (using raw SQL because folders are simple) ---------- */
  const folderCheckout = 'FLD-CHECKOUT';
  const folderAuth = 'FLD-AUTH';
  await query(
    `INSERT INTO folders (id, name, path, description, icon) VALUES
     ($1, 'Checkout', 'Demo App / Checkout', 'End-to-end checkout scenarios', 'shopping-cart'),
     ($2, 'Auth', 'Demo App / Auth', 'Login, logout, password reset', 'shield')
     ON CONFLICT (id) DO NOTHING`,
    [folderCheckout, folderAuth],
  );

  /* ---------- website + users ---------- */
  const websiteId = 'WEB-DEMO';
  await query(
    `INSERT INTO websites (id, name, base_url, environment, description, tags)
     VALUES ($1, 'Demo App', 'https://demo.example.com', 'staging', 'Public demo for the client walkthrough', ARRAY['web','demo'])
     ON CONFLICT (id) DO NOTHING`,
    [websiteId],
  );
  // password is "demo" (encrypted with the dev key)
  const crypto = await import('crypto');
  const encKey = crypto.scryptSync('testflowai-dev-key-do-not-use-in-prod', 'testflowai-salt', 32);
  const encrypt = (plain: string) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${enc.toString('base64')}.${tag.toString('base64')}`;
  };
  await query(
    `INSERT INTO website_users (id, website_id, label, username, password_enc, role, notes) VALUES
     ($1, $2, 'Admin', 'admin@demo.com', $3, 'admin', 'Full access'),
     ($4, $2, 'Standard', 'shopper@demo.com', $5, 'standard', 'Regular shopper')
     ON CONFLICT (id) DO NOTHING`,
    ['USR-DEMO-ADMIN', websiteId, encrypt('admin123'), 'USR-DEMO-SHOPPER', encrypt('shopper123')],
  );

  /* ---------- plan ---------- */
  await Plans.upsert({
    id: 'PLAN-DEMO-Q4',
    name: 'Q4 Release Coverage',
    scope: 'Public storefront checkout and auth flows on the demo app.',
    objectives: 'Cover the new coupon engine, password reset, and one-click checkout.',
    inScope: 'Login, signup, password reset, browse, cart, checkout, coupon apply',
    outOfScope: 'Admin dashboard, internal tools, marketing pages',
    strategy: 'AI-driven coverage with BVT, smoke, and regression tiers; human approves new cases.',
    testTypes: 'Functional, UI, Regression, Smoke',
    environments: 'staging: https://staging.demo.example.com',
    roles: 'QA Lead (review), QA Engineer (execute), AI Assistant (generate)',
    entryExit: 'Entry: build green, seed data loaded. Exit: zero P1 defects, all BVT green.',
    schedule: 'Continuous; regression nightly at 02:00 UTC',
    risks: 'Payment gateway flakiness; new coupon engine untested in load',
    deliverables: 'Coverage report, defect log, AI narrative',
    status: 'Active',
    riskLevel: 'High',
    folderId: folderCheckout,
    approvalState: 'approved',
    proposedBy: 'human',
  });

  /* ---------- suites ---------- */
  await Suites.upsert({
    id: 'SUITE-CHECKOUT',
    name: 'Checkout Flow',
    description: 'End-to-end checkout: cart, address, shipping, payment, confirmation',
    testPlanId: 'PLAN-DEMO-Q4',
    module: 'Checkout',
    owner: 'QA Lead',
    tags: ['@regression', '@critical'],
    priority: 'Critical',
    status: 'Active',
    folderId: folderCheckout,
    approvalState: 'approved',
    proposedBy: 'human',
  });
  await Suites.upsert({
    id: 'SUITE-AUTH',
    name: 'Auth Flow',
    description: 'Sign in, sign up, password reset, logout',
    testPlanId: 'PLAN-DEMO-Q4',
    module: 'Auth',
    owner: 'QA Engineer',
    tags: ['@regression', '@smoke'],
    priority: 'High',
    status: 'Active',
    folderId: folderAuth,
    approvalState: 'approved',
    proposedBy: 'human',
  });

  /* ---------- cases ---------- */
  const cases = [
    {
      id: 'TC-CHECKOUT-1', title: 'Apply valid coupon code', description: 'Apply SAVE10 to cart, verify discount and total.',
      steps: [
        { action: 'Add a $50 item to the cart', expected: 'Cart shows 1 item, subtotal $50.00' },
        { action: 'Enter coupon code SAVE10', expected: 'Discount $5.00 applied, total $45.00' },
        { action: 'Proceed to checkout', expected: 'Discount visible in order summary' },
      ],
      testPlanId: 'PLAN-DEMO-Q4', testSuiteId: 'SUITE-CHECKOUT',
      type: 'Automated', priority: 'High', status: 'Approved', tags: ['@regression', '@coupon'],
      folderId: folderCheckout, confidence: 92, sources: ['SUITE-CHECKOUT'], approvalState: 'approved', proposedBy: 'AI Assistant',
    },
    {
      id: 'TC-CHECKOUT-2', title: 'Reject invalid coupon code', description: 'Enter a non-existent coupon and verify graceful error.',
      steps: [
        { action: 'Add an item to the cart', expected: 'Cart shows 1 item' },
        { action: 'Enter coupon code BOGUS123', expected: 'Error "Coupon not found" shown' },
        { action: 'Remove coupon', expected: 'Discount removed, total returns to original' },
      ],
      testPlanId: 'PLAN-DEMO-Q4', testSuiteId: 'SUITE-CHECKOUT',
      type: 'Automated', priority: 'Medium', status: 'Approved', tags: ['@negative', '@coupon'],
      folderId: folderCheckout, confidence: 88, sources: ['SUITE-CHECKOUT'], approvalState: 'approved', proposedBy: 'AI Assistant',
    },
    {
      id: 'TC-CHECKOUT-3', title: 'Checkout with empty cart', description: 'Verify the checkout button is disabled when the cart is empty.',
      steps: [
        { action: 'Open the storefront with no items in cart', expected: 'Cart icon shows "0"' },
        { action: 'Click the cart icon', expected: 'Empty state message visible' },
        { action: 'Look for the checkout button', expected: 'Checkout button is disabled or hidden' },
      ],
      testPlanId: 'PLAN-DEMO-Q4', testSuiteId: 'SUITE-CHECKOUT',
      type: 'Manual', priority: 'Low', status: 'Pending Review', tags: ['@edge-case'],
      folderId: folderCheckout, confidence: 75, sources: [], approvalState: 'pending_review', proposedBy: 'AI Assistant',
    },
    {
      id: 'TC-AUTH-1', title: 'Sign in with valid credentials', description: 'Standard sign-in path using the demo admin user.',
      steps: [
        { action: 'Open the sign-in page', expected: 'Email and password fields visible' },
        { action: 'Enter admin@demo.com / admin123', expected: 'Fields populated' },
        { action: 'Click "Sign in"', expected: 'Redirected to dashboard' },
      ],
      testPlanId: 'PLAN-DEMO-Q4', testSuiteId: 'SUITE-AUTH',
      type: 'Automated', priority: 'Critical', status: 'Approved', tags: ['@bvt', '@smoke'],
      folderId: folderAuth, confidence: 95, sources: ['SUITE-AUTH', 'WEBSITE-USR-DEMO-ADMIN'], approvalState: 'approved', proposedBy: 'AI Assistant',
    },
    {
      id: 'TC-AUTH-2', title: 'Sign in with wrong password', description: 'Verify error state on invalid password.',
      steps: [
        { action: 'Enter admin@demo.com', expected: 'Field populated' },
        { action: 'Enter wrong password', expected: 'Field populated' },
        { action: 'Click "Sign in"', expected: 'Error "Invalid email or password" shown' },
      ],
      testPlanId: 'PLAN-DEMO-Q4', testSuiteId: 'SUITE-AUTH',
      type: 'Automated', priority: 'High', status: 'Approved', tags: ['@negative', '@auth'],
      folderId: folderAuth, confidence: 90, sources: ['SUITE-AUTH'], approvalState: 'approved', proposedBy: 'AI Assistant',
    },
    {
      id: 'TC-AUTH-3', title: 'Reset password via email link', description: 'Request a reset, open the email link, set a new password.',
      steps: [
        { action: 'Open the password reset page', expected: 'Email field visible' },
        { action: 'Enter admin@demo.com', expected: 'Field populated' },
        { action: 'Click "Send reset link"', expected: '"Check your email" confirmation shown' },
        { action: 'Open the email and click the reset link', expected: 'Reset form opens' },
        { action: 'Enter new password twice and submit', expected: '"Password updated" shown' },
      ],
      testPlanId: 'PLAN-DEMO-Q4', testSuiteId: 'SUITE-AUTH',
      type: 'Manual', priority: 'Medium', status: 'Pending Review', tags: ['@auth', '@manual'],
      folderId: folderAuth, confidence: 70, sources: [], approvalState: 'pending_review', proposedBy: 'AI Assistant',
    },
  ];
  for (const c of cases) await Cases.upsert(c);

  /* ---------- runs ---------- */
  await Runs.upsert({
    id: 'RUN-LAST-NIGHT',
    name: 'Nightly Regression 2026-06-04',
    suiteId: 'SUITE-CHECKOUT',
    testPlanId: 'PLAN-DEMO-Q4',
    caseIds: ['TC-CHECKOUT-1', 'TC-CHECKOUT-2'],
    requestedBy: 'CI',
    executionTime: '4m 12s',
    totalExecutions: 2,
    passed: 1,
    failed: 1,
    progress: '1 of 2 passed',
    status: 'Completed',
    targetUrl: 'https://staging.demo.example.com',
    folderId: folderCheckout,
    steps: [
      { id: 1, name: 'Apply valid coupon code', status: 'passed', duration: 1240 },
      { id: 2, name: 'Reject invalid coupon code', status: 'failed', duration: 980, error: 'Expected "Coupon not found", got "Coupon expired"' },
    ],
    evidence: [],
    triggerType: 'schedule',
    triggerMeta: { cron: '0 2 * * *' },
    startedAt: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
    completedAt: new Date(Date.now() - 8 * 3600 * 1000 + 252 * 1000).toISOString(),
    approvalState: 'approved',
    proposedBy: 'CI',
    date: new Date(Date.now() - 8 * 3600 * 1000).toISOString().split('T')[0],
  });
  await Runs.upsert({
    id: 'RUN-IN-PROGRESS',
    name: 'Smoke on staging (manual)',
    suiteId: 'SUITE-AUTH',
    testPlanId: 'PLAN-DEMO-Q4',
    caseIds: ['TC-AUTH-1', 'TC-AUTH-2'],
    requestedBy: 'QA Engineer',
    executionTime: '...',
    totalExecutions: 2,
    passed: 1,
    failed: 0,
    progress: '1 of 2 passed',
    status: 'Running',
    targetUrl: 'https://staging.demo.example.com',
    folderId: folderAuth,
    steps: [
      { id: 1, name: 'Sign in with valid credentials', status: 'passed', duration: 1100 },
    ],
    evidence: [],
    triggerType: 'manual',
    startedAt: new Date(Date.now() - 600 * 1000).toISOString(),
    approvalState: 'approved',
    proposedBy: 'human',
    date: new Date().toISOString().split('T')[0],
  });

  /* ---------- defect ---------- */
  await Defects.upsert({
    id: 'DEF-COUPON-MSG',
    title: 'Invalid coupon error message is misleading',
    description: 'When a non-existent coupon is entered, the app shows "Coupon expired" instead of "Coupon not found". This confuses users.',
    stepsToReproduce: '1) Add an item to cart. 2) Enter coupon "BOGUS123". 3) Observe error message.',
    expected: '"Coupon not found"',
    actual: '"Coupon expired"',
    severity: 'Medium',
    status: 'New',
    assignedTo: 'unassigned',
    linkedCaseId: 'TC-CHECKOUT-2',
    linkedRunId: 'RUN-LAST-NIGHT',
    evidence: [],
    tags: ['@ui', '@coupon'],
    folderId: folderCheckout,
    approvalState: 'approved',
    proposedBy: 'AI Assistant',
  });

  /* ---------- report with AI narrative ---------- */
  await Reports.upsert({
    id: 'REP-NIGHTLY-1',
    name: 'Nightly Regression 2026-06-04',
    planId: 'PLAN-DEMO-Q4',
    suiteId: 'SUITE-CHECKOUT',
    runId: 'RUN-LAST-NIGHT',
    planName: 'Q4 Release Coverage',
    suiteName: 'Checkout Flow',
    requestedBy: 'CI',
    executionTime: '4m 12s',
    totalExecutions: 2,
    status: 'Failed',
    failureReason: '1 of 2 cases failed (TC-CHECKOUT-2: invalid coupon error message)',
    targetUrl: 'https://staging.demo.example.com',
    steps: [],
    evidence: [],
    narrative:
      'Nightly regression on the Checkout suite passed 1 of 2 cases. The failure is in TC-CHECKOUT-2: the app returns "Coupon expired" for a non-existent coupon code (BOGUS123), but the test expected "Coupon not found". The behaviour is inconsistent with the Auth suite, which returns a specific "Invalid email or password" message on bad input.\n\nSuggested next actions: 1) Triage DEF-COUPON-MSG with the auth team; 2) Add a regression case for the expired-coupon path explicitly; 3) Re-run the suite after the fix to confirm green.',
    folderId: folderCheckout,
    date: new Date(Date.now() - 8 * 3600 * 1000).toISOString().split('T')[0],
  });

  /* ---------- inbox items ---------- */
  await Inbox.push({
    workspaceId: 'default', source: 'case', sourceId: 'TC-CHECKOUT-3',
    title: 'Approve new test case: "Checkout with empty cart"',
    summary: 'AI drafted an edge-case test for the empty-cart checkout flow.',
    confidence: 75, proposedBy: 'AI Assistant',
    payload: { caseId: 'TC-CHECKOUT-3' },
    links: [{ label: 'Open in Test Cases', href: '/cases' }],
  });
  await Inbox.push({
    workspaceId: 'default', source: 'run', sourceId: 'RUN-LAST-NIGHT',
    title: 'Triage failure: "Reject invalid coupon code"',
    summary: 'Run failed because the app returns "Coupon expired" instead of "Coupon not found".',
    confidence: 88, proposedBy: 'AI Assistant',
    payload: { runId: 'RUN-LAST-NIGHT', caseId: 'TC-CHECKOUT-2' },
    links: [{ label: 'Open Run', href: '/runs' }],
  });
  await Inbox.push({
    workspaceId: 'default', source: 'defect', sourceId: 'DEF-COUPON-MSG',
    title: 'Verify defect: "Invalid coupon error message is misleading"',
    summary: 'A defect was filed from the failed run. Verify the fix and re-run TC-CHECKOUT-2.',
    confidence: 82, proposedBy: 'AI Assistant',
    payload: { defectId: 'DEF-COUPON-MSG' },
    links: [{ label: 'Open Defect', href: '/defects' }],
  });

  /* ---------- git repo ---------- */
  await query(
    `INSERT INTO git_repositories (id, name, path, branch, trigger_type, schedule, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    ['GIT-DEMO', 'Demo App', 'D:\\core-platform-automation', 'main', 'webhook', '', true],
  );

  /* ---------- activity ---------- */
  await Activity.push({ actor: 'seed', action: 'seed:plan', target: 'PLAN-DEMO-Q4', detail: 'Seeded Q4 Release Coverage plan' });
  await Activity.push({ actor: 'seed', action: 'seed:run', target: 'RUN-LAST-NIGHT', detail: 'Seeded nightly regression run with one failure' });
  await Activity.push({ actor: 'seed', action: 'seed:inbox', target: '', detail: 'Seeded 3 inbox items awaiting review' });

  console.log('[seed] done');
  return { seeded: true };
}
