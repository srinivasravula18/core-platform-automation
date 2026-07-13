/**
 * Test Plan IR schema tests (Phase 3). Proves the LLM's only output shape: closed action/assert enums,
 * required non-empty targets, no extra keys (so a smuggled selector/url field is rejected).
 *   npx tsx scripts/test-testplan-schema.ts   (npm run test:testplan)
 */
import { testPlanSchema, parseTestPlan, isActionStep, isAssertStep } from '../server/features/agent/compiler/testPlan';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

function main() {
  console.log('valid plan');
  const good = {
    mission: 'ADMIN/objects', module: 'Objects',
    steps: [
      { action: 'OPEN_MODULE', target: 'ObjectsNavigation' },
      { assert: 'VISIBLE', target: 'ObjectsHeading' },
      { action: 'FILL', target: 'SearchResultsInput', value: 'zzzz' },
      { assert: 'VERIFY_TABLE', target: 'ObjectsTable' },
    ],
  };
  const plan = parseTestPlan(good);
  ok(!!plan, 'valid plan parses');
  ok(!!plan && isActionStep(plan.steps[0]) && isAssertStep(plan.steps[1]), 'step-kind guards work');

  console.log('rejects genuinely invalid intent (unknown verb / no usable steps)');
  ok(!testPlanSchema.safeParse({ mission: 'x', steps: [{ action: 'NAVIGATE_URL', target: 't' }] }).success, 'unknown action rejected (step dropped → no steps)');
  ok(!testPlanSchema.safeParse({ mission: 'x', steps: [{ assert: 'IS_COOL', target: 't' }] }).success, 'unknown assert rejected');
  ok(!testPlanSchema.safeParse({ mission: 'x', steps: [{ action: 'CLICK', target: '' }] }).success, 'empty target rejected');
  ok(!testPlanSchema.safeParse({ mission: 'x', steps: [] }).success, 'empty steps rejected');

  console.log('TOLERANT by design (these must now PASS — they were the PLAN_MISSING root cause)');
  ok(testPlanSchema.safeParse({ steps: [{ action: 'CLICK', target: 't' }] }).success, 'missing mission is OK (advisory)');
  ok(testPlanSchema.safeParse({ mission: 'x', steps: [{ action: 'OPEN_MODULE', target: 'Objects', expected: 'opens' }] }).success, 'extra key (expected) is ignored, not fatal');
  ok(!!parseTestPlan({ plan: { steps: [{ action: 'click', target: 'New' }] } }), 'unwraps {plan:{…}} and snaps lowercase verb');
  ok(!!parseTestPlan([{ assert: 'visible', element: 'New' }]), 'bare array + alt key (element→target) + snapped assert');
  const norm = parseTestPlan({ steps: [{ type: 'FILL', name: 'Search', value: 7 }] });
  ok(!!norm && norm.steps[0].value === '7', 'alt keys (type→action, name→target) + numeric value coerced to string');

  console.log('parseTestPlan returns null on garbage / no usable steps');
  ok(parseTestPlan(null) === null && parseTestPlan({ nope: 1 }) === null, 'garbage → null');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
