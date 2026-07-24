import assert from 'node:assert/strict';
import {
  applyAIReworkProposal,
  isAIReworkProposalStale,
  singleCaseProposal,
  suiteCaseProposal,
} from '../src/lib/aiRework';

const cases = [
  { title: 'Create app', priority: 'High', tags: ['ui'], steps: [{ action: 'Save', expected: 'App is created' }] },
  { title: 'Require label', priority: 'High', tags: ['validation'], steps: [{ action: 'Clear label', expected: 'Save is blocked' }] },
];

const proposal = suiteCaseProposal(cases, {
  updatedCases: [{
    index: 1,
    testCase: {
      ...cases[1],
      steps: [
        ...cases[1].steps,
        { action: 'Submit the empty form', expected: 'A required-field message appears' },
      ],
    },
  }],
  newCases: [{
    title: 'Reject duplicate API name',
    priority: 'High',
    tags: ['validation'],
    steps: [{ action: 'Reuse an API name', expected: 'Save is blocked' }],
  }],
});

assert.equal(proposal.items.length, 2);
assert.equal(isAIReworkProposalStale(cases, proposal), false);

const onlyNew = applyAIReworkProposal(cases, proposal, new Set(['new-0']));
assert.equal(onlyNew.cases.length, 3);
assert.equal(onlyNew.cases[1].steps.length, 1);

const onlyUpdate = applyAIReworkProposal(cases, proposal, new Set(['updated-1']));
assert.equal(onlyUpdate.cases.length, 2);
assert.equal(onlyUpdate.cases[1].steps.length, 2);

const staleCases = cases.map((testCase, index) => index === 1 ? { ...testCase, title: 'Edited manually' } : testCase);
assert.equal(isAIReworkProposalStale(staleCases, proposal), true);
assert.throws(() => applyAIReworkProposal(staleCases, proposal, new Set(['updated-1'])), /changed after the preview/);

const single = singleCaseProposal(cases[0], { ...cases[0], priority: 'Critical' });
assert.equal(applyAIReworkProposal([cases[0]], single, new Set(['updated-0'])).cases[0].priority, 'Critical');

console.log('AI rework proposal checks passed.');
