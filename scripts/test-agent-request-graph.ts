/**
 * Phase 6 exit-gate tests — output sanitizer (server/ai/outputSanitizer.ts), request router
 * (workflow/requestGraph.ts), and the bounded read-only source-research graph
 * (workflow/sourceResearchGraph.ts). Fully offline: every LLM seam is stubbed; the only real-tool
 * section (4) exercises the git-backed read-only tools against THIS repo + a temp-dir fixture.
 *
 * Convention: standalone tsx script, no jest/vitest (see test-agent-workflow-state.ts). Run with:
 *   npx tsx scripts/test-agent-request-graph.ts   (or: npm run test:agent-request-graph)
 * Exits 0 if all pass, 1 on first failure.
 */
import '../server/shared/env';
import path from 'path';
import os from 'os';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { sanitizeAgentOutput, stripCodebaseLocationsForAgentConsole } from '../server/ai/outputSanitizer';
import { routeRequest } from '../server/features/agent/workflow/requestGraph';
import {
  buildSourceResearchGraph, defaultSearchTools, routeAfterSearch,
  MAX_RESEARCH_ITERATIONS, ENOUGH_FINDINGS, READ_LINE_CAP, MAX_SEARCH_MATCHES,
  type PlanQueriesFn, type SynthesizeFn, type SourceSearchTools, type SearchMatch, type ResearchFinding,
} from '../server/features/agent/workflow/sourceResearchGraph';
import { readRepoFile } from '../server/features/git-agent/gitAgentService';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

// ---------------------------------------------------------------------------
function testSanitizer() {
  console.log('1. Output sanitizer — no file paths / repo locations in agent answers');

  const fixtures: Array<{ name: string; input: string; gone: string[]; kept: string[] }> = [
    {
      name: 'Windows absolute path with line number',
      input: 'The logic lives in D:\\core-platform\\apps\\admin\\src\\ListView.tsx:42 and handles sorting.',
      gone: ['ListView', 'D:\\', 'core-platform'],
      kept: ['handles sorting'],
    },
    {
      name: 'POSIX repo-rooted paths incl. a :10-20 range and a ./ relative path',
      input: 'Validation lives in server/features/agent/routes.ts and src/pages/AgentConsole.tsx:10-20; see also ./src/components/Grid.vue.',
      gone: ['routes.ts', 'AgentConsole', 'Grid.vue', 'server/features'],
      kept: ['Validation'],
    },
    {
      name: 'bare filenames (plain + .spec.ts)',
      input: 'See executionService.ts:120 and helpers.spec.ts for details.',
      gone: ['executionService', 'helpers.spec'],
      kept: ['details'],
    },
    {
      name: '"referenced by" clause',
      input: 'The 200-row cap is enforced referenced by the grid loader.',
      gone: ['referenced by', 'grid loader'],
      kept: ['200-row cap'],
    },
    {
      name: 'multi-line with a db path and excess blank lines',
      input: 'Line A uses db/schema.sql:5 for defaults.\n\n\n\nLine B stays.',
      gone: ['schema.sql', '\n\n\n'],
      kept: ['Line A', 'Line B stays'],
    },
  ];

  for (const f of fixtures) {
    const out = sanitizeAgentOutput(f.input);
    for (const g of f.gone) ok(!out.includes(g), `[${f.name}] "${g}" is stripped`);
    for (const k of f.kept) ok(out.includes(k), `[${f.name}] "${k}" survives`);
    eq(sanitizeAgentOutput(out), out, `[${f.name}] idempotent (sanitize twice = once)`);
  }

  const clean = 'Sorting toggles ascending and descending on header click.';
  eq(sanitizeAgentOutput(clean), clean, 'path-free prose passes through unchanged');
  eq(sanitizeAgentOutput(''), '', 'empty input yields empty output');
  const w = fixtures[0].input;
  eq(stripCodebaseLocationsForAgentConsole(w), sanitizeAgentOutput(w), 'named export matches sanitizeAgentOutput (drop-in for consumer migration)');
}

