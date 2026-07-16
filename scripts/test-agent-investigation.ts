/**
 * Phase 3 — Investigation node tests. Proves (offline, stubbed LLM deps):
 *   flag-off routing is a no-op; deterministic pre-analysis stands alone; LLM classification refines it and
 *   its failure never sinks the node; the intent-outcome judge flags passing-but-wrong mutation cases; the
 *   readback seam produces a deterministic suspicious pass; budgets bound LLM calls; never throws.
 *   npx tsx scripts/test-agent-investigation.ts   (npm run test:agent-investigation)
 */
import path from 'path';
import fs from 'fs/promises';
import {
  runInvestigationNode,
  deterministicClassification,
  mutationCaseTitles,
  isInvestigationEnabled,
  type InvestigationNodeInput,
} from '../server/features/agent/workflow/nodes/investigation';
import { routeAfterExecuteTests } from '../server/features/agent/workflow/testRunGraph';
import { stashArtifacts, clearArtifacts, readArtifacts } from '../server/features/agent/workflow/artifactStash';
import { fileDefectsForRun } from '../server/features/agent/workflow/runtime';
import { createInitialWorkflowState } from '../server/features/agent/workflow/state';
import { Defects } from '../server/db/repository';
import { db } from '../server/shared/storage';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const SCRATCH = path.resolve(process.cwd(), '.testflow-pw', 'scratch', `investigation-${process.pid}`);

const failedTest = (title: string, error: string, extra: any = {}) => ({ title, file: 'x.spec.ts', status: 'failed' as const, durationMs: 500, error, ...extra });
const passedTest = (title: string) => ({ title, file: 'x.spec.ts', status: 'passed' as const, durationMs: 300 });

function baseInput(partial: Partial<InvestigationNodeInput>): InvestigationNodeInput {
  return {
    runId: 'AGENT-inv-test',
    tests: [],
    cases: [],
    compiledSources: {},
    caseTitleById: {},
    ...partial,
  };
}

