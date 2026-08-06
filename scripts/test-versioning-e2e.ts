/**
 * End-to-end API coverage for versioning + tag-native composition across cases, suites, plans, runs.
 * Deterministic and SELF-CLEANING (deletes everything it creates), so it can run repeatedly before a
 * demo. Backend must be up on :3001.  Run:  npm run test:versioning-e2e
 *
 * Covers, as explicit permutations:
 *  - case revision graph v1..v5, diff any two, rollback/restore (append-only, non-destructive)
 *  - drift ADD  on runs + suites + plans     (membership materializes; drift clears)
 *  - drift DISMISS on runs + suites + plans  (recorded; membership unchanged)
 *  - per-container drift independence
 *  - version pins on runs + suites + plans + per-container independence
 *  - manual run seeds the PINNED revision's steps
 *  - manual run tag-accept seeds the new case's result row (regression for the bug found in testing)
 *  - a run built from a pinned suite INHERITS the suite's pins
 */
import assert from 'node:assert/strict';

const BASE = process.env.SEED_BASE || 'http://127.0.0.1:3001';
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'admin@2026';
const TAG = `@e2e-ver-${Date.now().toString(36)}`; // unique per run so it never collides
const created: Array<{ kind: string; id: string }> = [];
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
let seq = 0;
const uniq = () => `${TAG}-${++seq}`; // unique per creation (name-uniqueness constraints on suites/plans)
const newCase = async (title: string, steps: any[], extra: any = {}) => {
  const r = await api('POST', '/api/cases', { title: `${title} ${uniq()}`, steps, tags: [TAG], ...extra });
  created.push({ kind: 'cases', id: r.id }); return r.id;
};
const drift = (target: string, id: string) => api('GET', `/api/${target}/${id}/tag-drift`);
const results = async (runId: string) => { const d = await api('GET', `/api/runs/${runId}/results`); return Array.isArray(d) ? d : (d.results || []); };

