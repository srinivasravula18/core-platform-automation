import assert from 'node:assert/strict';
import { db } from '../server/shared/storage';
import { nextArtifactId, normalizeWebsiteKey, websiteKeyForArtifact } from '../server/shared/artifactIds';

process.env.DISABLE_POSTGRES = 'true';
db.websites = [
  { id: 'WEB-1', name: 'Acme Store', baseUrl: 'https://shop.acme.test', ownerId: 'USER-1' },
  { id: 'WEB-2', name: 'Acme Admin', baseUrl: 'https://admin.acme.test', ownerId: 'USER-1' },
];
db.plans = [];
db.suites = [];
db.cases = [];
db.artifactIdCounters = {};

assert.equal(normalizeWebsiteKey('Acme Store'), 'ACME-STORE');
assert.equal(websiteKeyForArtifact({ websiteId: 'WEB-2', ownerId: 'USER-1' }), 'ACME-ADMIN');
assert.equal(websiteKeyForArtifact({ targetUrl: 'https://shop.acme.test/login', ownerId: 'USER-1' }), 'ACME-STORE');
assert.equal(websiteKeyForArtifact({ sourceText: 'Create tests for Acme Admin users', ownerId: 'USER-1' }), 'ACME-ADMIN');
assert.equal(await nextArtifactId('PLAN', { websiteId: 'WEB-1', ownerId: 'USER-1' }), 'ACME-STORE-PLAN-000001');
assert.equal(await nextArtifactId('PLAN', { websiteId: 'WEB-1', ownerId: 'USER-1' }), 'ACME-STORE-PLAN-000002');
assert.equal(await nextArtifactId('TC', { websiteId: 'WEB-1', ownerId: 'USER-1' }), 'ACME-STORE-TC-000001');

const { Plans, Suites, Cases } = await import('../server/db/repository');
db.artifactIdCounters = {};
db.plans = [];
db.suites = [];
db.cases = [];
assert.equal((await Plans.upsert({ name: 'Store plan', websiteId: 'WEB-1', ownerId: 'USER-1' })).id, 'ACME-STORE-PLAN-000001');
assert.equal((await Suites.upsert({ name: 'Store suite', websiteId: 'WEB-1', ownerId: 'USER-1' })).id, 'ACME-STORE-SUITE-000001');
assert.equal((await Cases.upsert({ title: 'Store case', websiteId: 'WEB-1', ownerId: 'USER-1' })).id, 'ACME-STORE-TC-000001');

console.log('artifact ids: ok');
