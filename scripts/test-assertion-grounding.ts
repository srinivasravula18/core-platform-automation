/**
 * Deterministic proof of ASSERTION_GROUNDING_V1: an expectText value that only REFORMATS the target's
 * real observed label is corrected to the actual on-page text (else literal toContainText fails a correct
 * app). No SUT/LLM — pure compiler in/out, so the result is not confounded by authoring non-determinism.
 *   npx tsx scripts/test-assertion-grounding.ts
 */
import { buildMissionContext } from '../server/features/agent/mission/missionContext';
import { buildEvidenceGraphFromRun } from '../server/features/agent/graph/evidenceGraph';
import { playwrightCompiler } from '../server/features/agent/compiler/playwrightCompiler';
import type { TestPlan } from '../server/features/agent/compiler/testPlan';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

const vs = (id: string, role: string, label: string, selector: string, selectorType: string) => ({
  id, elementType: role, role, label, selector, selectorType, verified: true,
  verificationStatus: 'verified', confidence: 'verified-live',
  provenance: 'LIVE_DOM', visibility: true, uniqueness: true, sourceEvidenceId: 'dom', fallbackSelector: null,
});

function compileWithFlag(flag: boolean): string {
  const prev = process.env.ASSERTION_GROUNDING_V1;
  process.env.ASSERTION_GROUNDING_V1 = flag ? 'true' : '';
  try {
    const runtime = buildMissionContext({ platformType: 'RUNTIME', baseUrl: 'https://h/keystone/', runtimeSurface: 'keystone', application: { id: 'a', name: 'CRM' }, module: { id: 'm', name: 'M' } });
    // The real on-page text carries punctuation; the model paraphrases it (spaces, no punctuation).
    const run: any = { selector_registry: { verified_selectors: [vs('sel_tq', 'cell', 'task_queues:104', '#tq', 'css')] } };
    const graph = buildEvidenceGraphFromRun(run, { platform: 'Keystone', module: 'm' });
    const plan: TestPlan = {
      mission: runtime.executionScope, module: 'M', title: 't',
      // semanticName of "task_queues:104" is "TaskQueues104"; the asserted value only reformats the label.
      steps: [{ assert: 'HAS_TEXT', target: 'TaskQueues104', value: 'Task Queues 104' } as any],
    };
    return playwrightCompiler.compile({ mission: runtime, plan, evidenceGraph: graph, run }).code;
  } finally {
    if (prev === undefined) delete process.env.ASSERTION_GROUNDING_V1; else process.env.ASSERTION_GROUNDING_V1 = prev;
  }
}

console.log('ASSERTION_GROUNDING_V1 — reformatted expectText value is grounded to the real observed text');
const off = compileWithFlag(false);
const on = compileWithFlag(true);

ok(off.includes('expectText('), 'both emit a text assertion');
ok(off.includes('"Task Queues 104"'), 'OFF (baseline): asserts the model\'s reformatted value verbatim (would fail literal toContainText)');
ok(on.includes('"task_queues:104"'), 'ON: asserts the REAL observed on-page text');
ok(!on.includes('"Task Queues 104"'), 'ON: the model\'s paraphrase is no longer asserted');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
