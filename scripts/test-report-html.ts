import assert from 'node:assert/strict';
import { toReportHTML } from '../src/lib/exportData';

const html = toReportHTML({
  name: '<Checkout>', suiteName: 'Payments', executionTime: '3.2s',
  steps: [{ action: 'Submit order', expected: 'Success', actual: '<script>alert(1)</script>', outcome: 'Fail', durationMs: 1200 }],
}, { run: { tags: ['@smoke'], triggerMeta: { environment: 'UAT' } } });

assert.match(html, /Environment[\s\S]*UAT/);
assert.match(html, /Features executed[\s\S]*Payments/);
assert.match(html, /Feature: Payments/);
assert.match(html, /@smoke/);
assert.match(html, /1\.20 s/);
assert.doesNotMatch(html, /<script>alert/);
console.log('report HTML export checks passed');
