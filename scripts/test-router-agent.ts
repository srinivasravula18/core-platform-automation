/**
 * Unit tests for the Phase 6 router agent (server/agent-core/router/routerAgent).
 * Proves routing is a registry-VALIDATED decision: unknown agents are dropped (never dispatched), aliases
 * resolve, and the plan is ordered — with a deterministic injected classifier (no LLM).
 *   npx tsx scripts/test-router-agent.ts
 * Pure — no network/DB/LLM.
 */
import { routeRequest, type RoutingClassifier } from '../server/agent-core/router/routerAgent';
import { AgentRegistry } from '../server/agent-core/registry/agents';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

function registryWith(): AgentRegistry {
  const r = new AgentRegistry();
  r.register({ name: 'testPlanner', description: 'plan', toolNames: [], tags: ['planning'] });
  r.register({ name: 'caseWriter', description: 'author cases', toolNames: [], tags: ['authoring'] });
  r.register({ name: 'playwrightCoder', description: 'author plans', toolNames: [], tags: ['authoring'] });
  return r;
}

async function main() {
  console.log('Router — validated ordered plan');
  {
    const classify: RoutingClassifier = async () => ({
      steps: [{ agent: 'testPlanner', task: 'plan it' }, { agent: 'caseWriter', task: 'write cases' }],
      rationale: 'plan then author',
    });
    const plan = await routeRequest({ goal: 'make cases for X' }, { classify, agents: registryWith() });
    eq(plan.steps.map((s) => s.agent), ['testPlanner', 'caseWriter'], 'plan preserves classifier order');
    eq(plan.steps.map((s) => s.task), ['plan it', 'write cases'], 'per-step tasks are carried');
    eq(plan.droppedAgents, [], 'no drops when all agents are registered');
  }

  console.log('Router — unknown agents are DROPPED, never dispatched (kills intent-table drift)');
  {
    const classify: RoutingClassifier = async () => ({
      steps: [
        { agent: 'discover_requirement', task: 'x' }, // the P8 orphan: declared but no handler
        { agent: 'caseWriter', task: 'write cases' },
      ],
    });
    const plan = await routeRequest({ goal: 'g' }, { classify, agents: registryWith() });
    eq(plan.steps.map((s) => s.agent), ['caseWriter'], 'only registered agents survive into the plan');
    eq(plan.droppedAgents, ['discover_requirement'], 'the unknown agent is surfaced as dropped, not executed');
  }

  console.log('Router — alias resolution + empty-plan fallback signal');
  {
    // caseReworker is an alias of caseWriter — the router resolves it to the canonical name.
    const aliasClassify: RoutingClassifier = async () => ({ steps: [{ agent: 'caseReworker', task: 't' }] });
    const plan = await routeRequest({ goal: 'g' }, { classify: aliasClassify, agents: registryWith() });
    eq(plan.steps.map((s) => s.agent), ['caseWriter'], 'an alias routes to its canonical registered agent');

    const emptyClassify: RoutingClassifier = async () => ({ steps: [] });
    const empty = await routeRequest({ goal: 'g' }, { classify: emptyClassify, agents: registryWith() });
    eq(empty.steps, [], 'an empty plan is returned as-is so the caller can fall back to the legacy path');
  }

  console.log('Router — the classifier sees the available registered agents');
  {
    let sawNames: string[] = [];
    const spy: RoutingClassifier = async (_input, available) => { sawNames = available.map((a) => a.name); return { steps: [] }; };
    await routeRequest({ goal: 'g' }, { classify: spy, agents: registryWith() });
    eq(sawNames.sort(), ['caseWriter', 'playwrightCoder', 'testPlanner'], 'the classifier is given the registry\'s agents to choose from');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
