import assert from 'node:assert/strict';
import { collectRunEvidence, evidenceDownloadName } from '../core/shared/runEvidence';

const items = collectRunEvidence({
  steps: [
    { step: '1.1', action: 'Open page', outcome: 'Pass', screenshot: '/evidence/step-1.png', testCaseTitle: 'Login' },
    { step: '1.2', action: 'Submit', outcome: 'Pass', screenshot: '/evidence/step-2.png', testCaseTitle: 'Login' },
  ],
  evidence: [{
    testCaseIndex: 0,
    title: 'Login',
    stepScreenshots: ['/evidence/step-1.png', '/evidence/step-2.png'],
    screenshotUrl: '/evidence/final.png',
  }],
}, [{ id: 'TC-1', title: 'Login' }]);

assert.deepEqual(items.map((item) => [item.caseId, item.stepIndex, item.url]), [
  ['TC-1', 1, '/evidence/step-1.png'],
  ['TC-1', 2, '/evidence/step-2.png'],
  ['TC-1', null, '/evidence/final.png'],
]);
assert.equal(evidenceDownloadName('RUN-1', items[0]), 'RUN-1-TC-1-step-1.png');
console.log('run evidence export checks passed');
