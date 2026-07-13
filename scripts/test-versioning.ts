/**
 * Versioning-driven regression tests (Phase 6). Proves the append-only Object Repository history yields
 * regression signals when a control's verified shape changes across runs.
 *   npx tsx scripts/test-versioning.ts   (npm run test:versioning)
 */
import { upsertControl, _clearObjectRepository, objectRepositoryKey } from '../server/features/agent/graph/objectRepository';
import { controlRegression, computeRegressions } from '../server/features/agent/graph/versioning';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

function main() {
  _clearObjectRepository();
  const base = { platform: 'Admin', object: 'account', control: 'NewButton' };
  const key = objectRepositoryKey(base);

  console.log('stable control → no regression');
  upsertControl({ ...base, selector: '#new', selectorType: 'css' }, '2026-07-10T00:00:00Z');
  upsertControl({ ...base, selector: '#new', selectorType: 'css' }, '2026-07-11T00:00:00Z');
  ok(controlRegression(key) === null, 'unchanged control → no signal');

  console.log('selector change → regression signal');
  upsertControl({ ...base, selector: '#new-v2', selectorType: 'css' }, '2026-07-12T00:00:00Z');
  const sig = controlRegression(key);
  ok(!!sig && sig.kind === 'selector-changed', 'selector change detected');
  eq(sig?.before, '#new', 'before = original selector (from history)');
  eq(sig?.after, '#new-v2', 'after = current selector');
  eq([sig?.fromVersion, sig?.toVersion], [1, 2], 'version delta 1 → 2');

  console.log('computeRegressions over a scope');
  upsertControl({ platform: 'Admin', object: 'contact', control: 'Save', selector: '#s', selectorType: 'css' }, '2026-07-10T00:00:00Z'); // stable
  const all = computeRegressions({ platform: 'Admin' });
  eq(all.length, 1, 'only the changed control is a regression');
  eq(all[0].control, 'NewButton', 'the evolved control is reported');

  _clearObjectRepository();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
