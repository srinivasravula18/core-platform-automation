import assert from 'node:assert/strict';
import { normalizeTestCaseTypes, testCaseTypeFields } from '../core/shared/testCaseTypes';

assert.deepEqual(normalizeTestCaseTypes({ testingType: 'Smoke' }), ['Smoke']);
assert.deepEqual(normalizeTestCaseTypes({ testingTypes: ['Smoke', 'Regression', 'Smoke'], testingType: 'Functional' }), ['Smoke', 'Regression']);
assert.deepEqual(testCaseTypeFields(['Security', 'Performance']), {
  testingTypes: ['Security', 'Performance'],
  testingType: 'Security',
});

console.log('test-case type checks passed');
