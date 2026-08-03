import assert from 'node:assert/strict';
import { defectInputError, defectPayload } from '../server/features/resources/routes';

assert.match(defectInputError({ severity: 'Urgent' }), /severity/);
assert.match(defectInputError({ status: 'Pending' }), /status/);
assert.match(defectInputError({ attachments: [{ dataUrl: 'data:text/plain;base64,SGk=' }] }), /PNG/);
assert.match(defectInputError({ attachments: [{}, {}, {}, {}] }), /3 screenshots/);

const defect = defectPayload({
  title: 'Safari layout', severity: 'High', status: 'Open', component: 'Checkout',
  environment: 'Staging', browser: 'Safari 18', linkedCaseId: 'TC-1', linkedRunId: 'RUN-1',
}, { metadata: { occurrences: 2 }, evidence: [] }, 'DEF-1');

assert.equal(defect.metadata.component, 'Checkout');
assert.deepEqual(defect.metadata.environment, { name: 'Staging', browser: 'Safari 18' });
assert.equal(defect.metadata.occurrences, 2);
assert.equal(defect.linkedCaseId, 'TC-1');
assert.equal(defect.linkedRunId, 'RUN-1');

console.log('defect input validation and normalization: ok');
