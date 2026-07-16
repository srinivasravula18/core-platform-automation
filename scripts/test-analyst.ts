/**
 * Phase 8 — Autonomous QA Analyst tests. Proves (offline): deterministic feature extraction (pass-rate
 * deltas, regressions, newly-passing, intent/flake/business-rule/visual rollups), the release-risk formula
 * + ship/caution/block thresholds, the optional narrative seam, flag-off no-op of the runtime hook, and
 * never-throws behavior.
 *   npx tsx scripts/test-analyst.ts   (npm run test:analyst)
 */
import { buildAnalystFeatures, buildAnalystReport, isAnalystEnabled } from '../server/features/agent/workflow/analyst';
import { runAnalyst } from '../server/features/agent/workflow/runtime';
import { stashArtifacts, clearArtifacts } from '../server/features/agent/workflow/artifactStash';
import { createInitialWorkflowState } from '../server/features/agent/workflow/state';
import type { AnalystInput } from '../server/features/agent/workflow/analyst';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const T = (title: string, status: string): any => ({ title, status, durationMs: 100 });

function baseInput(partial: Partial<AnalystInput>): AnalystInput {
  return {
    runId: 'AGENT-analyst-test',
    aggregate: { totalCases: 4, passed: 3, failed: 1, durationMs: 60000 },
    tests: [T('A', 'passed'), T('B', 'passed'), T('C', 'passed'), T('D', 'failed')],
    priorRuns: [],
    ...partial,
  };
}

