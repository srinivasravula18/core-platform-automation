/**
 * Coverage Plan tests (Phase 5). Proves the deterministic case→coverage classifier + closed-enum schema.
 *   npx tsx scripts/test-coverage-plan.ts   (npm run test:coverage-plan)
 */
import { coveragePlanFromCases, coveragePlanSchema, COVERAGE_KINDS } from '../server/features/agent/compiler/coveragePlan';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

function main() {
  const cases = [
    { title: 'Admin can sign in with valid credentials', tags: [] },
    { title: 'Search with no matches removes all visible rows', tags: ['filter'] },
    { title: 'Later rows can be reached from the list view', tags: [] },
    { title: 'Only users with permission can delete', tags: ['rbac'] },
    { title: 'Required field shows validation error', tags: [] },
    { title: 'Objects loads over a throttled connection', tags: [] },
  ];
  const plan = coveragePlanFromCases(cases, 'account');

  console.log('classification (first-match, deterministic)');
  eq(plan.items[1].kind, 'Filtering', 'search/no matches → Filtering');
  eq(plan.items[2].kind, 'Pagination', 'later rows → Pagination');
  eq(plan.items[3].kind, 'Permissions', 'permission/delete → Permissions');
  eq(plan.items[4].kind, 'Validation', 'validation error → Validation');
  eq(plan.items[5].kind, 'Performance', 'throttled connection → Performance');

  console.log('shape');
  eq(plan.items[0].caseIndex, 0, 'caseIndex preserved');
  eq(plan.items[0].targetObject, 'account', 'targetObject threaded');
  ok(plan.items.every((i) => (COVERAGE_KINDS as readonly string[]).includes(i.kind)), 'all kinds are in the closed enum');

  console.log('schema');
  ok(coveragePlanSchema.safeParse(plan).success, 'derived plan validates');
  ok(!coveragePlanSchema.safeParse({ items: [{ kind: 'Nope', title: 'x' }] }).success, 'unknown kind rejected');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