async function run() {
  ({ token } = await api('POST', '/api/auth/login', { username: USER, password: PASS }));

  // ---------- 1. Case revision graph: v1 → v5 ----------
  const caseA = await newCase('[E2E] versioned case', [{ action: 'a1', expected: 'e1' }]);
  for (let v = 2; v <= 5; v++) {
    await api('PUT', `/api/cases/${caseA}`, { steps: Array.from({ length: v }, (_, i) => ({ action: `a${v}.${i}`, expected: `e${v}.${i}` })), changeSummary: `v${v}` });
  }
  const rev = await api('GET', `/api/cases/${caseA}/revisions`);
  assert.equal(rev.currentRevision, 5, 'HEAD should be v5');
  assert.equal(rev.revisions.length, 5, 'graph should have 5 nodes');
  console.log('✓ case graph v1..v5');

  // ---------- 2. Diff two revisions ----------
  const diff = await api('GET', `/api/cases/${caseA}/revisions/5/diff/2`);
  assert.ok(diff, 'diff returns payload');
  console.log('✓ diff v5 vs v2');

  // ---------- 3. Restore/rollback (append-only, non-destructive) ----------
  const v2id = rev.revisions.find((r: any) => r.revisionNo === 2)?.revisionId;
  await api('POST', `/api/cases/${caseA}/rollback/${v2id}`);
  const rev2 = await api('GET', `/api/cases/${caseA}/revisions`);
  assert.equal(rev2.revisions.length, 6, 'rollback appends a node (nothing deleted)');
  assert.equal(rev2.currentRevision, 6, 'HEAD advances to the rollback node');
  const head = rev2.revisions.find((r: any) => r.revisionNo === 6);
  assert.equal((head.steps || []).length, 2, 'HEAD content equals v2 (2 steps)');
  assert.equal(head.changeKind, 'rollback', 'rollback node kind');
  console.log('✓ restore v2 → appended v6 rollback, non-destructive');

  // second member case so groups have >1
  const caseB = await newCase('[E2E] second case', [{ action: 'b', expected: 'eb' }]);

  // ---------- 4. Drift ADD + DISMISS + independence, for each container ----------
  const mkGroup = async (target: 'runs' | 'suites' | 'plans') => {
    const body: any = { name: `[E2E] ${target} ${uniq()}`, definition: { tagQuery: { any: [TAG] } } };
    if (target === 'runs') { body.mode = 'manual'; body.status = 'Not Started'; }
    const r = await api('POST', `/api/${target}`, body);
    const id = (r[target.slice(0, -1)] || {}).id || r.id;
    created.push({ kind: target, id });
    return id;
  };
  const acceptedCount = async (target: string, id: string) => (await drift(target, id)).acceptedCount;

  for (const target of ['runs', 'suites', 'plans'] as const) {
    const id = await mkGroup(target);
    const d0 = await drift(target, id);
    assert.ok(d0.newMatchCount >= 2, `${target}: sees the tag matches`);
    // ADD one specific case
    const acc = await api('POST', `/api/${target}/${id}/tag-accept`, { caseIds: [caseA] });
    assert.equal(acc.acceptedCount, 1, `${target}: accepted exactly 1`);
    assert.ok(acc.newMatchCount >= 1, `${target}: caseB still pending`);
    // DISMISS the rest → new 0, membership unchanged (still 1 accepted)
    const dis = await api('POST', `/api/${target}/${id}/tag-dismiss`, { caseIds: [caseB] });
    assert.equal(dis.newMatchCount, 0, `${target}: dismiss clears drift`);
    assert.equal(await acceptedCount(target, id), 1, `${target}: dismiss did NOT change membership`);
    console.log(`✓ drift add+dismiss on ${target}`);
  }

  // ---------- 5. Version pins: set on each container + independence ----------
  const suiteP = await mkGroup('suites');
  const planP = await mkGroup('plans');
  const runP = await mkGroup('runs');
  for (const [t, id, v] of [['suites', suiteP, 3], ['plans', planP, 4], ['runs', runP, 5]] as const) {
    const r = await api('POST', `/api/${t}/${id}/case-pin`, { caseId: caseA, revisionNo: v });
    const pin = (r.casePins || []).find((p: any) => p.caseId === caseA);
    assert.equal(pin?.revisionNo, v, `${t}: case pinned @v${v}`);
    assert.ok(pin?.revisionId, `${t}: pin stores immutable revisionId`);
  }
  console.log('✓ independent per-container pins (suite@v3, plan@v4, run@v5)');

  // ---------- 6. Manual run: accept seeds a row (bug regression) + pin seeds pinned steps ----------
  const mrun = await mkGroup('runs');
  await api('POST', `/api/runs/${mrun}/tag-accept`, { caseIds: [caseA] });
  let rows = await results(mrun);
  // A case-less manual run also has a placeholder self-row (caseId === runId); assert the accepted
  // case specifically got its own result row (the regression for the bug found during testing).
  assert.equal(rows.filter((r: any) => r.caseId === caseA).length, 1, 'accept seeded a row for the accepted case');
  // pin the case to v2 (2 steps) → row re-seeds to v2 content
  await api('POST', `/api/runs/${mrun}/case-pin`, { caseId: caseA, revisionNo: 2 });
  rows = await results(mrun);
  const row = rows.find((r: any) => r.caseId === caseA);
  assert.equal(row.revisionNo, 2, 'manual row re-seeded to pinned v2');
  assert.equal((row.stepResults || []).length, 2, 'pinned v2 steps seeded (2)');
  console.log('✓ manual accept seeds row + pin re-seeds pinned version steps');

  // ---------- 7. Inheritance: run built from a pinned suite inherits the pin ----------
  const iSuite = await mkGroup('suites');
  await api('POST', `/api/suites/${iSuite}/tag-accept`, { caseIds: [caseA] }); // link caseA to suite
  await api('POST', `/api/suites/${iSuite}/case-pin`, { caseId: caseA, revisionNo: 3 });
  const fromSel = await api('POST', '/api/runs/from-selection', { name: `[E2E] inherit run ${uniq()}`, mode: 'manual', status: 'Not Started', suiteIds: [iSuite] });
  const inheritedRunId = fromSel.run?.id;
  created.push({ kind: 'runs', id: inheritedRunId });
  const irun = await api('GET', '/api/runs');
  const ir = irun.find((r: any) => r.id === inheritedRunId);
  assert.ok(ir?.triggerMeta?.sourceVersions?.suites?.some((source: any) => source.id === iSuite), 'run captured its source suite version');
  assert.ok(ir?.triggerMeta?.sourceVersions?.cases?.some((source: any) => source.id === caseA), 'run captured its source case version');
  const inheritedPin = (ir.casePins || []).find((p: any) => p.caseId === caseA);
  assert.equal(inheritedPin?.revisionNo, 3, 'run inherited the suite pin @v3');
  const irows = await results(inheritedRunId);
  const irow = irows.find((r: any) => r.caseId === caseA);
  assert.equal(irow?.revisionNo, 3, 'inherited-pin manual run seeded v3 steps');
  console.log('✓ run inherits pins from source suite');

  // ---------- 8. Content drift: a pinned case behind HEAD is surfaced; update-to-latest clears it ----------
  const cdSuite = await mkGroup('suites');
  await api('POST', `/api/suites/${cdSuite}/tag-accept`, { caseIds: [caseA] });
  await api('POST', `/api/suites/${cdSuite}/case-pin`, { caseId: caseA, revisionNo: 2 }); // caseA HEAD is v6 (rolled back earlier)
  let cd = await drift('suites', cdSuite);
  assert.equal(cd.outdatedCount, 1, 'pinned-behind-HEAD case surfaces as content drift');
  assert.equal(cd.outdatedPins[0].caseId, caseA);
  assert.ok(cd.outdatedPins[0].headRevisionNo > cd.outdatedPins[0].pinnedRevisionNo, 'head > pinned');
  await api('POST', `/api/suites/${cdSuite}/case-pin`, { caseId: caseA, revisionNo: null }); // update to latest
  cd = await drift('suites', cdSuite);
  assert.equal(cd.outdatedCount, 0, 'clearing the pin (follow latest) resolves content drift');
  console.log('✓ content drift surfaced + update-to-latest clears it');

  console.log('\nversioning-e2e: ALL PASSED');
}

async function cleanup() {
  // delete in child-first order; ignore individual failures so cleanup is best-effort
  for (const { kind, id } of created.reverse()) {
    try { await api('DELETE', `/api/${kind}/${id}`); } catch { /* best effort */ }
  }
}

run()
  .then(cleanup)
  .catch(async (e) => { await cleanup().catch(() => {}); console.error('E2E FAILED:', e.message); process.exit(1); });