async function main() {
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'test';

  console.log('deterministic features');
  const f1 = buildAnalystFeatures(baseInput({}));
  eq(f1.totals, { cases: 4, passed: 3, failed: 1, durationMs: 60000 }, 'totals from the aggregate');
  eq(f1.passRate, 0.75, 'pass rate computed');
  eq(f1.priorPassRate, null, 'no comparable prior run → null prior rate');
  eq(f1.regressions, [], 'no priors → no regressions');
  ok(f1.riskScore > 0 && f1.riskScore < 60, `one plain failure scores moderate risk (got ${f1.riskScore})`);

  console.log('pass-rate delta + regression/newly-passing detection');
  const f2 = buildAnalystFeatures(baseInput({
    priorRuns: [
      { runId: 'prior-1', at: '2026-07-14', verdicts: { A: 'passed', B: 'failed', C: 'passed', D: 'passed' } },
    ],
  }));
  eq(f2.priorPassRate, 0.75, 'prior pass rate from newest comparable run');
  eq(f2.passRateDelta, 0, 'delta computed');
  eq(f2.regressions, ['D'], 'D passed before, fails now → regression');
  eq(f2.newlyPassing, ['B'], 'B failed before, passes now → newly passing');
  ok(f2.riskScore > f1.riskScore, 'a regression raises the score');
  eq(f2.recommendation, 'ship-with-caution', 'regression forces at least caution');

  console.log('release-risk thresholds');
  const green = buildAnalystFeatures(baseInput({
    aggregate: { totalCases: 4, passed: 4, failed: 0, durationMs: 60000 },
    tests: [T('A', 'passed'), T('B', 'passed'), T('C', 'passed'), T('D', 'passed')],
  }));
  eq(green.riskScore, 0, 'all green, nothing suspicious → risk 0');
  eq(green.recommendation, 'ship', 'risk 0 → ship');
  const red = buildAnalystFeatures(baseInput({
    aggregate: { totalCases: 4, passed: 0, failed: 4, durationMs: 60000 },
    tests: [T('A', 'failed'), T('B', 'failed'), T('C', 'failed'), T('D', 'failed')],
    defectReport: { drafts: [{ severity: 'Critical', metadata: { risk: { score: 90 } } } as any, { severity: 'High', metadata: { risk: { score: 70 } } } as any], updates: [] },
  }));
  ok(red.riskScore >= 60, `everything failing + blocking defects → block-level risk (got ${red.riskScore})`);
  eq(red.recommendation, 'block', 'high risk → block');
  eq(red.defectSummary.bySeverity, { Critical: 1, High: 1 }, 'defect severity rollup');
  eq(red.defectSummary.highestRisk, 90, 'highest defect risk surfaced');
  const empty = buildAnalystFeatures(baseInput({ aggregate: null, tests: [] }));
  ok(empty.riskScore >= 50, `nothing executed → high risk (got ${empty.riskScore})`);

  console.log('investigation + visual rollups');
  const f3 = buildAnalystFeatures(baseInput({
    investigation: {
      findings: [{
        signature: 's1', errorKind: 'timeout', failingTarget: null, affectedTests: ['D'],
        classification: 'synchronization', rootCauseArea: '', confidence: 0.8, flaky: true,
        observations: [{ statement: 'rerun passed', confidence: 0.85, verifiedBy: ['rerun-probe'] }],
        suggestedAreas: [], source: 'deterministic',
        businessRuleViolations: ['picklist-out-of-domain (status): bad value'],
      }],
      suspiciousPasses: [{ title: 'A', reason: 'record not found', confidence: 0.9, observations: [{ statement: 'readback empty', confidence: 0.9, verifiedBy: ['api-readback'] }] }],
      recoveryAttempts: [{ kind: 'rerun', target: 'D', outcome: 'passed' }],
      llmCalls: 1,
    },
    visualFindings: [{ caseTitle: 'B', step: 2, kind: 'dimension-change', message: 'layout shift', confidence: 0.85, baselinePath: 'b', currentPath: 'c' }],
  }));
  eq(f3.flaky, ['D'], 'flaky rollup');
  eq(f3.intentMismatches.map((i) => i.title), ['A'], 'intent mismatch rollup');
  eq(f3.businessRuleViolations.length, 1, 'business-rule rollup');
  eq(f3.visualObservations.length, 1, 'visual observations rolled up');
  ok(f3.visualObservations[0].verifiedBy.includes('visual-baseline'), 'visual observation cites its source');
  eq(f3.recommendation, 'ship-with-caution', 'intent mismatch forces caution');
  ok(f3.rationale.some((r) => r.includes('suspicious PASS')), 'rationale explains the intent mismatch');
  ok(f3.observations.length > 0 && f3.observations.length <= 30, 'consolidated observations bounded');

  console.log('narrative seam');
  const withNarr = await buildAnalystReport({ ...baseInput({}), narrate: async (r) => `Risk ${r.riskScore}: hold.` });
  ok(String(withNarr.narrative).startsWith('Risk '), 'injected narrator runs over the deterministic report');
  const narrThrow = await buildAnalystReport({ ...baseInput({}), narrate: async () => { throw new Error('down'); } });
  ok(narrThrow.narrative === null && narrThrow.riskScore >= 0, 'narrator failure leaves the deterministic report standing');
  delete process.env.AGENT_ANALYST;
  const noNarr = await buildAnalystReport(baseInput({}));
  eq(noNarr.narrative, null, 'flag off + no injected narrator → no LLM narrative');

  console.log('runtime hook: flag-gated, lands on the run record');
  {
    const runId = 'AGENT-analyst-hook';
    const state = createInitialWorkflowState({
      runId, threadId: runId, requestId: `req-${runId}`,
      request: { goal: 'test', requestedCaseCount: 1, reviewPolicy: 'auto' } as any,
    } as any);
    (state as any).execution = { attempts: [], aggregate: { totalCases: 2, passed: 1, failed: 1, durationMs: 500 }, evidenceRefs: [] };
    stashArtifacts(runId, { executionTests: [T('A', 'passed'), T('B', 'failed')] });

    delete process.env.AGENT_ANALYST;
    const seedOff: any = { messages: [] };
    eq(await runAnalyst(state as any, seedOff, null), null, 'flag off → null, no side effects');
    eq(seedOff.analyst_report, undefined, 'flag off → seed untouched');

    process.env.AGENT_ANALYST = '1';
    const seedOn: any = { messages: [] };
    const rep = await runAnalyst(state as any, seedOn, null);
    ok(!!rep && typeof rep.riskScore === 'number', 'flag on → report produced');
    ok(seedOn.analyst_report === rep, 'report lands on the run seed (persists via projection into raw)');
    ok(seedOn.messages.some((m: any) => m.agent === 'QAAnalyst' && /Release risk \d+\/100/.test(m.output)), 'run message carries the risk line');
    clearArtifacts(runId);
    delete process.env.AGENT_ANALYST;
  }

  console.log('flag helper');
  ok(!isAnalystEnabled(), 'flag absent → disabled');
  process.env.AGENT_ANALYST = 'true';
  ok(isAnalystEnabled(), 'flag=true → enabled');

  console.log(`\n${passed} passed, ${failed} failed`);
  // Let import-time async handles (checkpointer/db) settle — exiting mid-teardown aborts node on Windows.
  await new Promise((r) => setTimeout(r, 150));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
