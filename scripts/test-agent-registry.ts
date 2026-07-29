/**
 * Unit tests for the Phase 2 capability registry (server/agent-core/registry).
 * Covers: tool registry lookup/tags/session-scoped skipping, defineTool validation, the RC-3
 * list_api_endpoints orphan tool over a sample OpenAPI spec, agent registry (alias resolution +
 * toolset + prompt), and the shadow-bus execution seam with an injected executor + in-memory bus.
 *   npx tsx scripts/test-agent-registry.ts
 * Pure — no browser/network/DB (in-memory stores + injected executor).
 */
import { ToolRegistry, defineTool, setToolRegistry, getToolRegistry } from '../server/agent-core/registry/tools';
import { apiEndpointsTool } from '../server/agent-core/registry/apiEndpointsTool';
import { AgentRegistry } from '../server/agent-core/registry/agents';
import { runRegisteredAgent } from '../server/agent-core/registry/runViaBus';
import { InMemoryMessageBus } from '../server/agent-core/bus/messageBus';
import { InMemoryBlackboard } from '../server/agent-core/bus/blackboard';
import type { AgentRunResult } from '../server/ai/tools/types';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const SAMPLE_SPEC = {
  openapi: '3.0.0',
  servers: [{ url: 'https://api.example.test' }],
  paths: {
    '/users': {
      get: { summary: 'List users', parameters: [{ name: 'page', in: 'query', required: false, schema: { type: 'integer' } }] },
      post: { summary: 'Create user', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, security: [{ bearer: [] }] },
    },
    '/users/{id}': {
      get: { summary: 'Get user', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
    },
  },
};

async function main() {
  // -------------------------------------------------------------------------------------------
  console.log('Tool registry — register/lookup/tags/session-scoped');
  {
    const reg = new ToolRegistry();
    reg.registerAgentTool(apiEndpointsTool, { tags: ['api'] });
    reg.register({ name: 'browser_click', description: 'mcp', sessionScoped: true, tags: ['mcp'] });

    ok(reg.has('list_api_endpoints'), 'registered tool is found by name');
    eq(reg.get('list_api_endpoints')?.tags, ['api'], 'tags are stored');
    eq(reg.byTag('mcp').map((d) => d.name), ['browser_click'], 'byTag filters');
    eq(reg.toolsFor(['list_api_endpoints', 'browser_click', 'nope']).map((t) => t.spec.name), ['list_api_endpoints'],
      'toolsFor resolves executables and SKIPS session-scoped + unknown names');
    eq(reg.specs(['list_api_endpoints']).length, 1, 'specs() returns model-facing specs');
  }

  console.log('defineTool — validation');
  {
    ok(!!defineTool({ name: 'x', description: 'd', sessionScoped: true }), 'session-scoped tool needs no executable');
    let threw = false;
    try { defineTool({ name: 'y', description: 'd' }); } catch { threw = true; }
    ok(threw, 'a non-session-scoped tool without an executable throws');
  }

  console.log('Process tool registry — seeds the RC-3 orphan + MCP discoverability');
  {
    setToolRegistry(null); // force a fresh real seed
    const reg = getToolRegistry();
    ok(reg.has('list_api_endpoints'), 'RC-3 api-endpoints tool is wired into the process registry');
    ok(reg.get('browser_navigate')?.sessionScoped === true, 'RC-4 MCP tools are registered as discoverable (session-scoped)');
    setToolRegistry(null);
  }

  // -------------------------------------------------------------------------------------------
  console.log('RC-3 list_api_endpoints — parses a real spec, no guessing');
  {
    const out: any = await apiEndpointsTool.execute({ spec: SAMPLE_SPEC }, {});
    eq(out.total, 3, 'all three operations discovered');
    const post = out.endpoints.find((e: any) => e.method === 'POST');
    eq(post.path, '/users', 'POST /users found');
    eq(post.auth, true, 'security requirement surfaced as auth=true');
    eq(post.hasBody, true, 'request body detected');
    const byId = out.endpoints.find((e: any) => e.path === '/users/{id}');
    eq(byId.requiredParams, ['id(path)'], 'required path param surfaced');

    const filtered: any = await apiEndpointsTool.execute({ spec: SAMPLE_SPEC, filter: 'create' }, {});
    eq(filtered.endpoints.map((e: any) => e.method), ['POST'], 'filter narrows to matching endpoints');

    const bad: any = await apiEndpointsTool.execute({ spec: 'not json' }, {});
    ok(!!bad.error && bad.endpoints.length === 0, 'an invalid spec returns a typed error, never a guessed endpoint');
  }

  // -------------------------------------------------------------------------------------------
  console.log('Agent registry — alias resolution + toolset + prompt');
  {
    const reg = new AgentRegistry();
    reg.register({ name: 'caseWriter', description: 'author', toolNames: ['list_api_endpoints'], tags: ['authoring'] });
    ok(reg.has('caseWriter'), 'registered agent found');
    // caseReworker is an alias of caseWriter — the registry resolves it.
    ok(reg.has('caseReworker'), 'alias resolves to the canonical agent');
    eq(reg.get('caseReworker')?.name, 'caseWriter', 'alias lookup returns the canonical definition');
    const sys = reg.get('caseWriter')?.resolveSystem?.();
    ok(typeof sys === 'string' && sys.length > 0, 'resolveSystem returns the real (non-empty) system prompt');
  }

  // -------------------------------------------------------------------------------------------
  console.log('Shadow-bus execution — HANDOFF → run → blackboard fact → RESULT');
  {
    const agents = new AgentRegistry();
    agents.register({ name: 'playwrightCoder', description: 'author', toolNames: ['list_api_endpoints'], tags: ['authoring'] });
    const tools = new ToolRegistry();
    tools.registerAgentTool(apiEndpointsTool);
    const bus = new InMemoryMessageBus();
    const blackboard = new InMemoryBlackboard();

    let executorSawTools = -1;
    let executorSawSystem = false;
    const stubResult: AgentRunResult = {
      finalText: 'authored plan OK',
      steps: [],
      accepted: true,
      stoppedReason: 'accepted',
      toolResults: [{ name: 'list_api_endpoints', arguments: {}, result: {} }],
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
    };
    const out = await runRegisteredAgent({
      agent: 'playwrightCoder', task: 'author cases for the users API', runId: 'run-42',
      agents, tools, bus, blackboard,
      executor: async (_agent, opts) => { executorSawTools = opts.tools.length; executorSawSystem = Boolean(opts.system); return stubResult; },
    });

    eq(executorSawTools, 1, 'the executor received the agent\'s resolved registered tools');
    ok(executorSawSystem, 'the executor received the agent\'s system prompt');
    ok(out.result.accepted, 'the run result is returned to the caller');

    const history = await bus.history('run-42');
    eq(history.map((m) => m.type), ['HANDOFF', 'RESULT'], 'a HANDOFF and a linked RESULT were published');
    eq(history[1].causationId, out.handoffId, 'the RESULT is causally linked to the HANDOFF');
    eq(history[0].to, 'playwrightCoder', 'the HANDOFF is addressed to the agent');

    const fact = await blackboard.latest<any>('run-42', 'agent.result.playwrightCoder');
    eq(fact?.value.accepted, true, 'the outcome is written to the blackboard (shared, not re-derived)');
    eq(fact?.provenance.by, 'playwrightCoder', 'the blackboard fact is provenance-stamped to the agent');

    let threw = false;
    try { await runRegisteredAgent({ agent: 'ghost', task: 't', runId: 'r', agents, tools, bus, blackboard, executor: async () => stubResult }); }
    catch { threw = true; }
    ok(threw, 'an unknown agent fails loud (never silently no-ops)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
