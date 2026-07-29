/**
 * Outcome Validator golden test (Phase B) — classifies each failure as assertion-defect / app-defect / infra /
 * unknown against the measured behaviour oracle, so a wrong test and a real bug are never confused.
 *   npx tsx scripts/test-outcome-validator.ts
 */
import { classifyFailure, classifyOutcomes } from '../server/features/agent/outcomeValidator';
import type { BehaviorObservation } from '../server/features/agent/behaviorOracle';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

const OBS: BehaviorObservation = {
  probed: true, validationTriggered: true, requiresSubmitToValidate: true, validationMechanism: 'inline-text', submitLabel: 'Create',
  fields: [
    { label: 'Label', fieldId: 'l', requiredObserved: true },
    { label: 'API Name', fieldId: 'a', requiredObserved: true, autoDerivedFrom: 'Label' },
    { label: 'Prefix', fieldId: 'p', requiredObserved: true, transform: 'lowercase' },
    { label: 'Version', fieldId: 'v', requiredObserved: false },
  ],
};

const VAL_FAIL = 'Error: expect(locator).toBeVisible() failed\nLocator: [role="alert"], [aria-invalid="true"]';

function main() {
  console.log('infra failures are separated from logic defects');
  ok(classifyFailure({ title: 'Prefix is required', error: 'Error: Timeout 30000ms exceeded net::ERR_CONNECTION_REFUSED' }, OBS).verdict === 'infra', 'timeout/net error → infra');

  console.log('assertion-defect: the test claimed something the app does not do');
  ok(classifyFailure({ title: 'Version is required to create an app', error: VAL_FAIL }, OBS).verdict === 'assertion-defect', 'validation asserted on a NON-required field → assertion-defect');
  ok(classifyFailure({ title: 'API Name is required to create an app', error: VAL_FAIL }, OBS).verdict === 'assertion-defect', 'validation asserted on an AUTO-DERIVED field → assertion-defect');
  ok(classifyFailure({ title: 'Prefix value is preserved', error: 'Error: expect(locator).toHaveValue() failed' }, OBS).verdict === 'assertion-defect', 'value assert on a TRANSFORMED field → assertion-defect');

  console.log('app-defect: the app genuinely misbehaved');
  const appDef = classifyFailure({ title: 'Prefix is required to create an app', error: VAL_FAIL }, OBS);
  ok(appDef.verdict === 'app-defect' && appDef.field === 'Prefix', 'required field showed NO error on submit → app-defect (real bug)');

  console.log('unknown when the oracle cannot judge');
  ok(classifyFailure({ title: 'Some unrelated case', error: VAL_FAIL }, OBS).verdict === 'unknown', 'no matching oracle field → unknown (never a false app-defect)');
  ok(classifyFailure({ title: 'Prefix is required', error: VAL_FAIL }, null).verdict === 'unknown', 'no oracle at all → unknown');

  console.log('batch summary counts each category');
  const sum = classifyOutcomes([
    { title: 'Version is required to create an app', error: VAL_FAIL },   // assertion-defect
    { title: 'Prefix is required to create an app', error: VAL_FAIL },    // app-defect
    { title: 'Label is required', error: 'net::ERR_CONNECTION_REFUSED' }, // infra
  ], OBS);
  ok(sum.assertionDefects === 1 && sum.appDefects === 1 && sum.infra === 1, 'batch tallies assertion-defect / app-defect / infra correctly');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
