import assert from 'node:assert/strict';
import { mergeScriptsByCase } from '../server/features/agent/caseCollection';

const firstBatch = [
  { test_case_title: 'Case one', filename: 'case-one.spec.ts', code: 'old one' },
  { test_case_title: 'Case two', filename: 'case-two.spec.ts', code: 'old two' },
];
const secondBatch = [
  { test_case_title: 'Case two', filename: 'case-two.spec.ts', code: 'new two' },
  { test_case_title: 'Case three', filename: 'case-three.spec.ts', code: 'new three' },
];

const merged = mergeScriptsByCase(firstBatch, secondBatch);
assert.deepEqual(merged.map((script) => script.test_case_title), ['Case one', 'Case two', 'Case three']);
assert.equal(merged.find((script) => script.test_case_title === 'Case two')?.code, 'new two');
console.log('agent script batch merge: ok');
