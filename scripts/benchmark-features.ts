/**
 * Cross-feature accuracy benchmark.
 *
 * Runs the agent end-to-end over a matrix of features × app (Admin/Keystone) × wording, then scores
 * each run on: completed?, true pass rate (execution_result), grounded? (the generated scripts use
 * the real controls and avoid known guess patterns), and section-nav drift. Prints a per-case + an
 * aggregate table so "is it accurate enough to ship" becomes a NUMBER instead of a vibe.
 *
 * Run:  npx tsx scripts/benchmark-features.ts            (all cases — slow, ~15-20 min each)
 *       BENCH_LIMIT=2 npx tsx scripts/benchmark-features.ts   (first N cases)
 *       BENCH_CASES=objects-exact,users-exact npx tsx scripts/benchmark-features.ts
 *
 * Env: TFA_BASE (default http://localhost:3001), ADMIN_USER/ADMIN_PASS (default admin/admin@2026).
 */

const BASE = process.env.TFA_BASE || 'http://localhost:3001';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin@2026';

// Scope: the "ListView Benchmark" project has both a local Admin (5002) and Keystone (5003) app.
const PROJECT = 'PRJ-5f1ec065';
const ADMIN = { appId: 'APP-471241c6', websiteId: 'WEB-1781700945579-VV30' }; // localhost:5002
const KEYSTONE = { appId: 'APP-95d1bcd6', websiteId: 'WEB-1781701024875-UVYG' }; // localhost:5003

interface Case {
  id: string;
  feature: string;
  app: 'admin' | 'keystone';
  wording: 'exact' | 'vague';
  prompt: string;
  count: number;
  /** real control tokens that SHOULD appear in the scripts if grounded (any one counts). */
  expectGrounded: string[];
  /** known guess/paraphrase patterns that should NOT appear. */
  forbidGuesses: string[];
}

const CASES: Case[] = [
  { id: 'listview-sort-exact', feature: 'List View', app: 'admin', wording: 'exact', count: 1,
    prompt: 'Test the Admin list view: sort a column by clicking its header and verify the sort direction toggles.',
    expectGrounded: ['getByRole', 'header', 'toHaveURL'], forbidGuesses: ["getByText('More'", "getByText('list view settings'"] },
  { id: 'listview-export-vague', feature: 'List View', app: 'admin', wording: 'vague', count: 1,
    prompt: 'In the apps screen, download the results.',
    expectGrounded: ['Export options', "name: 'Export", 'waitForEvent'], forbidGuesses: ["getByText('Download'", "getByText('More'"] },
  { id: 'objects-exact', feature: 'Objects', app: 'admin', wording: 'exact', count: 1,
    prompt: 'Open the Objects section and verify the New Object modal opens with its fields.',
    expectGrounded: ['#create-object-label', "getByLabel('Label", 'New Object'], forbidGuesses: ["getByPlaceholder('Label'", 'nav=users'] },
  { id: 'objects-vague', feature: 'Objects', app: 'admin', wording: 'vague', count: 1,
    prompt: 'Make a new business object type.',
    expectGrounded: ['#create-object-label', 'New Object', '#create-object-prefix'], forbidGuesses: ["getByPlaceholder('Label'"] },
  { id: 'users-exact', feature: 'Users', app: 'admin', wording: 'exact', count: 1,
    prompt: 'Open the Users section and verify the New User modal opens with its fields.',
    expectGrounded: ['#user-username', '#user-password', 'New User'], forbidGuesses: ["getByPlaceholder('Username'", 'nav=objects'] },
  { id: 'permissions-exact', feature: 'Permissions', app: 'admin', wording: 'exact', count: 1,
    prompt: 'Open the Permissions section and verify the create-permission form.',
    expectGrounded: ['#create-permission-resource-type', '#create-permission-action', 'New Permission'], forbidGuesses: ['nav=users'] },
  { id: 'sharing-exact', feature: 'Sharing Settings', app: 'admin', wording: 'exact', count: 1,
    prompt: 'Open Sharing Settings and verify the New Sharing Setting modal.',
    expectGrounded: ['#create-sharing-rule-object', '#create-sharing-rule-name', 'New Sharing Setting'], forbidGuesses: [] },
  { id: 'tabs-exact', feature: 'Tabs', app: 'admin', wording: 'exact', count: 1,
    prompt: 'Open the Tabs section and verify the New Tab modal.',
    expectGrounded: ['#create-tab-label', '#create-tab-type', 'New Tab'], forbidGuesses: [] },
  { id: 'flows-exact', feature: 'Flows', app: 'admin', wording: 'exact', count: 1,
    prompt: 'Open the Flows section and verify the Create Flow modal.',
    expectGrounded: ['#flow-create-name', '#flow-create-api-name', 'Create Flow'], forbidGuesses: [] },
  { id: 'keystone-listview-exact', feature: 'List View', app: 'keystone', wording: 'exact', count: 1,
    prompt: 'Test the Keystone list view: search the records and verify the grid updates.',
    expectGrounded: ['Search results', 'getByRole', 'table'], forbidGuesses: ["getByText('More'"] },
];

