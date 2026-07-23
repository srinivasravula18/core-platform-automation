import assert from 'node:assert/strict';
import { actionableAuthorBlockers } from '../server/features/agent/liveAuthor';

assert.deepEqual(
  actionableAuthorBlockers(['The target module and workflow are unspecified.'], false),
  [],
);
assert.deepEqual(
  actionableAuthorBlockers(['Login requires a username and password.'], false),
  ['Login requires a username and password.'],
);
assert.deepEqual(
  actionableAuthorBlockers(['Login requires a username and password.'], true),
  [],
);

console.log('script author blocker checks passed');
