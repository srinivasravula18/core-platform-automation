/**
 * Behavior Oracle golden test (observe-then-assert, Phase A) — the pure logic that turns a live-form PROBE
 * into authoring rules + critic refutations. Models the REAL Admin "New App" form behaviour (measured from
 * apps/admin/src/components/AdminCreateAppModal.tsx): Label/API Name/Prefix/Parent required; Version optional;
 * API Name auto-derives from Label; Prefix lowercases; validation appears inline only AFTER Create.
 *
 * Proves the oracle catches the exact production failure class the sequencing heuristic could not: asserting a
 * validation error on a field the case FILLED, on an OPTIONAL field, or on an AUTO-DERIVED field — while
 * accepting a correct single-field-isolation validation case.
 *   npx tsx scripts/test-behavior-oracle.ts
 */
import { classifyTransform, renderBehaviorForPrompt, behaviorCritique, isRequiredField, isConfidentlyOptional, type BehaviorObservation } from '../server/features/agent/behaviorOracle';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

const OBS: BehaviorObservation = {
  probed: true,
  validationTriggered: true,
  requiresSubmitToValidate: true,
  validationMechanism: 'inline-text',
  submitLabel: 'Create',
  fields: [
    { label: 'Label', fieldId: 'create-app-label', requiredObserved: true, requiredDeclared: true },
    { label: 'API Name', fieldId: 'create-app-api', requiredObserved: true, requiredDeclared: true, autoDerivedFrom: 'Label' },
    { label: 'Prefix', fieldId: 'create-app-prefix', requiredObserved: true, requiredDeclared: true, transform: 'lowercase' },
    // Version: errors on a FULLY-EMPTY submit (cosmetic client fallback) but has NO `*` — truly optional.
    { label: 'Version', fieldId: 'create-app-version', requiredObserved: true },
    { label: 'Parent App', fieldId: 'create-app-parent', requiredObserved: true, requiredDeclared: true },
  ],
};

