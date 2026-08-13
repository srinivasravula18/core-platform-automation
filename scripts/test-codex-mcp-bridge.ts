/**
 * Regression tests — the scoped internal MCP bridge (server/ai/codex/mcpBridge.ts).
 *
 * The bridge is what lets Codex call application tools natively, so its guarantees are
 * security guarantees. These prove them against the real HTTP listener and a real MCP client:
 *   - the listener binds loopback only,
 *   - a wrong/absent bearer token is rejected,
 *   - only allowlisted tools are listed and callable,
 *   - the session's ToolContext (user/project/app scope) reaches execute(), not the model's args,
 *   - tool errors stay VISIBLE to the caller instead of killing the transport,
 *   - the tool-call budget refuses further calls rather than looping forever,
 *   - closing a session revokes access immediately.
 *
 * Convention: standalone tsx script, no jest/vitest. Run with:
 *   npx tsx scripts/test-codex-mcp-bridge.ts   (or: npm run test:codex-mcp-bridge)
 * Exits 0 if all pass, 1 on failure.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openBridgeSession, stopBridge, activeBridgeSessions, BRIDGE_SERVER_NAME } from '../server/ai/codex/mcpBridge';
import type { AgentTool, ToolContext } from '../server/ai/tools/types';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

/** Records the ctx it was handed, so we can prove scope is server-supplied, not model-supplied. */
let seenCtx: ToolContext | null = null;

const echoTool: AgentTool = {
  spec: { name: 'echo', description: 'Echo a value back.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
  async execute(args, ctx) { seenCtx = ctx; return { echoed: args.value, project: ctx.projectId }; },
};
const explodeTool: AgentTool = {
  spec: { name: 'explode', description: 'Always fails.', parameters: { type: 'object', properties: {} } },
  async execute() { throw new Error('tool blew up'); },
};
const secretTool: AgentTool = {
  spec: { name: 'secret', description: 'Never granted in these tests.', parameters: { type: 'object', properties: {} } },
  async execute() { return 'leaked'; },
};

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

function textOf(result: any): string {
  return (result?.content || []).map((c: any) => c?.text || '').join('');
}

async function main() {
  const ctx: ToolContext = { userId: 'user-1', projectId: 'proj-1', appId: 'app-1', conversationId: 'conv-1' };
  const bridge = await openBridgeSession({
    tools: [echoTool, explodeTool, secretTool],
    ctx,
    allowedTools: ['echo', 'explode'],
    maxToolCalls: 3,
  });
  const url = bridge.mcpServers[BRIDGE_SERVER_NAME].url;
  const token = bridge.env.TESTFLOW_MCP_TOKEN;

  console.log('Section 1 — exposure and transport shape');
  {
    ok(url.startsWith('http://127.0.0.1:'), 'the listener is bound to loopback only');
    ok(bridge.mcpServers[BRIDGE_SERVER_NAME].bearerTokenEnvVar === 'TESTFLOW_MCP_TOKEN', 'the token is passed by env var, as the CLI requires');
    ok(!!token && token.length >= 32, 'the session token is long and random');
    ok(!url.includes(token), 'the token is not embedded in the URL');
  }

  console.log('Section 2 — authentication');
  {
    const unauth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    ok(unauth.status === 401, 'a request with no bearer token is rejected');
    const wrong = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer nope' }, body: '{}' });
    ok(wrong.status === 401, 'a request with the wrong bearer token is rejected');
    const otherSession = url.replace(/\/mcp\/.*$/, '/mcp/00000000-0000-0000-0000-000000000000');
    const cross = await fetch(otherSession, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
    ok(cross.status === 401, 'a valid token for a DIFFERENT session id is rejected');
  }

  console.log('Section 3 — tool allowlist and scoped execution');
  {
    const client = await connect(url, token);
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    ok(JSON.stringify(listed) === JSON.stringify(['echo', 'explode']), 'only allowlisted tools are advertised');
    ok(!listed.includes('secret'), 'a non-granted tool is invisible');

    const res: any = await client.callTool({ name: 'echo', arguments: { value: 'hello' } });
    ok(/hello/.test(textOf(res)), 'a granted tool executes and returns its result');
    ok(seenCtx?.projectId === 'proj-1' && seenCtx?.userId === 'user-1', 'the SESSION scope reaches execute(), not anything the model supplied');
    ok(/proj-1/.test(textOf(res)), 'the scoped value appears in the tool result');

    const denied: any = await client.callTool({ name: 'secret', arguments: {} });
    ok(denied.isError === true && /not granted/i.test(textOf(denied)), 'calling a non-granted tool is refused as a visible tool error');

    const failed_: any = await client.callTool({ name: 'explode', arguments: {} });
    ok(failed_.isError === true && /blew up/.test(textOf(failed_)), 'a throwing tool surfaces its message so the agent can self-correct');
    await client.close();
  }

  console.log('Section 4 — runaway backstop');
  {
    const client = await connect(url, token);
    // 3 calls already spent above (echo, secret-denial, explode) — the next must be refused.
    const over: any = await client.callTool({ name: 'echo', arguments: { value: 'again' } });
    ok(over.isError === true && /budget/i.test(textOf(over)), 'calls past the budget are refused with an instruction to answer');
    ok(bridge.session.invocations.length === 4, 'every attempt — allowed, denied, failed, over-budget — is recorded');
    await client.close();
  }

  console.log('Section 5 — session revocation');
  {
    ok(activeBridgeSessions() === 1, 'the session is live before close');
    bridge.close();
    ok(activeBridgeSessions() === 0, 'closing drops the session');
    const after = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
    ok(after.status === 401, 'the token stops working the moment the session closes');
  }

  stopBridge();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFATAL:', err?.message || err);
  stopBridge();
  process.exit(1);
});
