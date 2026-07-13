/**
 * QA Knowledge Graph tests (Phase 6). Proves Requirement→Coverage→Case→Script→Evidence traceability builds
 * from a run and that a case can be explained end-to-end.
 *   npx tsx scripts/test-knowledge-graph.ts   (npm run test:knowledge-graph)
 */
import { buildKnowledgeGraphFromRun, explainCase } from '../server/features/agent/graph/knowledgeGraph';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

function main() {
  const run: any = {
    prompt: 'Test the Objects list view',
    mission_context: { executionScope: 'ADMIN/objects' },
    coverage_plan: [
      { kind: 'Selection', title: 'Objects list appears', score: 4, caseIndex: 0 },
      { kind: 'Filtering', title: 'Search with no matches', score: 5, caseIndex: 1 },
    ],
    generated_cases: [
      { title: 'Objects list appears' },
      { title: 'Search with no matches' },
    ],
    playwright_scripts: [
      { test_case_title: 'Objects list appears', filename: 'objects-list-appears.spec.ts', code: '' },
      { test_case_title: 'Search with no matches', filename: 'search-with-no-matches.spec.ts', code: '' },
    ],
    execution_result: { ok: false, total: 2, passed: 1, failed: 1 },
    compiler_diagnostics: [{ caseIndex: 1, title: 'Search with no matches', kind: 'UNRESOLVED_SELECTOR', message: 'x', target: 'Ghost' }],
  };

  const kg = buildKnowledgeGraphFromRun(run);

  console.log('nodes across the chain');
  eq(kg.nodes.filter((n) => n.kind === 'requirement').length, 1, 'one requirement');
  eq(kg.nodes.filter((n) => n.kind === 'coverage').length, 2, 'two coverage items');
  eq(kg.nodes.filter((n) => n.kind === 'case').length, 2, 'two cases');
  eq(kg.nodes.filter((n) => n.kind === 'script').length, 2, 'two scripts');
  eq(kg.nodes.filter((n) => n.kind === 'evidence').length, 1, 'one evidence node');
  ok(kg.nodes.some((n) => n.kind === 'bug'), 'failing tests + ungrounded targets surface bugs');

  console.log('traceability: explain a case end-to-end');
  const explained = explainCase(kg, 'case:objects_list_appears');
  ok(!!explained.case, 'case node found');
  eq(explained.coverage.length, 1, 'case traces to its coverage item');
  eq(explained.requirement.length >= 1, true, 'case traces up to the requirement');
  eq(explained.scripts.length, 1, 'case traces to its implementing script');
  eq(explained.evidence.length, 1, 'script traces to execution evidence');

  console.log('edges are typed');
  ok(kg.edges.some((e) => e.kind === 'refines') && kg.edges.some((e) => e.kind === 'covers') && kg.edges.some((e) => e.kind === 'implements') && kg.edges.some((e) => e.kind === 'proves'), 'refines/covers/implements/proves present');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