function main() {
  console.log('classifyTransform — reads the app transform from typed→stored value');
  ok(classifyTransform('Abc', 'Abc') === 'verbatim', 'unchanged value → verbatim');
  ok(classifyTransform('ABC', 'abc') === 'lowercase', 'lowercased value → lowercase');
  ok(classifyTransform('abc', 'ABC') === 'uppercase', 'uppercased value → uppercase');
  ok(classifyTransform(' abc ', 'abc') === 'trim', 'trimmed value → trim');
  ok(classifyTransform('abcdef', 'abc', 3) === 'truncated', 'maxlength-clipped value → truncated');
  ok(classifyTransform('abc', 'xyz') === 'verbatim', 'unrelated value → verbatim (conservative, no false transform)');

  console.log('renderBehaviorForPrompt — measured facts become authoring rules');
  const r = renderBehaviorForPrompt(OBS);
  ok(/Fields the app requires/i.test(r) && /Label/.test(r) && /Prefix/.test(r), 'lists the fields the app rejects when empty');
  ok(/NO error when submitted empty/i.test(r) && /Version/.test(r), 'flags Version as NOT a validation case (optional)');
  ok(/AUTO-DERIVES from "Label"/.test(r), 'records API Name auto-derives from Label');
  ok(/transformed on entry \(lowercase\)/i.test(r), 'records Prefix lowercases on entry');
  ok(/leave ONLY X empty/i.test(r), 'teaches single-field-isolation for validation cases');
  ok(renderBehaviorForPrompt({ ...OBS, probed: false }) === '', 'un-probed observation renders nothing (no guessing)');

  console.log('behaviorCritique — refutes validation asserts that contradict the observation');
  // The exact v7 failure: fills Label, then asserts a required error on Label.
  const filled = behaviorCritique({
    title: 'Label is required to create an App',
    steps: [
      { action: 'Fill the Label field with "My App"', expected: 'The Label is accepted' },
      { action: 'Observe the Label field', expected: 'A required-field error is shown for Label' },
    ],
  }, OBS);
  ok(filled.some((i) => i.code === 'assert-filled-field'), 'refutes a required-error asserted on a field the case just filled');

  // Validation asserted on a field that errors on a fully-empty submit but has NO required marker (Version).
  // This is the cosmetic false-positive that caused the flaky Version case — must be treated as optional.
  ok(isRequiredField(OBS.fields[3], OBS) === false, 'a field with no `*` is NOT required even though it errored on a fully-empty submit (declared markers win)');
  const nonReq = behaviorCritique({
    title: 'Version is required',
    steps: [
      { action: 'Leave the Version field empty and click Create', expected: 'A required-field error is shown for Version' },
    ],
  }, OBS);
  ok(nonReq.some((i) => i.code === 'assert-nonrequired'), 'refutes a validation assert on a cosmetically-required-but-not-declared field');

  // Validation asserted on an AUTO-DERIVED field without clearing it.
  const derived = behaviorCritique({
    title: 'API Name is required',
    steps: [
      { action: 'Leave the API Name field empty and click Create', expected: 'A required error is shown for API Name' },
    ],
  }, OBS);
  ok(derived.some((i) => i.code === 'assert-autoderived'), 'refutes a "required" assert on an auto-derived field');

  // CORRECT single-field isolation: fill every other required field, leave ONLY Prefix empty, then assert.
  const correct = behaviorCritique({
    title: 'Prefix is required',
    steps: [
      { action: 'Fill the Label field with "My App"', expected: 'Label accepted' },
      { action: 'Select a Parent App', expected: 'Parent chosen' },
      { action: 'Leave the Prefix field empty and click Create', expected: 'A required-field error is shown for Prefix' },
    ],
  }, OBS);
  ok(correct.length === 0, 'accepts a correct single-field-isolation validation case (no false refutation)');

  // Positive create case that merely mentions required fields → not a validation case.
  const positive = behaviorCritique({
    title: 'Create an app with all required fields',
    steps: [
      { action: 'Fill the Label field', expected: 'Label accepted' },
      { action: 'Click Create', expected: 'The app is created and appears in the list' },
    ],
  }, OBS);
  ok(positive.length === 0, 'does not treat a positive "with all required fields" create as a validation case');

  // No-op safety: an un-probed observation never refutes.
  ok(behaviorCritique({ title: 'Label is required', steps: [{ action: 'Fill Label', expected: 'error for Label' }] }, { ...OBS, probed: false }).length === 0, 'un-probed observation produces no refutations');

  console.log('Safety — a probe that did NOT trigger validation must not suppress or refute (the submit-not-found bug)');
  // Probe found fields + DOM-declared required markers, but the empty submit triggered nothing (validationTriggered:false).
  const INCONCLUSIVE: BehaviorObservation = {
    probed: true, validationTriggered: false, requiresSubmitToValidate: false, validationMechanism: 'none', submitLabel: 'Create',
    fields: [
      { label: 'Label', fieldId: 'l', requiredObserved: false, requiredDeclared: true },
      { label: 'Prefix', fieldId: 'p', requiredObserved: false, requiredDeclared: true },
      { label: 'Notes', fieldId: 'n', requiredObserved: false },
    ],
  };
  ok(isRequiredField(INCONCLUSIVE.fields[0]), 'a DOM-declared-required field counts as required even when the probe did not trigger');
  ok(!isConfidentlyOptional(INCONCLUSIVE, INCONCLUSIVE.fields[2]), 'a field is NOT confidently optional when the probe never triggered validation');
  const r2 = renderBehaviorForPrompt(INCONCLUSIVE);
  ok(/requires.*Label, Prefix/i.test(r2) && !/do NOT author a "required"\/validation case/.test(r2), 'inconclusive probe lists declared-required fields and suppresses NOTHING');
  const notSuppressed = behaviorCritique({
    title: 'Prefix is required',
    steps: [{ action: 'Leave Prefix empty and click Create', expected: 'A required error is shown for Prefix' }],
  }, INCONCLUSIVE);
  ok(notSuppressed.length === 0, 'a validation case is NOT refuted when the probe could not prove the field optional');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
