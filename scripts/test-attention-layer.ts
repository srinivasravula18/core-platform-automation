/**
 * Attention layer — the understanding memory is keyed by SURFACE (URL), so switching the target URL
 * (admin → keystone/runtime) is a cache MISS that re-learns, instead of recalling the previous surface's
 * auth keys / nav / grounding. Also proves same-URL stability and the no-URL fallback. Pure.
 *   npx tsx scripts/test-attention-layer.ts
 */
import assert from 'node:assert/strict';
import { understandingSubject } from '../server/agent-core/understandingProducer';
import { subjectChanged } from '../server/features/agent/workflow/goalTerms';

// Same project/app/owner, DIFFERENT surface URLs → DIFFERENT memory subjects (cache miss on switch).
const admin = { projectId: 'p1', appId: 'a1', ownerId: 'u1', appUrl: 'http://localhost:5002/' };
const keystone = { projectId: 'p1', appId: 'a1', ownerId: 'u1', appUrl: 'http://localhost:5003/shopweb' };

assert.notEqual(understandingSubject(admin), understandingSubject(keystone),
  'a URL switch (admin → keystone) yields a different understanding subject → the admin understanding is NOT recalled for keystone');

// Same URL (trailing-slash / case variance) → SAME subject (stable; no needless re-learn, no regression).
assert.equal(
  understandingSubject({ ...admin, appUrl: 'http://localhost:5002' }),
  understandingSubject({ ...admin, appUrl: 'HTTP://localhost:5002/' }),
  'the same surface normalizes to the same subject regardless of trailing slash / case',
);

// The subject embeds the surface, and keeps the app.understanding root for legacy grouping.
assert.ok(understandingSubject(admin).startsWith('app.understanding::'), 'subject is namespaced under app.understanding');
assert.ok(understandingSubject(admin).includes('localhost:5002'), 'subject carries the surface origin');

// No URL → the bare subject (backward-compatible floor).
assert.equal(understandingSubject({ projectId: 'p1' }), 'app.understanding', 'no URL → the bare subject (unchanged)');

// A different path on the same origin is still a different surface (admin root vs an app deep-link).
assert.notEqual(
  understandingSubject({ ...admin, appUrl: 'http://localhost:5003/admin' }),
  understandingSubject({ ...admin, appUrl: 'http://localhost:5003/keystone' }),
  'different paths on one origin are distinct surfaces',
);

// ---------------------------------------------------------------------------------------------
// Feature drift within ONE target: "test list view in crm" after "test account creation in crm" must
// NOT inherit the account-creation understanding. Same surface, different subject.
// ---------------------------------------------------------------------------------------------
const CRM = ['CRM', 'Core Platform'];

assert.equal(subjectChanged('test list view in crm', 'test new account creation in crm', CRM), true,
  'list view after account creation is a NEW subject — the prior understanding must be dropped');
assert.equal(subjectChanged('test account creation in crm', 'test list view in crm', CRM), true,
  'and the reverse direction too');

// A genuine continuation of the SAME feature keeps inheriting (no needless re-grounding).
assert.equal(subjectChanged('also test sorting in the list view', 'test list view in crm', CRM), false,
  'a follow-up sharing the subject keeps the prior understanding');
assert.equal(subjectChanged('test the list view filters', 'test list view', CRM), false,
  'narrowing within the same subject is not a change');

// A bare continuation names no subject → inherit rather than re-ground from nothing.
assert.equal(subjectChanged('run it again', 'test list view in crm', CRM), false,
  'a prompt with no subject terms is a continuation, not a switch');
assert.equal(subjectChanged('test list view in crm', '', CRM), false,
  'no prior subject → nothing to conflict with');

// The TARGET name alone must not read as shared subject — that is what made the drift invisible.
assert.equal(subjectChanged('test list view in crm', 'test account creation in crm', []), false,
  'without the target name filtered out, the shared app name masks the subject change (regression guard)');
assert.equal(subjectChanged('test invoices in crm', 'test accounts in crm', CRM), true,
  'two different objects in one app are different subjects');

console.log('Attention layer (understanding subject + feature drift): 14 checks passed');
