import assert from 'node:assert/strict';
import { diffCaseRevisions } from '../src/lib/caseRevisionDiff';

const differences = diffCaseRevisions(
  {
    title: 'Create app',
    description: 'Old description',
    preconditions: 'Signed in',
    steps: [
      { action: 'Click New', expected: 'Form opens' },
      { action: 'Click Create', expected: 'App is created' },
    ],
  },
  {
    title: 'Create application',
    description: 'Old description',
    preconditions: 'Signed in',
    steps: [
      { action: 'Click New', expected: 'New App form opens' },
      { action: 'Enter required details', expected: 'Fields are valid' },
      { action: 'Click Create', expected: 'Application is created' },
    ],
  },
);

assert.deepEqual(differences.map(({ label, status }) => ({ label, status })), [
  { label: 'Title', status: 'changed' },
  { label: 'Step 1', status: 'changed' },
  { label: 'Step 2', status: 'changed' },
  { label: 'Step 3', status: 'added' },
]);
assert.equal(differences[1].before?.expected, 'Form opens');
assert.equal(differences[1].after?.expected, 'New App form opens');

console.log('case revision diff checks passed');
