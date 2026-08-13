import assert from 'node:assert/strict';
import { caseCountIssues } from '../server/features/agent/workflow/nodes/authoring';

assert(caseCountIssues([{}, {}], 0).length, 'auto mode must reject only two cases');
assert.equal(caseCountIssues(Array.from({ length: 5 }, () => ({})), 0).length, 0, 'auto mode accepts five grounded cases');
assert(caseCountIssues(Array.from({ length: 3 }, () => ({})), 2).length, 'an explicit count must be exact');
assert.equal(caseCountIssues([{}, {}], 2).length, 0, 'an exact user count is preserved');

console.log('case count contract: ok');
