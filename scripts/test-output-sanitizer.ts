/**
 * Regression tests — the Agent Console output boundary (server/ai/supervisor.ts).
 *
 * Agent answers must NEVER show file paths, filenames, line numbers, or repo directories: source
 * locations stay internal to the pipeline. `stripCodebaseLocationsForAgentConsole` is the LIVE
 * enforcement point — every answer path in supervisor.ts and features/agent/routes.ts runs through
 * it — so these fixtures test the function that actually ships, not a copy of it.
 *
 * Convention: standalone tsx script, no jest/vitest. Run with:
 *   npx tsx scripts/test-output-sanitizer.ts   (or: npm run test:output-sanitizer)
 * Exits 0 if all pass, 1 on failure.
 */
import '../server/shared/env';
import { stripCodebaseLocationsForAgentConsole } from '../server/ai/supervisor';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  \u2713 ${n}`); } else { failed++; console.error(`  \u2717 ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

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
    const out = stripCodebaseLocationsForAgentConsole(f.input);
    for (const g of f.gone) ok(!out.includes(g), `[${f.name}] "${g}" is stripped`);
    for (const k of f.kept) ok(out.includes(k), `[${f.name}] "${k}" survives`);
    eq(stripCodebaseLocationsForAgentConsole(out), out, `[${f.name}] idempotent (sanitize twice = once)`);
  }

  const clean = 'Sorting toggles ascending and descending on header click.';
  eq(stripCodebaseLocationsForAgentConsole(clean), clean, 'path-free prose passes through unchanged');
  eq(stripCodebaseLocationsForAgentConsole(''), '', 'empty input yields empty output');
}

testSanitizer();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
