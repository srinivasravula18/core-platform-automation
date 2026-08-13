/**
 * Projects and apps must have distinct names: a duplicate is indistinguishable in every picker,
 * scope chip and run record, and silently splits a user's work across two identical-looking scopes.
 */

import assert from 'node:assert/strict';
import { db } from '../server/shared/storage';
import { createProject, updateProject, createApp, updateApp } from '../server/features/projects/projectService';

(db as any).projects = [];
(db as any).apps = [];

const throws = (fn: () => unknown, match: RegExp, label: string) => {
  assert.throws(fn, match, label);
};

const core = createProject({ name: 'Core Platform', repoKind: 'local', repoPath: 'D:\\repo', ownerId: 'u1' });

// Same owner cannot reuse the name — however it is cased or spaced.
for (const name of ['Core Platform', 'core platform', '  CORE   platform  ']) {
  throws(() => createProject({ name, repoKind: 'local', repoPath: 'D:\\other', ownerId: 'u1' }), /already exists/i, `duplicate project "${name}"`);
}

// A different owner has their own namespace, and a different name is fine.
const otherOwner = createProject({ name: 'Core Platform', repoKind: 'local', repoPath: 'D:\\repo', ownerId: 'u2' });
assert.equal(otherOwner.ownerId, 'u2');
const second = createProject({ name: 'Billing', repoKind: 'local', repoPath: 'D:\\billing', ownerId: 'u1' });

// Renaming onto an existing name is the same clash; renaming to itself is not.
throws(() => updateProject(second.id, { name: 'Core Platform' }), /already exists/i, 'rename onto a taken name');
assert.equal(updateProject(second.id, { name: 'Billing' }).name, 'Billing');
assert.equal(updateProject(second.id, { name: 'Billing Portal' }).name, 'Billing Portal');

// Apps are unique within their project, not across projects.
createApp(core.id, { name: 'Admin' });
throws(() => createApp(core.id, { name: 'admin' }), /already has an application/i, 'duplicate app in one project');
const billingAdmin = createApp(second.id, { name: 'Admin' });
assert.equal(billingAdmin.name, 'Admin', 'the same app name in another project is allowed');

const keystone = createApp(core.id, { name: 'Keystone' });
throws(() => updateApp(keystone.id, { name: 'Admin' }), /already has an application/i, 'rename onto a taken app name');
assert.equal(updateApp(keystone.id, { name: 'Keystone' }).name, 'Keystone');

console.log('Project + app name uniqueness checks passed.');
