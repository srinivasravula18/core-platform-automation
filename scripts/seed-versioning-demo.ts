/**
 * Seed demo data to exercise the versioning + tag-composition concept across cases, suites, plans,
 * and runs. Creates a case taken from v1 → v10 (10 immutable revisions), a second versioned case,
 * a tag-defined suite + plan (drift accepted), and a manual run pinned to an older @vN. Everything
 * is tagged @versioning-demo and prefixed "[VDEMO]" so it's easy to find and delete afterwards.
 *
 * Run: npx tsx scripts/seed-versioning-demo.ts   (backend must be up on :3001)
 */
const BASE = process.env.SEED_BASE || 'http://127.0.0.1:3001';
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'admin@2026';
const TAG = '@versioning-demo';

let token = '';
async function api(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error || text}`);
  return data;
}

// A distinct set of steps per version so diffs/history are visibly different at each node.
function stepsForVersion(n: number) {
  const base = [
    { action: 'Navigate to the login page', expected: 'Login form is visible' },
    { action: `Enter credentials (revision v${n})`, expected: 'Fields accept input' },
    { action: 'Submit the form', expected: 'User is authenticated' },
  ];
  // Grow/shift the steps as versions advance so each revision differs from the last.
  if (n >= 3) base.push({ action: `Verify dashboard widget #${n}`, expected: `Widget ${n} renders` });
  if (n >= 6) base.splice(1, 0, { action: `Dismiss cookie banner (added in v${n})`, expected: 'Banner closed' });
  if (n >= 9) base.push({ action: 'Log out and confirm session ends', expected: 'Back on login page' });
  return base;
}

