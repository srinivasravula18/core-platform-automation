/**
 * Attention layer — the understanding memory is keyed by SURFACE (URL), so switching the target URL
 * (admin → keystone/runtime) is a cache MISS that re-learns, instead of recalling the previous surface's
 * auth keys / nav / grounding. Also proves same-URL stability and the no-URL fallback. Pure.
 *   npx tsx scripts/test-attention-layer.ts
 */
import assert from 'node:assert/strict';
import { understandingSubject } from '../server/agent-core/understandingProducer';

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

console.log('Attention layer (understanding subject): 6 checks passed');
