/**
 * Deterministic proof of: an expectText value that only REFORMATS the target's
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

function compile(): string {
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
  }
}

console.log('Assertion grounding — a reformatted expectText value is grounded to the real observed text');
const on = compile();

ok(on.includes('expectText('), 'a text assertion is emitted');
ok(on.includes('"task_queues:104"'), 'asserts the REAL observed on-page text');
ok(!on.includes('"Task Queues 104"'), 'the model\'s paraphrase is never asserted');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