async function main() {
  ({ token } = await api('POST', '/api/auth/login', { username: USER, password: PASS }));
  console.log(`logged in as ${USER}`);
  const folders = await api('GET', '/api/folders').catch(() => []);
  const folderId = Array.isArray(folders) && folders[0] ? folders[0].id : '';

  // --- Case A: v1 → v10 (the headline: 10 immutable revisions) ---
  const created = await api('POST', '/api/cases', {
    title: '[VDEMO] Checkout & login flow',
    preconditions: 'A registered user exists',
    steps: stepsForVersion(1),
    tags: [TAG, '@ui', '@regression'],
    priority: 'High',
    folderId,
  });
  const caseA = created.id;
  console.log(`created case ${caseA} (v1)`);
  for (let v = 2; v <= 10; v++) {
    await api('PUT', `/api/cases/${caseA}`, {
      steps: stepsForVersion(v),
      description: `Iteration v${v}: refined the checkout & login coverage.`,
      changeSummary: `v${v}: adjusted steps for revision ${v}`,
      changeKind: 'manual',
    });
  }
  const revA = await api('GET', `/api/cases/${caseA}/revisions`);
  console.log(`case ${caseA} now HEAD v${revA.currentRevision}, ${revA.revisions.length} revisions in the graph`);

  // --- Case B: a few versions, so suites/plans have >1 member ---
  const createdB = await api('POST', '/api/cases', {
    title: '[VDEMO] Password reset flow',
    steps: [{ action: 'Open reset page', expected: 'Reset form shows' }],
    tags: [TAG, '@ui'],
    priority: 'Medium',
    folderId,
  });
  const caseB = createdB.id;
  for (let v = 2; v <= 4; v++) {
    await api('PUT', `/api/cases/${caseB}`, { steps: [
      { action: 'Open reset page', expected: 'Reset form shows' },
      { action: `Submit email (v${v})`, expected: 'Reset link sent' },
    ], changeSummary: `v${v}: reset flow update` });
  }
  console.log(`created case ${caseB} (v1→v4)`);

  // --- Plan (top of the hierarchy), tag-defined by @versioning-demo ---
  const plan = (await api('POST', '/api/plans', {
    name: '[VDEMO] Versioning plan', folderId,
    definition: { tagQuery: { any: [TAG] } },
  })).plan;
  const planId = plan?.id || (await api('GET', '/api/plans')).find((p: any) => p.name === '[VDEMO] Versioning plan')?.id;
  console.log(`created plan ${planId}`);

  // --- Suite UNDER the plan (Plan → Suite), tag-defined by @versioning-demo ---
  const suite = (await api('POST', '/api/suites', {
    name: '[VDEMO] Versioning suite', folderId,
    testPlanIds: [planId], testPlanId: planId,
    definition: { tagQuery: { any: [TAG] } },
  })).suite;
  const suiteId = suite?.id || (await api('GET', '/api/suites')).find((s: any) => s.name === '[VDEMO] Versioning suite')?.id;
  console.log(`created suite ${suiteId} (under plan ${planId})`);

  // Suite → Cases: accept the tag matches (links A + B to the suite).
  await api('POST', `/api/suites/${suiteId}/tag-accept`, {});
  const suiteDrift = await api('GET', `/api/suites/${suiteId}/tag-drift`);
  console.log(`suite: accepted ${suiteDrift.acceptedCount} cases`);
  // Independent per-container version pin: this suite runs case A at @v3.
  await api('POST', `/api/suites/${suiteId}/case-pin`, { caseId: caseA, revisionNo: 3 });
  console.log(`suite: pinned ${caseA} → @v3`);

  // Plan → Cases too (deduped with the suite path): accept the plan's matches.
  await api('POST', `/api/plans/${planId}/tag-accept`, {});
  const planDrift = await api('GET', `/api/plans/${planId}/tag-drift`);
  console.log(`plan: accepted ${planDrift.acceptedCount} cases (drift now ${planDrift.newMatchCount})`);

  // --- Manual run linked to the plan + suite; pin case A to @v5 so it runs v5's steps ---
  const run = (await api('POST', '/api/runs', {
    name: '[VDEMO] Versioning manual run', mode: 'manual', status: 'Not Started', folderId,
    testPlanId: planId, suiteId, testCaseId: caseA, caseIds: [caseA, caseB],
    definition: { tagQuery: { any: [TAG] } },
  })).run;
  const runId = run?.id;
  await api('POST', `/api/runs/${runId}/case-pin`, { caseId: caseA, revisionNo: 5 });
  const results = await api('GET', `/api/runs/${runId}/results`);
  const rowA = (Array.isArray(results) ? results : results.results || []).find((r: any) => r.caseId === caseA);
  console.log(`run ${runId}: linked to plan+suite; pinned ${caseA} → @v5 (seeded revisionNo=${rowA?.revisionNo})`);

  // --- Case C added AFTER acceptance → shows up as review-gated DRIFT on the suite AND plan ---
  await api('POST', '/api/cases', {
    title: '[VDEMO] New feature smoke (drift)',
    steps: [{ action: 'Exercise the new feature', expected: 'It works' }],
    tags: [TAG, '@ui'], priority: 'Low', folderId,
  });
  const suiteDrift2 = await api('GET', `/api/suites/${suiteId}/tag-drift`);
  const planDrift2 = await api('GET', `/api/plans/${planId}/tag-drift`);
  console.log(`added drift case → suite shows ${suiteDrift2.newMatchCount} new, plan shows ${planDrift2.newMatchCount} new (the notification)`);

  console.log('\n=== DONE — the linked hierarchy Plan → Suite → Cases + Run ===');
  console.log(`Case history graph : Test Cases → ${caseA} → History (v1…v10: diff any two, restore any)`);
  console.log(`Plan (top)         : Test Plans  → ${planId} (contains the suite; drift banner = 1 new case)`);
  console.log(`Suite (under plan) : Test Suites → ${suiteId} (case A pinned @v3; drift banner = 1 new case)`);
  console.log(`Manual run (pinned): Test Runs   → ${runId} (Version column: case A = @v5)`);
  console.log(`Try: pin case A to different @vN on the run, restore an old version on case A, accept the drift case.`);
  console.log(`Cleanup later: delete anything tagged ${TAG} / prefixed [VDEMO].`);
}

main().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
