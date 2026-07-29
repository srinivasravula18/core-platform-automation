import assert from 'node:assert/strict';
import { requiredPermissionFor, toPermSet, permits, presetPermissions } from '../server/features/auth/permissions';
import type { Grants } from '../server/features/auth/groupStore';

/* route → permission mapping */
assert.equal(requiredPermissionFor('POST', '/api/cases'), 'cases:create');
assert.equal(requiredPermissionFor('GET', '/api/cases'), 'cases:read');
assert.equal(requiredPermissionFor('PUT', '/api/cases/TC-1'), 'cases:update');
assert.equal(requiredPermissionFor('DELETE', '/api/cases/TC-1'), 'cases:delete');
assert.equal(requiredPermissionFor('POST', '/api/cases/bulk-delete'), 'cases:delete');
assert.equal(requiredPermissionFor('POST', '/api/runs/R-1/execute'), 'runs:execute');
assert.equal(requiredPermissionFor('POST', '/api/playwright/codegen/start'), 'record-play:start');
assert.equal(requiredPermissionFor('POST', '/api/projects'), 'project:create');
assert.equal(requiredPermissionFor('POST', '/api/projects/P-1/apps'), 'app:create');
assert.equal(requiredPermissionFor('POST', '/api/credentials/websites'), 'website:create');
assert.equal(requiredPermissionFor('GET', '/api/health'), null); // not gated
assert.equal(requiredPermissionFor('POST', '/api/auth/login'), null); // not a CRUD resource

/* admin / unrestricted passes everything */
const admin = toPermSet('UNRESTRICTED');
assert.equal(permits(admin, 'cases:delete'), true);
assert.equal(permits(admin, 'project:create'), true);

/* read-only tier: feature granted, no actions → can read, cannot write */
const readOnly = toPermSet({ features: ['cases'], projects: [], websites: [], providers: [] } as Grants);
assert.equal(permits(readOnly, 'cases:read'), true);
assert.equal(permits(readOnly, 'cases:create'), false);
assert.equal(permits(readOnly, 'cases:delete'), false);
assert.equal(permits(readOnly, 'suites:read'), false); // page not granted

/* partial tier: Record & Play page for the group, but start only for one person */
const groupMember = toPermSet({ features: ['record-play'], projects: [], websites: [], providers: [] } as Grants);
assert.equal(permits(groupMember, 'record-play:read'), true);
assert.equal(permits(groupMember, 'record-play:start'), false); // not granted the button
const theOneUser = toPermSet({ features: ['record-play'], projects: [], websites: [], providers: [], actions: ['record-play:start'] } as Grants);
assert.equal(permits(theOneUser, 'record-play:start'), true);

/* full tier */
const full = toPermSet({ features: ['cases'], projects: [], websites: [], providers: [], actions: ['cases:create', 'cases:update', 'cases:delete'] } as Grants);
assert.equal(permits(full, 'cases:delete'), true);

/* capabilities */
const creator = toPermSet({ features: [], projects: [], websites: [], providers: [], capabilities: ['project:create'] } as Grants);
assert.equal(permits(creator, 'project:create'), true);
assert.equal(permits(creator, 'website:create'), false);

/* deny wins over allow */
const denied = toPermSet({ features: ['cases'], projects: [], websites: [], providers: [], actions: ['cases:delete'], denies: ['cases:delete'] } as Grants);
assert.equal(permits(denied, 'cases:delete'), false);

/* wildcard actions */
const power = toPermSet({ features: '*', projects: [], websites: [], providers: [], actions: '*' } as Grants);
assert.equal(permits(power, 'defects:delete'), true);
assert.equal(permits(power, 'anything:read'), true);

/* preset composition */
const ro = presetPermissions('read-only', ['cases']);
assert.deepEqual(ro, ['cases:read']);
const ed = presetPermissions('editor', ['cases']);
assert.ok(ed.includes('cases:create') && ed.includes('cases:update') && !ed.includes('cases:delete'));

console.log('rbac permission resolution: ok');
