/**
 * Live end-to-end API test of the Selector Registry fix against the deployed Admin list view.
 * Throwaway driver; no production code modified. Drives the RUNNING backend (:3001):
 *   login → POST /api/agent/start → poll /status → GET /api/agent-runs → inspect selector lineage.
 *   npx tsx scripts/live-run-listview.ts
 */
// All deployment-specific config comes from the environment — nothing hardcoded.
const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const APP_USER = process.env.APP_USER || '';
const APP_PASS = process.env.APP_PASS || '';
const PROJECT_ID = process.env.RUN_PROJECT_ID || '';
if (!APP_USER || !APP_PASS) {
  console.error('Set APP_USER and APP_PASS in the environment before running.');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let token = '';
const H = () => ({
  'content-type': 'application/json',
  ...(PROJECT_ID ? { 'x-project-id': PROJECT_ID } : {}),
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

async function main() {
  // 2) backend alive?
  const hc = await fetch(`${BASE}/api/health`).then((r) => r.status).catch(() => 0);
  console.log(`[health] GET /api/health -> ${hc}`);

  // 3) login to the automation backend
  const lr = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(), body: JSON.stringify({ username: APP_USER, password: APP_PASS }) });
  if (!lr.ok) throw new Error(`login failed: ${lr.status} ${await lr.text()}`);
  token = (await lr.json()).token;
  console.log(`[auth] logged in as ${APP_USER}`);

  // 4) start a run on the Admin list view (exact scope/body per spec)
  const startBody = {
    prompt: process.env.RUN_PROMPT || 'Generate 2 test cases for the List View.',
    flowMode: process.env.RUN_FLOW_MODE || 'complete',
    testCaseCount: Number(process.env.RUN_CASE_COUNT || 2),
    folderId: process.env.RUN_FOLDER_ID || '',
    folderMention: process.env.RUN_FOLDER || 'Regression', // satisfies the folder gate by name
    websiteId: process.env.RUN_WEBSITE_ID || '',
    websiteName: process.env.RUN_WEBSITE_NAME || '',
    app_url: process.env.TARGET_APP_URL || '',
    projectId: PROJECT_ID,
    // fallback so the target app login works if the website record doesn't resolve creds
    inlineCredentials: { username: process.env.PROBE_USER || '', password: process.env.PROBE_PASS || '' },
  };
  let id = process.env.RUN_ID || '';
  if (!id) {
    const sr = await fetch(`${BASE}/api/agent/start`, { method: 'POST', headers: H(), body: JSON.stringify(startBody) });
    const sj: any = await sr.json();
    if (sj.chat_response) { console.log('[start] backend asked a question instead of starting:\n', sj.chat_response); return; }
    if (!sj.task_id) throw new Error(`no task_id: ${sr.status} ${JSON.stringify(sj)}`);
    id = sj.task_id;
    console.log(`[start] run id = ${id}\n`);
  } else {
    console.log(`[attach] polling existing run id = ${id}\n`);
  }

  // 5/6/7) poll status until completed | failed | cancelled, printing each NEW phase message
  const seen = new Set<string>();
  const deadline = Date.now() + 25 * 60 * 1000;
  let status = 'running';
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/agent-runs/${id}/status`, { headers: H() });
    if (!r.ok) { console.log(`[poll] status ${r.status}`); await sleep(8000); continue; }
    const s: any = await r.json();
    status = s.status;
    for (const m of s.messages || []) {
      const k = `${m.agent}|${m.status}|${m.at}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const raw = m.output == null ? '' : (typeof m.output === 'string' ? m.output : JSON.stringify(m.output));
      console.log(`  [${m.agent}] ${m.status} — ${raw.slice(0, 240)}`);
    }
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      console.log(`\n[poll] TERMINAL status = ${status}, cases=${s.counts?.cases}, scripts=${s.counts?.scripts}`);
      break;
    }
    await sleep(10000);
  }

  // 4) fetch the full run and inspect the selector lineage + generated cases
  const rr = await fetch(`${BASE}/api/agent-runs`, { headers: H() });
  const runs: any[] = await rr.json();
  const run = runs.find((x) => x.id === id);
  if (!run) { console.log('[inspect] run not found in /api/agent-runs (scope filter?)'); return; }

  console.log('\n════════ SELECTOR LINEAGE (live run) ════════');
  const dom = run.dom_exploration?.coverage;
  console.log('[DOM]      ', dom ? JSON.stringify(dom) : '(no dom_exploration)');
  const reg = run.selector_registry;
  console.log('[Registry] ', reg?.coverage ? JSON.stringify(reg.coverage) : '(no selector_registry)');
  const vsel: any[] = Array.isArray(reg?.verified_selectors) ? reg.verified_selectors : [];
  const verified = vsel.filter((v) => v.verified);
  console.log(`[verified_selectors] total=${vsel.length} verified=${verified.length}`);
  for (const v of verified.slice(0, 8)) console.log(`   - ${v.elementType || v.role} "${v.label}" -> ${v.selector} [${v.confidence}/${v.provenance}]`);

  console.log('\n════════ GENERATED CASES ════════');
  const cases: any[] = Array.isArray(run.generated_cases) ? run.generated_cases : [];
  console.log(`cases = ${cases.length}`);
  const verifiedSelStrings = new Set(verified.map((v) => String(v.selector)));
  const verifiedLabels = new Set(verified.map((v) => String(v.label || '').toLowerCase()).filter(Boolean));
  let stepsReferencingVerified = 0, totalSteps = 0;
  for (const [i, c] of cases.entries()) {
    console.log(`\n--- Case ${i + 1}: ${c.title || c.name || '(untitled)'} ---`);
    const steps = Array.isArray(c.steps) ? c.steps : [];
    for (const st of steps) {
      totalSteps++;
      const text = `${st.action || ''} ${st.expected || ''} ${st.selector || ''}`;
      const refsSel = [...verifiedSelStrings].some((s) => s && text.includes(s));
      const refsLabel = [...verifiedLabels].some((l) => l && text.toLowerCase().includes(l));
      if (refsSel || refsLabel) stepsReferencingVerified++;
      console.log(`   • ${String(st.action || '').slice(0, 120)}${refsSel ? '  [↦ verified selector]' : refsLabel ? '  [↦ verified label]' : ''}`);
    }
  }

  console.log('\n════════ VERDICT ════════');
  console.log(`Registry non-empty       : ${(reg?.coverage?.total_elements || 0) > 0}`);
  console.log(`Verified selectors > 0   : ${verified.length > 0}`);
  console.log(`Cases generated          : ${cases.length}`);
  console.log(`Steps referencing verified selectors/labels: ${stepsReferencingVerified}/${totalSteps}`);
}
main().catch((e) => { console.error('DRIVER ERROR:', e?.message || e); process.exit(1); });