// ---------------------------------------------------------------------------
async function testRequestRouting() {
  console.log('2. Request router — deterministic kind → engine dispatch (AGENT_GRAPH_V2 gate)');

  const saved = process.env.AGENT_GRAPH_V2;
  try {
    process.env.AGENT_GRAPH_V2 = '1';
    let r = await routeRequest({ kind: 'test_run', payload: { goal: 'generate cases' } });
    eq(r.route, 'test_run_graph', 'flag on: test_run → test_run_graph');
    ok(r.reason.length > 0, 'route decision carries a reason');
    r = await routeRequest({ kind: 'source_research', payload: { question: 'q' } });
    eq(r.route, 'source_research_graph', 'flag on: source_research → source_research_graph');
    r = await routeRequest({ kind: 'chat', payload: {} });
    eq(r.route, 'legacy_chat', 'flag on: chat stays on legacy_chat');

    // Hardcoded-on default: unset flag now routes to the graph engine; only the '0'/'false' kill switch disables.
    delete process.env.AGENT_GRAPH_V2;
    r = await routeRequest({ kind: 'test_run', payload: {} });
    eq(r.route, 'test_run_graph', 'flag unset: test_run routes to the graph engine (hardcoded on)');
    process.env.AGENT_GRAPH_V2 = '0';
    r = await routeRequest({ kind: 'test_run', payload: {} });
    eq(r.route, 'legacy_chat', 'kill switch AGENT_GRAPH_V2=0: test_run falls back to legacy_chat');
    ok(/disabled/i.test(r.reason), 'kill-switch reason says the flag is disabled');
    r = await routeRequest({ kind: 'source_research', payload: {} });
    eq(r.route, 'source_research_graph', 'kill switch: source_research still routes to the research graph');

    process.env.AGENT_GRAPH_V2 = 'false';
    r = await routeRequest({ kind: 'test_run', payload: {} });
    eq(r.route, 'legacy_chat', 'AGENT_GRAPH_V2=false also reads as disabled');

    r = await routeRequest({ kind: 'bogus' as never, payload: {} });
    eq(r.route, 'legacy_chat', 'unknown kind fails safe to legacy_chat');
  } finally {
    if (saved === undefined) delete process.env.AGENT_GRAPH_V2; else process.env.AGENT_GRAPH_V2 = saved;
  }
}

