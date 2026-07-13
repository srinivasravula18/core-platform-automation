/**
 * Object Repository tests (Phase 1). Proves persistent, append-only VERSIONING: same shape → no new version
 * (touch only); changed shape → prior snapshot preserved in history + new version minted. Deterministic via
 * injected timestamps; offline (backed by the in-memory db store).
 *   npx tsx scripts/test-object-repository.ts   (npm run test:object-repository)
 */
import {
  upsertControl, getControl, listControls, controlHistory, objectRepositoryKey, _clearObjectRepository,
} from '../server/features/agent/graph/objectRepository';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

function main() {
  _clearObjectRepository();

  const base = { platform: 'Admin', module: 'objects', object: 'account', control: 'NewButton' };

  console.log('insert');
  const r1 = upsertControl({ ...base, selector: '[data-testid="new_btn"]', selectorType: 'testid', role: 'button', label: 'New' }, '2026-07-10T00:00:00Z');
  eq(r1.current.version, 1, 'first upsert → version 1');
  eq(r1.history.length, 0, 'no history yet');
  eq(r1.key, objectRepositoryKey(base), 'stable composite key');

  console.log('re-verify same shape → touch only, NO new version');
  const r2 = upsertControl({ ...base, selector: '[data-testid="new_btn"]', selectorType: 'testid', role: 'button', label: 'New' }, '2026-07-11T00:00:00Z');
  eq(r2.current.version, 1, 'unchanged shape stays version 1');
  eq(r2.history.length, 0, 'no history minted on re-verify');
  eq(r2.current.lastVerified, '2026-07-11T00:00:00Z', 'lastVerified touched');

  console.log('shape change → append-only version bump');
  const r3 = upsertControl({ ...base, selector: '#new-button', selectorType: 'css', role: 'button', label: 'New' }, '2026-07-12T00:00:00Z');
  eq(r3.current.version, 2, 'changed shape → version 2');
  eq(r3.history.length, 1, 'prior snapshot preserved in history');
  eq(r3.history[0].selector, '[data-testid="new_btn"]', 'history keeps the ORIGINAL selector (never overwritten)');
  eq(r3.current.selector, '#new-button', 'current holds the new selector');

  console.log('history lineage + retrieval');
  const hist = controlHistory(r3.key);
  eq(hist.map((h) => h.version), [1, 2], 'lineage oldest→newest');
  eq(getControl(r3.key)?.current.version, 2, 'getControl returns current');

  console.log('scoped listing');
  upsertControl({ platform: 'Keystone', application: 'CRM', module: 'accounts', object: 'account', control: 'SaveButton', selector: '#save', selectorType: 'css' }, '2026-07-10T00:00:00Z');
  eq(listControls({ platform: 'Admin' }).length, 1, 'filter by platform Admin');
  eq(listControls({ platform: 'Keystone', application: 'CRM' }).length, 1, 'filter by platform+application');
  eq(listControls().length, 2, 'two total records');

  _clearObjectRepository();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
