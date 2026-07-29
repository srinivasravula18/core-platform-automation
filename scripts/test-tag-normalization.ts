import assert from 'node:assert/strict';
import { normalizeTag, normalizeTags } from '../src/lib/tags';

assert.equal(normalizeTag('Smoke Test'), '@smoke-test');
assert.equal(normalizeTag('@Regression'), '@regression');
assert.deepEqual(normalizeTags(['smoke', '@smoke', '#API']), ['@smoke', '@api']);

console.log('tag normalization checks passed');
