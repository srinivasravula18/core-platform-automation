/**
 * Phase 2 — Defect Reporter tests. Proves (pure, offline): signature clustering (N failures sharing a
 * symptom → ONE defect), regression detection from prior-run verdicts, deterministic risk scoring,
 * cross-run occurrence dedup via @sig tags, idempotent ids, and pass = no defect.
 *   npx tsx scripts/test-defect-reporter.ts   (npm run test:defect-reporter)
 */
import {
  buildDefectDrafts,
  classifyErrorKind,
  failureSignature,
  normalizeFailureMessage,
  type DefectReporterInput,
  type TestResultLike,
} from '../server/features/agent/workflow/defectReporter';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const failedTest = (title: string, error: string): TestResultLike => ({ title, status: 'failed', durationMs: 900, error });

function baseInput(tests: TestResultLike[], extra: Partial<DefectReporterInput> = {}): DefectReporterInput {
  return {
    runId: 'AGENT-run-abc123',
    baseUrl: 'https://h/keystone/?appId=app9',
    missionScope: 'RUNTIME/keystone/CRM/accounts',
    appLabel: 'CRM',
    tests,
    ...extra,
  };
}

function main() {
  console.log('signature normalization');
  const m1 = normalizeFailureMessage('Timed out 15000ms waiting for expect(locator).toBeVisible() locator("#row-4812")');
  const m2 = normalizeFailureMessage('Timed out 15000ms waiting for expect(locator).toBeVisible() locator("#row-9911")');
  eq(m1, m2, 'dynamic ids/durations normalize to the same message');
  eq(classifyErrorKind('Timed out 15000ms waiting'), 'timeout', 'timeout kind');
  eq(classifyErrorKind('MISSION CONTEXT MISMATCH [RUNTIME/x] — executed on the wrong application'), 'context-mismatch', 'context-mismatch kind');
  eq(classifyErrorKind('MISSION SCOPE VIOLATION [RUNTIME/x] — a data-mutating mission cannot run'), 'scope-violation', 'scope-violation kind');
  eq(classifyErrorKind('expect(locator).toContainText failed'), 'assertion', 'assertion kind');

  console.log('clustering: N tests sharing one symptom → ONE defect');
  const err = 'Timed out 10000ms waiting for getByRole(\'button\', { name: \'Save\' })';
  const r1 = buildDefectDrafts(baseInput([
    failedTest('Create account with valid data', err),
    failedTest('Create account and verify in list', err),
    failedTest('Create account with all fields', err),
  ]));
  eq(r1.drafts.length, 1, 'three same-signature failures file ONE defect');
  eq(r1.drafts[0].metadata.frequency, 3, 'frequency counts affected tests');
  eq(r1.drafts[0].metadata.affectedTests.length, 3, 'all affected tests listed');
  ok(r1.drafts[0].tags.includes('@auto'), 'tagged @auto');
  ok(r1.drafts[0].tags.some((t) => t.startsWith('@sig:')), 'carries its signature tag');
  ok(r1.drafts[0].description.includes('3 test(s) failed'), 'description names the cluster size');
  ok(r1.drafts[0].stepsToReproduce.length > 0, 'repro steps never empty');

  console.log('distinct symptoms → distinct defects');
  const r2 = buildDefectDrafts(baseInput([
    failedTest('Case A', err),
    failedTest('Case B', 'expect(locator).toContainText failed for "Status"'),
  ]));
  eq(r2.drafts.length, 2, 'two different signatures → two defects');
  ok(r2.drafts[0].id !== r2.drafts[1].id, 'ids differ per signature');

  console.log('idempotent ids: same input → same ids');
  const again = buildDefectDrafts(baseInput([failedTest('Case A', err)]));
  const first = buildDefectDrafts(baseInput([failedTest('Case A', err)]));
  eq(again.drafts[0].id, first.drafts[0].id, 'deterministic id per run+signature');
  ok(/^DEF-AUTO-[A-Z0-9]+-[A-F0-9]{6}$/.test(first.drafts[0].id), 'id shape DEF-AUTO-<run>-<sig>');

  console.log('pass = no defect');
  const r3 = buildDefectDrafts(baseInput([{ title: 'ok case', status: 'passed', durationMs: 100 }]));
  eq(r3.drafts.length, 0, 'no drafts for a passing run');
  eq(r3.updates.length, 0, 'no updates for a passing run');

  console.log('regression detection from prior-run verdicts');
  const rReg = buildDefectDrafts(baseInput([failedTest('Create account with valid data', err)], {
    priorRuns: [
      { runId: 'AGENT-prior-2', at: '2026-07-14', verdicts: { 'Create account with valid data': 'failed' } },
      { runId: 'AGENT-prior-1', at: '2026-07-10', verdicts: { 'Create account with valid data': 'passed' } },
    ],
  }));
  ok(rReg.drafts[0].metadata.regression, 'previously-passing case flags regression');
  eq(rReg.drafts[0].metadata.lastPassedRunId, 'AGENT-prior-1', 'names the last passing run');
  ok(rReg.drafts[0].tags.includes('@regression'), '@regression tag added');
  ok(rReg.drafts[0].severity === 'High' || rReg.drafts[0].severity === 'Critical', 'regression escalates severity');
  const rNoReg = buildDefectDrafts(baseInput([failedTest('Brand new case', err)], {
    priorRuns: [{ runId: 'AGENT-prior-1', verdicts: { 'Other case': 'passed' } }],
  }));
  ok(!rNoReg.drafts[0].metadata.regression, 'a never-passed case is not a regression');

  console.log('risk block: deterministic and mutation-aware');
  const rMut = buildDefectDrafts(baseInput([failedTest('Create account', err)], { mutationIntent: true }));
  const rRead = buildDefectDrafts(baseInput([failedTest('Create account', err)], { mutationIntent: false }));
  ok(rMut.drafts[0].metadata.risk.score > rRead.drafts[0].metadata.risk.score, 'mutation raises risk');
  ok(rMut.drafts[0].tags.includes('@mutation'), '@mutation tag present');
  eq(rMut.drafts[0].severity, 'High', 'mutation failure is High severity');
  ok(r1.drafts[0].metadata.risk.score >= rRead.drafts[0].metadata.risk.score, 'higher frequency never lowers risk');
  ok(rMut.drafts[0].metadata.risk.factors.length >= 2, 'risk factors are explained');

  console.log('cross-run dedup: existing open @sig defect → occurrence update, not a duplicate');
  const sig = failureSignature(failedTest('Case A', err));
  const rDup = buildDefectDrafts(baseInput([failedTest('Case A', err)], {
    existingDefects: [
      { id: 'DEF-AUTO-OLDRUN-ABCDEF', status: 'Open', tags: ['@auto', `@sig:${sig.hash}`], metadata: { occurrences: 2, affectedTests: ['Case Z'] } },
    ],
  }));
  eq(rDup.drafts.length, 0, 'no new defect when an open one carries the same signature');
  eq(rDup.updates.length, 1, 'one occurrence update instead');
  eq(rDup.updates[0].id, 'DEF-AUTO-OLDRUN-ABCDEF', 'update targets the existing defect');
  eq(rDup.updates[0].metadata.occurrences, 3, 'occurrences bumped');
  ok((rDup.updates[0].metadata.affectedTests ?? []).includes('Case A') && (rDup.updates[0].metadata.affectedTests ?? []).includes('Case Z'), 'affected tests merged');

  console.log('closed defects do NOT absorb new failures');
  const rClosed = buildDefectDrafts(baseInput([failedTest('Case A', err)], {
    existingDefects: [{ id: 'DEF-AUTO-OLDRUN-ABCDEF', status: 'Closed', tags: [`@sig:${sig.hash}`] }],
  }));
  eq(rClosed.drafts.length, 1, 'closed same-signature defect → fresh defect filed (bug came back)');

  console.log('repro steps and test data from the authored case + step log');
  const rSteps = buildDefectDrafts(baseInput([failedTest('Create account', err)], {
    cases: [{
      title: 'Create account', preconditions: 'Logged in as tester',
      steps: [{ action: 'Open Accounts', expected: 'List visible' }, { action: 'Click New' }, { action: 'Fill Name and save', expected: 'Account created' }],
    }],
    stepLogsByTitle: {
      'Create account': [
        { n: 1, kind: 'fill', label: 'Name *', value: 'Jordan Blake', ok: true },
        { n: 2, kind: 'click', label: 'Save', ok: false, error: 'timeout' },
      ],
    },
  }));
  const d = rSteps.drafts[0];
  ok(d.stepsToReproduce.includes('Preconditions: Logged in as tester'), 'preconditions included');
  ok(d.stepsToReproduce.includes('1. Open Accounts'), 'numbered case steps');
  eq(d.metadata.testDataUsed, [{ field: 'Name *', value: 'Jordan Blake' }], 'resolved fill values recorded');
  ok(d.actual.includes('Failing step: click "Save"'), 'actual names the failing step');
  ok(d.metadata.environment.url.length > 0 && d.metadata.environment.runId.length > 0, 'environment block populated');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