// ---------------------------------------------------------------------------
async function testResearchGraphStubbed() {
  console.log('3. Source-research graph — stubbed LLM seams over an in-memory fixture repo');

  const mk = (n: number): ResearchFinding[] => Array.from({ length: n }, (_, i) => ({ file: `f${i}.x`, excerpt: 'e' }));
  eq(routeAfterSearch({ findings: [], iterations: 1 }), 'plan_queries', 'router: no findings + iteration 1 → another planning round');
  eq(routeAfterSearch({ findings: [], iterations: MAX_RESEARCH_ITERATIONS }), 'synthesize', `router: iteration bound (${MAX_RESEARCH_ITERATIONS}) forces synthesize`);
  eq(routeAfterSearch({ findings: mk(ENOUGH_FINDINGS), iterations: 1 }), 'synthesize', `router: ${ENOUGH_FINDINGS} findings are enough`);
  eq(routeAfterSearch({ findings: mk(ENOUGH_FINDINGS - 1), iterations: 1 }), 'plan_queries', 'router: one short of enough keeps researching');

  const fixtureRepo = new Map<string, string>([
    ['app/listView.ts', 'export function sortRows(rows) {\n  // toggles ascending/descending on header click\n  return rows;\n}\nexport const PAGE_SIZE = 25;'],
    ['app/validation.ts', 'export function validateName(name) {\n  if (!name) throw new Error("Name is required");\n  return true;\n}'],
    ['app/gridToolbar.ts', 'export const toolbarActions = ["export", "bulk-delete", "import"];'],
  ]);
  const toolCalls: Array<{ op: string; arg: string }> = [];
  const stubTools: SourceSearchTools = {
    async search(query: string): Promise<SearchMatch[]> {
      toolCalls.push({ op: 'search', arg: query });
      const q = query.toLowerCase();
      const out: SearchMatch[] = [];
      for (const [file, content] of fixtureRepo) {
        if (file.toLowerCase().includes(q) || content.toLowerCase().includes(q)) {
          out.push({ file, snippet: content.split('\n').slice(0, 2).join('\n'), line: 1 });
        }
      }
      return out;
    },
    async read(file: string): Promise<string> {
      toolCalls.push({ op: 'read', arg: file });
      return fixtureRepo.get(file) ?? '';
    },
  };

  // Happy path — findings found in one round, answer synthesized, planted paths sanitized away.
  const plannedIterations: number[] = [];
  const stubPlan: PlanQueriesFn = async ({ iteration }) => {
    plannedIterations.push(iteration);
    return { queries: ['sortRows', 'validateName', 'toolbar'], errors: [] };
  };
  const stubSynth: SynthesizeFn = async ({ findings }) => ({
    answer: `Grounded in D:\\fake\\repo\\secret\\answerFile.ts:7 plus src/grid-helpers/render.ts and bare planted.spec.ts — sorting toggles ascending and descending on header click; empty names are rejected. (findings: ${findings.length})`,
    errors: [],
  });
  const happyGraph = buildSourceResearchGraph({ planQueries: stubPlan, synthesize: stubSynth, searchTools: stubTools });
  const happy = await happyGraph.invoke({ question: 'How does list view sorting work?', scopedRoots: ['D:/fixture-root'] });

  ok((happy.findings?.length ?? 0) >= ENOUGH_FINDINGS, `happy path gathered >= ${ENOUGH_FINDINGS} findings (got ${happy.findings.length})`);
  eq(happy.iterations, 1, 'enough findings after one iteration short-circuits to synthesize');
  ok(happy.answer.length > 0, 'a final answer was synthesized');
  ok(!happy.answer.includes('answerFile') && !happy.answer.includes('D:\\fake'), 'planted Windows path is gone from the final answer');
  ok(!happy.answer.includes('render.ts') && !happy.answer.includes('grid-helpers'), 'planted POSIX repo path is gone');
  ok(!happy.answer.includes('planted.spec.ts'), 'planted bare spec filename is gone');
  ok(happy.answer.includes('ascending and descending'), 'the substantive answer text survives sanitization');
  ok(happy.findings.every((f) => typeof f.file === 'string' && f.file.length > 0), 'findings keep raw file paths internally (never surfaced)');
  ok(toolCalls.length > 0 && toolCalls.every((c) => c.op === 'search' || c.op === 'read'), 'graph invoked ONLY the read-only search/read tool operations');
  ok(toolCalls.some((c) => c.op === 'search') && toolCalls.some((c) => c.op === 'read'), 'both search and read were exercised');
  eq(plannedIterations, [1], 'planner ran exactly once on the happy path');

  // Bounded iterations — a planner that never yields useful queries terminates at the bound.
  const boundedPlanned: number[] = [];
  const synthFindingCounts: number[] = [];
  const uselessPlan: PlanQueriesFn = async ({ iteration }) => {
    boundedPlanned.push(iteration);
    return { queries: ['zzz-not-present-anywhere-qq'], errors: [] };
  };
  const boundedSynth: SynthesizeFn = async ({ findings }) => {
    synthFindingCounts.push(findings.length);
    return { answer: findings.length ? 'found something' : 'No grounded findings were located for this question.', errors: [] };
  };
  const boundedGraph = buildSourceResearchGraph({ planQueries: uselessPlan, synthesize: boundedSynth, searchTools: stubTools });
  let boundedThrew = false;
  let bounded: typeof happy | null = null;
  try { bounded = await boundedGraph.invoke({ question: 'something unanswerable', scopedRoots: [] }); } catch { boundedThrew = true; }
  ok(!boundedThrew, 'never-useful planner does NOT loop forever (no recursion-limit blowup)');
  eq(bounded?.iterations, MAX_RESEARCH_ITERATIONS, `graph terminated at the ${MAX_RESEARCH_ITERATIONS}-iteration bound`);
  eq(bounded?.findings.length, 0, 'no findings were fabricated');
  eq(boundedPlanned, [1, 2], 'planner ran exactly twice (bounded)');
  eq(synthFindingCounts, [0], 'synthesize ran exactly once, after the bound, with zero findings');
  ok(Boolean(bounded?.answer && bounded.answer.includes('No grounded findings')), 'empty-findings answer is surfaced (sanitized)');

  // Error containment — a THROWING planner is captured into state.errors and the bound still holds.
  const containedSynth: SynthesizeFn = async () => ({ answer: 'done', errors: [] });
  const throwingPlan: PlanQueriesFn = async () => { throw new Error('planner exploded'); };
  const contained = await buildSourceResearchGraph({ planQueries: throwingPlan, synthesize: containedSynth, searchTools: stubTools })
    .invoke({ question: 'q', scopedRoots: [] });
  eq(contained.iterations, MAX_RESEARCH_ITERATIONS, 'throwing planner still terminates at the bound');
  ok(contained.errors.some((e: string) => e.includes('planner exploded')), 'planner error was captured into state.errors, not thrown');
  eq(contained.answer, 'done', 'synthesis still produced the final answer');
}

