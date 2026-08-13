/** Live compatibility gate for @openai/codex-sdk. Production routing is tested elsewhere. */
import { Codex, type ThreadEvent } from '@openai/codex-sdk';
import { openBridgeSession, stopBridge, BRIDGE_SERVER_NAME } from '../server/ai/codex/mcpBridge';
import { CodexRuntime } from '../server/ai/codex/runtime';
import { cleanCodexEnv, getAppServerClient } from '../server/ai/codex/appServerClient';
import type { AgentTool, ToolContext } from '../server/ai/tools/types';

let passed = 0;
let failed = 0;
const ok = (condition: boolean, name: string) => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
};

const cleanEnv = (): Record<string, string> => Object.fromEntries(
  Object.entries(cleanCodexEnv()).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);

async function main() {
  if (process.env.CODEX_SDK_CLI_PATH) process.env.CODEX_CLI_PATH = process.env.CODEX_SDK_CLI_PATH;
  const sdkOptions = { env: cleanEnv(), ...(process.env.CODEX_SDK_CLI_PATH ? { codexPathOverride: process.env.CODEX_SDK_CLI_PATH } : {}) };
  const codex = new Codex(sdkOptions);
  const model = process.env.CODEX_SDK_TEST_MODEL || 'gpt-5.6-terra';
  const threadOptions = { model, workingDirectory: process.cwd(), sandboxMode: 'read-only' as const, approvalPolicy: 'never' as const };

  console.log('Section 1 — text, schema, streaming, abort, and SDK resume');
  const thread = codex.startThread(threadOptions);
  const text = await thread.run('Reply with exactly: PONG');
  ok(/PONG/i.test(text.finalResponse), 'plain text turn');
  ok(!!thread.id, 'SDK returns a persistent thread id');
  ok((text.usage?.input_tokens || 0) > 0, 'SDK reports token usage');

  const structured = await thread.run('Return Tokyo and Japan using the required schema.', {
    outputSchema: {
      type: 'object',
      properties: { city: { type: 'string' }, country: { type: 'string' } },
      required: ['city', 'country'],
      additionalProperties: false,
    },
  });
  const object = JSON.parse(structured.finalResponse);
  ok(/tokyo/i.test(object.city) && /japan/i.test(object.country), 'native structured output');

  const streamed = await thread.runStreamed('Count from 1 to 3, one number per line.');
  const events: ThreadEvent[] = [];
  for await (const event of streamed.events) events.push(event);
  ok(events.some((event) => event.type === 'item.completed' && event.item.type === 'agent_message'), 'streamed item events');
  ok(events.some((event) => event.type === 'turn.completed'), 'streamed completion and usage');

  const resumed = codex.resumeThread(thread.id!, threadOptions);
  const memory = await resumed.run('What city did you just return? Reply with the city only.');
  ok(/tokyo/i.test(memory.finalResponse), 'SDK thread resume preserves context');

  const controller = new AbortController();
  const aborting = codex.startThread(threadOptions)
    .run('Write a detailed 3000-word essay about software testing.', { signal: controller.signal });
  setTimeout(() => controller.abort(), 500);
  let aborted = false;
  try { await aborting; } catch (error: any) { aborted = /abort/i.test(String(error?.message || error)); }
  ok(aborted, 'AbortSignal cancels an active SDK turn');

  console.log('Section 2 — resume a thread created through App Server');
  const appRuntime = new CodexRuntime();
  const appTurn = await appRuntime.run({ prompt: 'Remember the code word MANGO. Reply OK only.', effort: 'low' });
  getAppServerClient().stop();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const crossResume = codex.resumeThread(appTurn.threadId!, threadOptions);
  const crossMemory = await crossResume.run('What code word did I ask you to remember? Reply with it only.');
  ok(/MANGO/i.test(crossMemory.finalResponse), 'SDK resumes an App Server-created thread');

  console.log('Section 3 — production CodexRuntime SDK route');
  const previousTransport = process.env.CODEX_TRANSPORT;
  const previousSdkPath = process.env.CODEX_SDK_CLI_PATH;
  process.env.CODEX_TRANSPORT = 'sdk';
  delete process.env.CODEX_SDK_CLI_PATH;
  const runtimeSdk = await new CodexRuntime().run({ prompt: 'Reply with exactly: RUNTIME_SDK_OK', effort: 'low' });
  ok(/RUNTIME_SDK_OK/.test(runtimeSdk.text) && !!runtimeSdk.threadId, 'CodexRuntime executes through strict SDK mode');
  if (previousSdkPath !== undefined) process.env.CODEX_SDK_CLI_PATH = previousSdkPath;
  if (previousTransport === undefined) delete process.env.CODEX_TRANSPORT;
  else process.env.CODEX_TRANSPORT = previousTransport;

  console.log('Section 4 — real scoped MCP bridge and approval behavior');
  const echoTool: AgentTool = {
    spec: {
      name: 'sdk_echo',
      description: 'Return the supplied value. Use this tool whenever explicitly asked.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    },
    async execute(args) { return { echoed: args.value }; },
  };
  const ctx: ToolContext = { userId: 'sdk-user', projectId: 'sdk-project', appId: 'sdk-app', conversationId: 'sdk-conversation' };
  const bridge = await openBridgeSession({ tools: [echoTool], ctx, maxToolCalls: 1 });
  const mcp = bridge.mcpServers[BRIDGE_SERVER_NAME];
  const sdkWithMcp = new Codex({
    ...sdkOptions,
    env: { ...cleanEnv(), ...bridge.env },
    config: {
      mcp_servers: {
        [BRIDGE_SERVER_NAME]: {
          url: mcp.url,
          bearer_token_env_var: mcp.bearerTokenEnvVar!,
          enabled_tools: mcp.allowedTools!,
        },
      },
    },
  });
  let mcpApproved = false;
  try {
    const mcpTurn = await sdkWithMcp
      .startThread({ ...threadOptions, approvalPolicy: 'on-request' })
      .run('You must call sdk_echo exactly once with value SDK_APPROVAL_OK, then reply with its echoed value.');
    mcpApproved = bridge.session.invocations.length === 1 && /SDK_APPROVAL_OK/.test(mcpTurn.finalResponse);
  } catch (error: any) {
    console.log(`  ~ SDK MCP approval unavailable: ${String(error?.message || error).split(/\r?\n/)[0]}`);
  } finally {
    bridge.close();
    stopBridge();
  }
  console.log(`  ${mcpApproved ? '✓' : '~'} SDK MCP approval capability: ${mcpApproved ? 'available' : 'requires App Server fallback'}`);

  getAppServerClient().stop();
  console.log(`\n${passed} passed, ${failed} failed; sdkMcpApproval=${mcpApproved}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('\nFATAL:', error instanceof Error ? error.message : error);
  stopBridge();
  getAppServerClient().stop();
  process.exit(1);
});
