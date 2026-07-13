/**
 * Compiled Generation tests (Phase 5). End-to-end deterministic seam: cases → coverage → risk → (injected)
 * plan → compile → gate. Proves grounded cases yield validated specs and ungrounded targets yield diagnostics
 * (never guessed scripts), all without an LLM (the planner is injected).
 *   npx tsx scripts/test-compiled-generation.ts   (npm run test:compiled-generation)
 */
import { buildMissionContext } from '../server/features/agent/mission/missionContext';
import { integrateGraphsIntoRun } from '../server/features/agent/graph/discoveryAdapter';
import { generateCompiledScripts, aiqaCompilerEnabled } from '../server/features/agent/compiler/compiledGeneration';
import { validateCompiledOutput } from '../server/features/agent/compiler/validateCompiledOutput';
import { _clearObjectRepository } from '../server/features/agent/graph/objectRepository';
import type { TestPlan } from '../server/features/agent/compiler/testPlan';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const vs = (id: string, role: string, label: string, selector: string, selectorType: string, uniqueness = true) => ({
  id, elementType: role, role, label, selector, selectorType, verified: uniqueness,
  verificationStatus: uniqueness ? 'verified' : 'not_unique', confidence: 'verified-live',
  provenance: 'LIVE_DOM', visibility: true, uniqueness, sourceEvidenceId: 'dom', fallbackSelector: null,
});

async function main() {
  _clearObjectRepository();
  const mission = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://h/admin-ui/', module: { id: 'objects', name: 'Objects' } });
  const run: any = {
    app_url: 'https://h/admin-ui/?nav=objects',
    metadata_map: { objects: [{ api_name: 'account', label: 'Account', object_id: 'o', fields: [], list_views: [], layouts: [], forms: [] }] },
    selector_registry: { verified_selectors: [
      vs('sel_new', 'button', 'New', '[data-testid="new"]', 'testid'),
      vs('sel_search', 'textbox', 'Search results', '#search', 'css'),
    ] },
  };
  integrateGraphsIntoRun(run, mission); // attaches run.evidence_graph (as the pipeline does)

  const cases = [
    { title: 'Objects list appears', tags: [] },
    { title: 'Search with no matches', tags: ['filter'] },
    { title: 'Unresolved control case', tags: [] },
  ];

  // Injected deterministic planner: emits grounded plans for cases 0/1, an ungrounded target for case 2.
  const planner = async ({ caseIndex }: { caseIndex: number }): Promise<TestPlan | null> => {
    if (caseIndex === 0) return { mission: mission.executionScope, steps: [{ assert: 'VISIBLE', target: 'New' }] };
    if (caseIndex === 1) return { mission: mission.executionScope, steps: [{ action: 'FILL', target: 'Search results', value: 'zzz' }, { assert: 'VISIBLE', target: 'New' }] };
    return { mission: mission.executionScope, steps: [{ action: 'CLICK', target: 'GhostControl' }] }; // unresolved
  };

  const res = await generateCompiledScripts({ run, mission, testCases: cases, generatePlan: planner });

  console.log('grounded cases → validated specs');
  eq(res.scripts.length, 2, 'two grounded cases compiled');
  ok(res.scripts.every((s) => validateCompiledOutput(s.code).ok), 'every emitted spec passes the validation gate');
  ok(res.scripts.every((s) => s.code.includes("import { MissionRunner } from './mission-runner'")), 'specs use MissionRunner');
  ok(res.scripts.every((s) => !/page\.goto|new URL|loginIfNeeded|\.first\(/.test(s.code)), 'no forbidden constructs');
  ok(new Set(res.scripts.map((s) => s.filename)).size === 2, 'filenames are unique');

  console.log('ungrounded case → diagnostic, never a script');
  ok(res.scripts.length === 2 && res.diagnostics.some((d) => d.kind === 'UNRESOLVED_SELECTOR' && d.target === 'GhostControl'), 'ungrounded target reported, not emitted');

  console.log('risk ordering surfaced');
  ok(res.coverage.length === 3 && typeof res.coverage[0].score === 'number', 'coverage carries risk scores');

  console.log('flag default off (legacy path preserved)');
  eq(aiqaCompilerEnabled(), false, 'AIQA_COMPILER unset → compiler disabled by default');

  _clearObjectRepository();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