async function api(path: string, opts: any = {}, token?: string, scope?: { appId: string }) {
  const headers: any = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (scope) { headers['X-Project-Id'] = PROJECT; headers['X-App-Id'] = scope.appId; }
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

function scoreRun(run: any, c: Case) {
  const scripts = Array.isArray(run.playwright_scripts) ? run.playwright_scripts : [];
  const code = scripts.map((s: any) => String(s.code || '')).join('\n');
  const er = run.execution_result || {};
  const grounded = c.expectGrounded.some((t) => code.includes(t)) && !c.forbidGuesses.some((t) => code.includes(t));
  const hitGuesses = c.forbidGuesses.filter((t) => code.includes(t));
  const total = er.total || 0;
  const passed = er.passed || 0;
  return {
    completed: run.status === 'completed' || run.status === 'failed',
    scripts: scripts.length,
    passed, total,
    passRate: total ? Math.round((passed / total) * 100) : 0,
    grounded,
    hitGuesses,
  };
}

async function runCase(token: string, c: Case) {
  const scope = c.app === 'admin' ? ADMIN : KEYSTONE;
  const start = await api('/api/agent/start', {
    method: 'POST',
    body: JSON.stringify({ prompt: c.prompt, testCaseCount: c.count, websiteId: scope.websiteId, flowMode: 'complete' }),
  }, token, scope);
  const id = start.task_id || start.id;
  if (!id) return { id: null, error: `start failed: ${JSON.stringify(start).slice(0, 120)}` };
  // poll up to 30 min
  const deadline = Date.now() + 30 * 60 * 1000;
  let run: any;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    run = await api(`/api/agent-runs/${id}`, {}, token, scope);
    if (run && run.status && run.status !== 'running') break;
  }
  return { id, run };
}

async function main() {
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: USER, password: PASS }) });
  const token = login.token;
  if (!token) { console.error('login failed', login); process.exit(1); }
  // pin provider to openai (pro) for speed/quota — best-effort
  try {
    const s = await api('/api/settings', {}, token);
    s.defaultProvider = 'openai'; s.providerSettings.openai.enabled = true; s.agentProviderMap = {};
    await api('/api/settings', { method: 'POST', body: JSON.stringify(s) }, token);
  } catch { /* ignore */ }

  let cases = CASES;
  if (process.env.BENCH_CASES) { const want = new Set(process.env.BENCH_CASES.split(',')); cases = cases.filter((c) => want.has(c.id)); }
  if (process.env.BENCH_LIMIT) cases = cases.slice(0, Number(process.env.BENCH_LIMIT));

  const rows: any[] = [];
  for (const c of cases) {
    process.stdout.write(`\n[bench] ${c.id} (${c.feature}/${c.app}/${c.wording}) ...`);
    const { id, run, error } = await runCase(token, c);
    if (error || !run) { rows.push({ c, score: null, error }); process.stdout.write(` ERROR ${error || 'no run'}`); continue; }
    const score = scoreRun(run, c);
    rows.push({ c, score, id });
    process.stdout.write(` status=${run.status} pass=${score.passed}/${score.total} grounded=${score.grounded}${score.hitGuesses.length ? ` GUESSES:${score.hitGuesses.join(',')}` : ''}`);
  }

  // report
  console.log('\n\n===== FEATURE ACCURACY BENCHMARK =====');
  console.log('case'.padEnd(26), 'feat/app'.padEnd(22), 'pass'.padEnd(8), 'grounded', 'guesses');
  let truePass = 0, groundedN = 0, scored = 0;
  for (const r of rows) {
    if (!r.score) { console.log(r.c.id.padEnd(26), `${r.c.feature}/${r.c.app}`.padEnd(22), 'ERR'); continue; }
    scored++; if (r.score.passRate === 100 && r.score.total > 0) truePass++; if (r.score.grounded) groundedN++;
    console.log(
      r.c.id.padEnd(26),
      `${r.c.feature}/${r.c.app}`.padEnd(22),
      `${r.score.passed}/${r.score.total}`.padEnd(8),
      String(r.score.grounded).padEnd(8),
      r.score.hitGuesses.join(',') || '-',
    );
  }
  console.log('--------------------------------------');
  console.log(`scored=${scored}  fully-green=${truePass} (${scored ? Math.round((truePass / scored) * 100) : 0}%)  grounded=${groundedN} (${scored ? Math.round((groundedN / scored) * 100) : 0}%)`);
  process.exit(0);
}

main().catch((e) => { console.error('[bench] FATAL', e); process.exit(1); });
