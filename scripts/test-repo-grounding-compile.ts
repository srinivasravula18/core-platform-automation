import { playwrightCompiler } from '../server/features/agent/compiler/playwrightCompiler';
import { discoverRepoGrounding } from '../server/features/agent/workflow/nodes/repoGrounding';
import { indexEvidenceGraph, type EvidenceGraph } from '../server/features/agent/graph/evidenceGraph';
import type { MissionContext } from '../server/features/agent/mission/missionContext';
import type { TestPlan } from '../server/features/agent/compiler/testPlan';

let pass = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
}
function ok(cond: boolean, label: string) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  cond ? pass++ : fail++;
}

const repoPath = process.argv[2] || 'D:/core-platform';
const nodes = discoverRepoGrounding(repoPath);
ok(nodes.length > 0, `repo grounding found nodes in ${repoPath}`);

const selectAppNode = nodes.find((n) => n.pageObjectRef?.method === 'selectApp');
ok(!!selectAppNode, 'found LauncherPage.selectApp as a repo-grounded node');

const evidenceGraph: EvidenceGraph = indexEvidenceGraph({ nodes, edges: [], selectorRegistryRef: 'selector_registry' });

const mission: MissionContext = {
  platform: 'ADMIN', platformType: 'ADMIN', runtimeSurface: null,
  application: { id: 'crm', name: 'CRM' }, module: null, tab: null,
  targetUrl: 'https://example.test/', executionScope: 'ADMIN/crm',
} as any;

const plan: TestPlan = {
  title: 'repo-grounding smoke test',
  module: 'crm', mission: 'ADMIN/crm',
  steps: [{ id: 'step:0', action: 'CLICK', target: selectAppNode!.semanticName, value: null }],
} as any;

const result = playwrightCompiler.compile({ mission, plan, evidenceGraph, run: {} });
ok(result.ok, 'compile succeeds with zero blocking diagnostics');
ok(result.code.includes(`import { LauncherPage } from`), 'emits a LauncherPage import');
ok(result.code.includes('new LauncherPage(page)'), 'instantiates LauncherPage');
ok(result.code.includes('.selectApp('), 'calls .selectApp(...)');
ok(result.code.includes('"CRM"'), 'passes the mission application name as the selectApp argument');
ok(!result.code.includes('runner.click('), 'does NOT fall back to a raw runner.click for a page-object target');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
