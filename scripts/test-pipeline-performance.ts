import assert from 'node:assert/strict';
import { isGroundedListViewInspection } from '../server/features/agent/inspectionService';
import { appearsAuthenticatedSurface } from '../server/features/evidence/evidenceService';

const grounded = {
  tables: [{ headers: ['Name'], rowCount: 2 }],
  listLikeRegions: [],
  actions: [{ text: 'Refresh list view' }],
  bodyText: 'All Roles 0 of 6 roles selected',
};

assert.equal(isGroundedListViewInspection('Test the Roles list view', grounded), true);
assert.equal(isGroundedListViewInspection('Test object settings', grounded), false);
assert.equal(isGroundedListViewInspection('Test the Roles list view', { ...grounded, bodyText: 'Loading records…' }), false);
assert.equal(isGroundedListViewInspection('Test the Roles list view', { ...grounded, actions: [] }), false);
assert.equal(appearsAuthenticatedSurface({ hasPasswordField: false, landmarkCount: 2, bodyText: 'Roles All Roles' }), true);
assert.equal(appearsAuthenticatedSurface({ hasPasswordField: true, landmarkCount: 2, bodyText: 'Log in' }), false);

console.log('pipeline performance/auth guards: 6 checks passed');
