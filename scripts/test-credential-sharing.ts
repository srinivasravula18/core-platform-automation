import assert from 'node:assert/strict';
import { db } from '../server/shared/storage';
import { canManageWebsite, canUseWebsite, type Website } from '../server/features/credentials/credentialsService';
import type { Grants } from '../server/features/auth/groupStore';

const priorUsers = db.users;
const grants: Grants = { features: [], projects: [], websites: '*', providers: [] };
const website = (ownerId: string, shared = false): Website => ({
  id: `WEB-${ownerId}`,
  name: ownerId,
  baseUrl: `https://${ownerId}.example.com`,
  environment: 'staging',
  description: '',
  tags: [],
  ownerId,
  shared,
  createdAt: new Date(0).toISOString(),
});

try {
  db.users = [
    { id: 'admin', role: 'admin' },
    { id: 'member-a', role: 'tester' },
    { id: 'member-b', role: 'tester' },
  ];

  assert.equal(canUseWebsite(website('admin'), 'member-b', grants), true);
  assert.equal(canManageWebsite(website('admin'), 'member-b', grants), true);
  assert.equal(canUseWebsite(website('member-a'), 'member-b', grants), false);
  assert.equal(canManageWebsite(website('member-a'), 'member-b', grants), false);
  assert.equal(canUseWebsite(website('member-a'), 'member-a', grants), true);
  assert.equal(canUseWebsite(website('admin', true), 'member-b', { ...grants, websites: [] }), true);
  console.log('credential sharing isolation: ok');
} finally {
  db.users = priorUsers;
}