// ---------------------------------------------------------------------------
async function testScopeGuardRealTools() {
  console.log('4. Scope guard — REAL git-backed tools (this repo + a non-repo temp dir fixture)');

  const repoRoot = process.cwd();
  ok(existsSync(path.join(repoRoot, '.git')), `test precondition: cwd is a git repo root (${repoRoot})`);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'srg-scope-'));
  writeFileSync(path.join(tmpDir, 'secret.txt'), 'top secret outside-scope content', 'utf8');
  try {
    eq(await defaultSearchTools.read('secret.txt', [tmpDir]), '', 'read against a non-repo root is rejected (empty), never served');
    eq(await defaultSearchTools.search('secret', [tmpDir]), [], 'search against a non-repo root returns no matches');
    eq(await defaultSearchTools.read('../../../etc/passwd', [repoRoot]), '', 'traversal path is rejected deterministically');
    eq(await defaultSearchTools.read('..\\outside.txt', [repoRoot]), '', 'backslash traversal is rejected too');
    eq(await defaultSearchTools.read('D:/outside/evil.ts', [repoRoot]), '', 'absolute drive-letter path is rejected');
    eq(await defaultSearchTools.read('scripts/test-agent-workflow-state.ts', [repoRoot]), '', 'test/script paths read as empty (isTestPath scoping preserved)');

    // The underlying gitAgentService scoping the default tools inherit:
    let nonRepoThrew = false;
    try { readRepoFile('secret.txt', 6000, tmpDir); } catch { nonRepoThrew = true; }
    ok(nonRepoThrew, 'gitAgentService.readRepoFile refuses a root without .git (throws "not found")');
    eq(readRepoFile('../scope-guard-outside.txt', 6000, repoRoot), '', 'gitAgentService read outside the repo returns empty (git show cannot escape HEAD)');

    // Positive controls + result caps:
    const pkg = await defaultSearchTools.read('package.json', [repoRoot]);
    ok(pkg.includes('"scripts"'), 'in-scope tracked file reads real content');
    const big = await defaultSearchTools.read('server/shared/storage.ts', [repoRoot]);
    const bigLines = big.split(/\r?\n/).length;
    eq(bigLines, READ_LINE_CAP, `a >${READ_LINE_CAP}-line file is truncated to exactly the ${READ_LINE_CAP}-line cap`);
    const hits = await defaultSearchTools.search('isWorkflowGraphEnabled', [repoRoot]);
    ok(hits.length >= 1 && hits.length <= MAX_SEARCH_MATCHES, `in-scope search returns 1..${MAX_SEARCH_MATCHES} matches (got ${hits.length})`);
    ok(hits.every((h) => !/^[A-Za-z]:/.test(h.file)), 'search results are repo-relative (no absolute paths)');
    ok(hits.every((h) => typeof h.snippet === 'string' && h.snippet.length > 0), 'search results carry bounded snippets');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
async function main() {
  testSanitizer();
  await testRequestRouting();
  await testResearchGraphStubbed();
  await testScopeGuardRealTools();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
