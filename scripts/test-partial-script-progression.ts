import assert from 'node:assert/strict';
import { hasRunnableScripts } from '../server/features/agent/routes';

assert.equal(hasRunnableScripts([]), false);
assert.equal(hasRunnableScripts(Array.from({ length: 17 }, (_, index) => ({ filename: `case-${index + 1}.spec.ts` }))), true);
console.log('partial script progression: ok');
