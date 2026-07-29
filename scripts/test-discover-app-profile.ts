/**
 * Unit tests for discoverAppProfile (control-inversion agent).
 * Proves: the agent's exploration → typed AppProfile is published to the blackboard AND remembered per
 * connected app; a second run RECALLS it instead of re-exploring; profile values come from the agent,
 * never hardcoded. Injected explore/synthesize seams — no LLM/SUT.
 *   npx tsx scripts/test-discover-app-profile.ts
 */
import { discoverAppProfile } from '../server/agent-core/router/discoverAppProfile';
import { InMemoryBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMemoryStore } from '../server/agent-core/memory/store';
import { ToolRegistry } from '../server/agent-core/registry/tools';
import { defineAppProfile } from '../server/agent-core/appProfile';
import type { AgentRunResult } from '../server/ai/tools/types';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const stubRun = (text: string): AgentRunResult => ({
  finalText: text, steps: [], accepted: true, stoppedReason: 'accepted',
  toolResults: [{ name: 'explore_page', arguments: {}, result: {} }],
  totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
});

async function main() {
  const connectedApp = { projectId: 'P1', appId: 'acme', ownerId: 'U1', repoPath: 'C:/x/acme', appUrl: 'http://acme.test/' };

  console.log('Discovery — agent explores → typed profile → blackboard + memory');
  {
    const blackboard = new InMemoryBlackboard();
    const memory = new InMemoryMemoryStore();
    const tools = new ToolRegistry(); // empty is fine — explore is injected
    let exploreCalls = 0;
    // The AGENT decides the profile (routing 'hash', a surface named 'console') — nothing hardcoded here.
    const agentDecided = defineAppProfile({
      id: 'acme', label: 'Acme', routingModel: 'hash',
      surfaces: [{ name: 'console', baseUrl: 'http://acme.test/', kind: 'ops' }],
    });

    const profile = await discoverAppProfile({
      connectedApp, runId: 'run-1', tools, blackboard, memory,
      explore: async () => { exploreCalls++; return stubRun('acme uses hash routing; one console surface'); },
      synthesize: async () => agentDecided,
    });

    eq(exploreCalls, 1, 'the agent explored exactly once');
    eq(profile.routingModel, 'hash', 'routing model comes from the AGENT (discovered), not a hardcoded default');
    eq(profile.surfaces[0].kind, 'ops', 'surface kind is the app\'s own, discovered');

    const fact = await blackboard.latest<any>('run-1', 'app.profile');
    eq(fact?.value.id, 'acme', 'the decision is published to the blackboard (A2A) for downstream to read');
    ok(fact?.provenance.by !== undefined, 'the blackboard fact is provenance-stamped to the agent');

    const remembered = await memory.recall({ scope: { projectId: 'P1', appId: 'acme', ownerId: 'U1' }, kind: 'semantic', subject: 'app.profile' });
    eq(remembered.length, 1, 'the profile is remembered per connected app');
  }

  console.log('Memory-first — a learned app is RECALLED, not re-explored');
  {
    const blackboard = new InMemoryBlackboard();
    const memory = new InMemoryMemoryStore();
    const tools = new ToolRegistry();
    // Pre-seed memory as if a prior run already learned this app.
    await memory.write({ scope: { projectId: 'P1', appId: 'acme', ownerId: 'U1' }, kind: 'semantic', subject: 'app.profile',
      value: defineAppProfile({ id: 'acme', label: 'Acme', routingModel: 'query-param' }) });

    let exploreCalls = 0;
    const profile = await discoverAppProfile({
      connectedApp, runId: 'run-2', tools, blackboard, memory,
      explore: async () => { exploreCalls++; return stubRun('should not run'); },
      synthesize: async () => null,
    });

    eq(exploreCalls, 0, 'no exploration — the app was recalled from memory (self-built, per app)');
    eq(profile.routingModel, 'query-param', 'the recalled profile is returned');
    const fact = await blackboard.latest<any>('run-2', 'app.profile');
    eq(fact?.provenance.causationId, 'memory-recall', 'the recalled decision is still published to the blackboard');
  }

  console.log('Fail-safe — a null synthesis never fabricates; yields a minimal profile from connected identity');
  {
    const blackboard = new InMemoryBlackboard();
    const memory = new InMemoryMemoryStore();
    const profile = await discoverAppProfile({
      connectedApp: { appId: 'beta', appLabel: 'Beta' }, runId: 'run-3', tools: new ToolRegistry(), blackboard, memory,
      explore: async () => stubRun('inconclusive'),
      synthesize: async () => null,
    });
    eq(profile.id, 'beta', 'minimal profile uses the connected app id — never an invented one');
    eq(profile.surfaces, [], 'no surfaces invented when synthesis is inconclusive');
    const remembered = await memory.recall({ scope: { appId: 'beta' }, kind: 'semantic', subject: 'app.profile' });
    eq(remembered.length, 0, 'a thin profile is NOT remembered (confidence gate) — future runs re-discover');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
