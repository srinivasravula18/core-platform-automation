/**
 * End-to-end check — Codex calls application tools natively through the scoped MCP bridge.
 *
 * This is the Phase 2 integration proof: a REAL Codex turn, a REAL loopback MCP session, and a
 * real application-shaped tool. It verifies the chain the Agent Console depends on — the runtime
 * discovers the granted tools, calls them with the arguments it chose, receives the result, and
 * answers from it; the invocation is observable (so the console can render steps); and the
 * session's scope, not the model, decides which tenant's data the tool sees.
 *
 * Needs a local `codex` login; skips loudly with exit 0 when the runtime is unauthenticated.
 *
 * Convention: standalone tsx script, no jest/vitest. Run with:
 *   npx tsx scripts/test-codex-tool-loop.ts   (or: npm run test:codex-tool-loop)
 */
import { CodexRuntime } from '../server/ai/codex/runtime';
import { openBridgeSession, stopBridge, type BridgeInvocation } from '../server/ai/codex/mcpBridge';
import type { AgentTool, ToolContext } from '../server/ai/tools/types';
import { getAppServerClient } from '../server/ai/codex/appServerClient';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

/** Stands in for a real app tool: server-supplied scope, model-supplied argument. */
const listTestCases: AgentTool = {
  spec: {
    name: 'list_test_cases',
    description: 'List the test cases in the current project. Returns their ids and titles.',
    parameters: { type: 'object', properties: { status: { type: 'string', description: 'Optional status filter.' } } },
  },
  async execute(_args, ctx) {
    return {
      project: ctx.projectId,
      cases: [
        { id: 'TC-101', title: 'Login with valid credentials' },
        { id: 'TC-102', title: 'Login rejects a wrong password' },
        { id: 'TC-103', title: 'Session expires after inactivity' },
      ],
    };
  },
};

async function main() {
  const runtime = new CodexRuntime();
  const health = process.env.CODEX_SKIP_LIVE_TOOL_LOOP === '1' ? await runtime.health() : { ok: true, error: undefined };
  if (!health.ok && process.env.CODEX_SKIP_LIVE_TOOL_LOOP === '1') {
    console.log(`\n  Codex runtime unavailable: ${health.error}`);
    console.log('  This check needs a local Codex login — run "codex login" and re-run.\n');
    stopBridge();
    process.exit(0);
  }

  const observed: BridgeInvocation[] = [];
  const ctx: ToolContext = { userId: 'user-1', projectId: 'proj-42', appId: 'app-1' };
  const bridge = await openBridgeSession({
    tools: [listTestCases],
    ctx,
    maxToolCalls: 4,
    onInvocation: (invocation) => observed.push(invocation),
  });

  console.log('Section 1 — Codex discovers and calls the granted tool');
  try {
    const turn = await runtime.run({
      system: 'You answer using the tools available to you. Never guess data you can look up.',
      prompt: 'Call testflow/list_test_cases now. Do not answer before that tool returns. Then report the case count and the id of the wrong-password case.',
      effort: 'low',
      model: process.env.CODEX_TOOL_LOOP_MODEL || 'gpt-5.6-luna',
      mcpServers: bridge.mcpServers,
      env: bridge.env,
    });

    ok(observed.length > 0, 'Codex actually called a tool over the bridge');
    ok(observed.some((i) => i.name === 'list_test_cases'), 'it called the granted tool by name');
    ok(observed.every((i) => !i.error), 'no invocation errored');
    ok(turn.toolCalls.some((c) => c.tool === 'list_test_cases'), 'the turn reports the MCP tool call for tracing');

    console.log('Section 2 — the answer is grounded in the tool result');
    ok(/\b3\b|three/i.test(turn.text), 'the answer states the real case count from the tool');
    ok(/TC-102/.test(turn.text), 'the answer quotes the id that only the tool could supply');

    console.log('Section 3 — scope came from the session, not the model');
    const result: any = observed.find((i) => i.name === 'list_test_cases')?.result;
    ok(result?.project === 'proj-42', 'execute() ran with the session ToolContext');
    ok(!JSON.stringify(observed[0]?.arguments || {}).includes('proj-42'), 'the model never supplied (or saw) the project scope as an argument');
  } finally {
    bridge.close();
    stopBridge();
    getAppServerClient().stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  if (/not (?:logged in|authenticated)|unauthorized|401/i.test(String(err?.message || err))) {
    console.log('\n  Codex runtime is not authenticated; live tool loop skipped.\n');
    stopBridge();
    process.exit(0);
  }
  console.error('\nFATAL:', err?.message || err);
  stopBridge();
  process.exit(1);
});
