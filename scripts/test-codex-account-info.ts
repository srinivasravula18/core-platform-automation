import assert from 'node:assert/strict';
import { maskAccountIdentifier } from '../server/features/settings/aiRoutes';

assert.equal(maskAccountIdentifier('jane.doe@example.com'), 'ja******@example.com');
assert.equal(maskAccountIdentifier('a@example.com'), 'a***@example.com');
assert.equal(maskAccountIdentifier(null), '');

console.log('Codex account masking checks passed.');