async function main() {
  // Hermetic: in-memory repos, no Postgres.
  delete process.env.DATABASE_URL;
  delete process.env.DEPLOYMENT_MODE;
  process.env.NODE_ENV = 'test';
  await fs.mkdir(SCRATCH, { recursive: true });

  console.log('flag gating');
  delete process.env.AGENT_INVESTIGATE;
  ok(!isInvestigationEnabled(), 'flag absent → disabled');
  eq(routeAfterExecuteTests({ runId: 'r1', execution: { attempts: [], aggregate: { totalCases: 2, passed: 1, failed: 1, durationMs: 5 }, evidenceRefs: [] } } as any), 'finalize', 'flag off → finalize even with failures');
  process.env.AGENT_INVESTIGATE = '1';
  ok(isInvestigationEnabled(), 'flag=1 → enabled');
  eq(routeAfterExecuteTests({ runId: 'r1', execution: { attempts: [], aggregate: { totalCases: 2, passed: 1, failed: 1, durationMs: 5 }, evidenceRefs: [] } } as any), 'investigate_failures', 'flag on + failures → investigate');
  eq(routeAfterExecuteTests({ runId: 'r1', execution: { attempts: [], aggregate: null, evidenceRefs: [] } } as any), 'finalize', 'no aggregate (infra failure) → finalize');
  eq(routeAfterExecuteTests({ runId: 'r-nostash', execution: { attempts: [], aggregate: { totalCases: 2, passed: 2, failed: 0, durationMs: 5 }, evidenceRefs: [] } } as any), 'finalize', 'all-green with no mutation cases → finalize');
  stashArtifacts('r-mut', { compiledSources: { c1: 'const MISSION = {"mutationIntent":true};' } });
  eq(routeAfterExecuteTests({ runId: 'r-mut', execution: { attempts: [], aggregate: { totalCases: 1, passed: 1, failed: 0, durationMs: 5 }, evidenceRefs: [] } } as any), 'investigate_failures', 'all-green WITH mutation case → investigate (suspicious-pass check)');
  clearArtifacts('r-mut');

  console.log('deterministic classification map');
  eq(deterministicClassification('scope-violation').classification, 'automation_issue', 'scope violation → automation issue');
  eq(deterministicClassification('assertion').classification, 'functional', 'assertion → functional');
  ok(deterministicClassification('unknown').confidence <= 0.3, 'unknown kind gets honest low confidence');

  console.log('deterministic pre-analysis stands alone (no LLM dep)');
  process.env.AGENT_INVESTIGATE = '0'; // flag off → the node must not attempt its default LLM classify
  const stepLogPath = path.join(SCRATCH, 'steps.json');
  await fs.writeFile(stepLogPath, JSON.stringify([
    { n: 1, kind: 'fill', label: 'Name *', value: 'Jordan', ok: true },
    { n: 2, kind: 'click', label: 'Save', ok: false, error: 'timeout' },
  ]));
  const consolePath = path.join(SCRATCH, 'console.json');
  await fs.writeFile(consolePath, JSON.stringify([{ type: 'error', text: 'POST /api/records 500' }]));
  const r1 = await runInvestigationNode(baseInput({
    tests: [failedTest('Create account', 'Timed out 10000ms waiting for Save', { stepLogPath, consoleLogPath: consolePath })],
    deps: {}, // no classify/judge — deterministic only
  }));
  eq(r1.findings.length, 1, 'one finding per cluster');
  eq(r1.findings[0].source, 'deterministic', 'deterministic source when no LLM');
  ok(r1.findings[0].observations.some((o) => o.verifiedBy.includes('step-log')), 'step-log observation cites its evidence');
  ok(r1.findings[0].observations.some((o) => o.verifiedBy.includes('console-log')), 'console observation cites its evidence');
  eq(r1.llmCalls, 0, 'no LLM calls without a classify dep');
  process.env.AGENT_INVESTIGATE = '1';

  console.log('LLM classification refines the deterministic finding');
  const r2 = await runInvestigationNode(baseInput({
    tests: [failedTest('Create account', 'expect(locator).toContainText failed')],
    deps: {
      classify: async (ctx) => ({
        classification: 'validation', rootCauseArea: 'account create form', confidence: 0.85,
        observations: [{ statement: 'Validation rejects the generated value', confidence: 0.8, verifiedBy: ['error-text'] }],
        severity: 'High', suggestedAreas: ['required-field rules'],
      }),
    },
  }));
  eq(r2.findings[0].classification, 'validation', 'LLM classification adopted');
  eq(r2.findings[0].source, 'llm+deterministic', 'source records the merge');
  eq(r2.findings[0].severity, 'High', 'severity suggestion carried');
  eq(r2.llmCalls, 1, 'one LLM call for one cluster');
  ok(r2.findings[0].observations.length >= 2, 'deterministic + LLM observations merged');

  console.log('LLM failure never sinks the node');
  const r3 = await runInvestigationNode(baseInput({
    tests: [failedTest('Case X', 'Timed out')],
    deps: { classify: async () => { throw new Error('provider down'); } },
  }));
  eq(r3.findings.length, 1, 'finding still produced');
  eq(r3.findings[0].source, 'deterministic', 'deterministic finding survives the throw');

  console.log('classification budget bounds LLM calls');
  const manyClusters = Array.from({ length: 8 }, (_, i) => failedTest(`Case ${i}`, `Error variant number-${i} with entirely distinct text shape ${'x'.repeat(i * 7)}`));
  let calls = 0;
  const r4 = await runInvestigationNode(baseInput({
    tests: manyClusters,
    deps: { classify: async () => { calls += 1; return null; } },
  }));
  ok(r4.findings.length >= 6, `distinct errors → distinct clusters (got ${r4.findings.length})`);
  ok(calls <= 5, `classify calls capped at 5 (got ${calls})`);

  console.log('intent-outcome judge on passing mutation cases');
  const mutInput = baseInput({
    tests: [passedTest('Create account happy path'), passedTest('View list')],
    cases: [{ id: 'c1', title: 'Create account happy path', description: 'Creates a new account in CRM' }],
    compiledSources: { c1: 'const MISSION = {"mutationIntent":true}', c2: 'const MISSION = {"mutationIntent":false}' },
    caseTitleById: { c1: 'Create account happy path', c2: 'View list' },
  });
  const judged: string[] = [];
  const r5 = await runInvestigationNode({
    ...mutInput,
    deps: {
      judgeIntent: async (ctx) => {
        judged.push(ctx.title);
        return { intentSatisfied: false, confidence: 0.8, reason: 'Record landed in the wrong app', observations: [{ statement: 'appId mismatch', confidence: 0.8, verifiedBy: ['network-log'] }] };
      },
    },
  });
  eq(judged, ['Create account happy path'], 'ONLY passing mutation cases are judged');
  eq(r5.suspiciousPasses.length, 1, 'unsatisfied intent → suspicious pass');
  ok(r5.suspiciousPasses[0].reason.includes('wrong app'), 'judge reason surfaced');

  const r6 = await runInvestigationNode({
    ...mutInput,
    deps: { judgeIntent: async () => ({ intentSatisfied: true, confidence: 0.9, reason: '', observations: [] }) },
  });
  eq(r6.suspiciousPasses.length, 0, 'satisfied intent → no suspicious pass');

  console.log('readback seam: missing record = deterministic suspicious pass, no LLM needed');
  let judgeCalled = false;
  const r7 = await runInvestigationNode({
    ...mutInput,
    deps: {
      readbackRecord: async () => null,
      judgeIntent: async () => { judgeCalled = true; return { intentSatisfied: true, confidence: 1, reason: '', observations: [] }; },
    },
  });
  eq(r7.suspiciousPasses.length, 1, 'null readback → suspicious pass');
  ok(!judgeCalled, 'deterministic verdict skips the LLM judge');
  ok(r7.suspiciousPasses[0].observations.some((o) => o.verifiedBy.includes('api-readback')), 'cites api-readback');

  console.log('rerun seam (Phase 6): a passing re-run demotes to flaky');
  const r8 = await runInvestigationNode(baseInput({
    tests: [failedTest('Flaky case', 'Timed out 5000ms')],
    deps: { rerunFailing: async () => 'passed' },
  }));
  ok(r8.findings[0].flaky === true, 're-run pass marks flaky');
  eq(r8.findings[0].classification, 'synchronization', 'flaky reclassifies to synchronization');
  eq(r8.recoveryAttempts, [{ kind: 'rerun', target: 'Flaky case', outcome: 'passed' }], 'recovery attempt recorded');
  const r9 = await runInvestigationNode(baseInput({
    tests: [failedTest('Solid failure', 'Timed out 5000ms')],
    deps: { rerunFailing: async () => 'failed' },
  }));
  ok(r9.findings[0].flaky !== true, 're-run failure keeps the deterministic reading');

  console.log('never throws (hostile inputs)');
  const r10 = await runInvestigationNode(baseInput({ tests: [{ title: 'x', status: 'failed' } as any], deps: { classify: async () => ({ bad: true } as any) } }));
  ok(Array.isArray(r10.findings), 'malformed classify result tolerated');
  const r11 = await runInvestigationNode({ runId: 'r', tests: null as any, cases: null as any, compiledSources: null as any, caseTitleById: null as any });
  ok(Array.isArray(r11.findings) && r11.findings.length === 0, 'null-ish input → empty summary, no throw');

  console.log('terminal defect merge: investigation lands in defect metadata + suspicious-pass defects filed');
  {
    const runId = 'AGENT-merge-test';
    clearArtifacts(runId);
    (db as any).defects = [];
    const state = createInitialWorkflowState({
      runId, threadId: runId, requestId: `req-${runId}`,
      request: { goal: 'test', requestedCaseCount: 1, reviewPolicy: 'auto' } as any,
      mission: { platformType: 'RUNTIME', platform: 'Keystone', runtimeSurface: 'keystone', applicationId: 'app9', moduleId: 'accounts', tabId: null, targetUrl: 'https://h/keystone/?appId=app9', executionScope: 'RUNTIME/keystone/CRM/accounts' } as any,
    } as any);
    stashArtifacts(runId, {
      executionTests: [failedTest('Create account', 'Timed out waiting for Save') as any, passedTest('Create vendor') as any],
      investigation: {
        findings: [{
          signature: '', errorKind: 'timeout', failingTarget: 'Save', affectedTests: ['Create account'],
          classification: 'performance', rootCauseArea: 'save flow', confidence: 0.7,
          observations: [{ statement: 'save is slow', confidence: 0.7, verifiedBy: ['error-text'] }],
          suggestedAreas: [], source: 'llm+deterministic',
        }],
        suspiciousPasses: [{ title: 'Create vendor', reason: 'Record not found via API after create', confidence: 0.9, observations: [{ statement: 'readback empty', confidence: 0.9, verifiedBy: ['api-readback'] }] }],
        recoveryAttempts: [], llmCalls: 1,
      },
    });
    // Signature must match what the reporter computes — patch it in from the real function.
    const { failureSignature } = await import('../server/features/agent/workflow/defectReporter');
    const arts = readArtifacts(runId);
    arts.investigation!.findings[0].signature = failureSignature({ title: 'Create account', status: 'failed', error: 'Timed out waiting for Save' }).hash;

    await fileDefectsForRun(state as any, {});
    const defects = await Defects.list();
    const clustered = defects.find((d: any) => d.metadata?.errorKind === 'timeout');
    const intent = defects.find((d: any) => d.metadata?.suspiciousPass === true);
    ok(!!clustered, 'clustered defect filed');
    eq(clustered?.metadata?.investigation?.classification, 'performance', 'investigation merged into defect metadata');
    ok(!!intent, 'suspicious-pass defect filed');
    ok(String(intent?.title || '').includes('Suspicious PASS'), 'intent defect titled clearly');
    ok((intent?.tags || []).includes('@suspicious-pass'), 'intent defect tagged');
    clearArtifacts(runId);
  }

  await fs.rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
