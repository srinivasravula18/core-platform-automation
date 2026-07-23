import assert from 'node:assert/strict';
import { removeOwnedConversations } from '../server/features/settings/routes';

const result = removeOwnedConversations([
  { id: 'mine-1', ownerId: 'user-1' },
  { id: 'theirs', ownerId: 'user-2' },
  { id: 'legacy' },
  { id: 'mine-2', ownerId: 'user-1' },
], 'user-1');

assert.equal(result.removed, 2);
assert.deepEqual(result.remaining.map((conversation) => conversation.id), ['theirs', 'legacy']);
console.log('user chat cleanup scope: ok');
