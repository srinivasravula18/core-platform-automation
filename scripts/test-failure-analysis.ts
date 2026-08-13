import assert from 'node:assert/strict';
import { analyzeFailure, failureGist } from '../src/lib/failureAnalysis';

const raw = 'TOOLING_OBSCURED [tooling] - target "Status *" with generated locator: tr:has-text("Name") >> role=button[name="Status"]; resolved to an element behind an open overlay; this is a locator/tooling fault, not a product defect.';
const result = analyzeFailure(raw);

assert.equal(result.kind, 'tooling-obscured');
assert.equal(result.target, 'Status *');
assert.match(result.actual, /tr:has-text/);
assert.match(result.likelyCause, /generated-test locator defect/);
assert.match(failureGist(raw), /Status \*/);
console.log('Failure analysis: tooling locator diagnosis passed');
