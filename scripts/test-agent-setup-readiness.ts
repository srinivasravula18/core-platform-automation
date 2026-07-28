import assert from 'node:assert/strict';
import { hasOwnedOrGrantedResource } from '../server/features/agent/setupReadiness';
import { UNRESTRICTED, type Grants } from '../server/features/auth/groupStore';

const rows = [{ id: 'shared', ownerId: 'admin' }, { id: 'owned', ownerId: 'tester' }];
const sharedGrant: Grants = { features: [], projects: ['shared'], websites: ['shared'], providers: [] };
const noGrants: Grants = { features: [], projects: [], websites: [], providers: [] };

assert.equal(hasOwnedOrGrantedResource(rows, 'tester', noGrants, 'projects'), true);
assert.equal(hasOwnedOrGrantedResource(rows.slice(0, 1), 'tester', sharedGrant, 'projects'), true);
assert.equal(hasOwnedOrGrantedResource(rows.slice(0, 1), 'tester', noGrants, 'projects'), false);
assert.equal(hasOwnedOrGrantedResource(rows.slice(0, 1), 'tester', UNRESTRICTED, 'projects'), false);
console.log('agent setup shared-resource readiness: ok');
