/**
 * Risk Analysis tests (Phase 5). Proves transparent scoring (base kind weight + change-impact from the
 * versioned Object Repository) and deterministic highest-risk-first prioritization.
 *   npx tsx scripts/test-risk-analysis.ts   (npm run test:risk-analysis)
 */
import { scoreCoverageItem, prioritizeCoverage } from '../server/features/agent/graph/riskAnalysis';
import { upsertControl, _clearObjectRepository } from '../server/features/agent/graph/objectRepository';
import type { CoverageItem } from '../server/features/agent/compiler/coveragePlan';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

function main() {
  _clearObjectRepository();

  console.log('base weights (transparent)');
  const perm = scoreCoverageItem({ kind: 'Permissions', title: 'p' });
  const sort = scoreCoverageItem({ kind: 'Sorting', title: 's' });
  ok(perm.score > sort.score, 'Permissions outweighs Sorting');
  eq(perm.factors[0].name, 'kind:Permissions', 'factor is explainable');

  console.log('change-impact from versioned Object Repository');
  // A control on "account" that evolved across runs (version 2) raises the risk of account scenarios.
  upsertControl({ platform: 'Admin', object: 'account', control: 'NewButton', selector: '#a', selectorType: 'css' }, '2026-07-10T00:00:00Z');
  upsertControl({ platform: 'Admin', object: 'account', control: 'NewButton', selector: '#b-changed', selectorType: 'css' }, '2026-07-11T00:00:00Z');
  const withChange = scoreCoverageItem({ kind: 'CRUD', title: 'c', targetObject: 'account' }, { platform: 'Admin' });
  const noChange = scoreCoverageItem({ kind: 'CRUD', title: 'c', targetObject: 'contact' }, { platform: 'Admin' });
  ok(withChange.score > noChange.score, 'evolved control raises risk');
  ok(withChange.factors.some((f) => f.name.startsWith('changed-controls')), 'change factor is recorded');

  console.log('prioritization (highest-risk-first, stable tie-break)');
  const items: CoverageItem[] = [
    { kind: 'Sorting', title: 'a', caseIndex: 0 },
    { kind: 'Permissions', title: 'b', caseIndex: 1 },
    { kind: 'Pagination', title: 'c', caseIndex: 2 },
    { kind: 'CRUD', title: 'd', caseIndex: 3 },
  ];
  const ranked = prioritizeCoverage(items, { platform: 'Admin' });
  eq(ranked.map((r) => r.item.title), ['b', 'd', 'a', 'c'], 'ordered Permissions>CRUD>Sorting>Pagination');

  _clearObjectRepository();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
