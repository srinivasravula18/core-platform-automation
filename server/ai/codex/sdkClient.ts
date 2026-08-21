import { createRequire } from 'module';
import { dirname, join } from 'path';
import type { Input, ThreadEvent } from '@openai/codex-sdk';
import { cleanCodexEnv } from './appServerClient';
import type { CodexEffort, CodexMcpServer, CodexRunOptions, CodexRuntimeConfig } from './runtime';

const require = createRequire(join(process.cwd(), 'package.json'));
const targets: Record<string, [string, string]> = {
  'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
  'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
  'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
};

/** Bypass the SDK's PATH rewrite; it breaks account auth in nested Codex hosts on Windows. */
function bundledCodexPath(): string | undefined {
  if (process.env.CODEX_SDK_CLI_PATH) return process.env.CODEX_SDK_CLI_PATH;
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) return undefined;
  try {
    return join(dirname(require.resolve(`${target[0]}/package.json`)), 'vendor', target[1], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  } catch {
    return undefined;
  }
}

function env(extra?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cleanCodexEnv(extra)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function prompt(opts: CodexRunOptions): Input {
  const text = opts.system ? `<developer_instructions>\n${opts.system}\n</developer_instructions>\n\n${opts.prompt}` : opts.prompt;
  if (!opts.imagePaths?.length) return text;
  return [{ type: 'text', text }, ...opts.imagePaths.map((path) => ({ type: 'local_image' as const, path }))];
}

/** The SDK does not export its config type; mirror the value shape it flattens into `--config`. */
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | { [k: string]: CodexConfigValue };

/**
 * MCP servers reach the SDK through CodexOptions.config — the CLI's `mcp_servers.<name>` shape.
 *
 * Always returns a table, even when empty: the CLI merges the user's own ~/.codex/config.toml, so a
 * developer's global servers (a Playwright one opens a REAL Chrome window) would otherwise be inherited
 * by every agent turn this app runs. Sending the table explicitly makes our scoped set the only one.
 */
function mcpConfig(servers?: Record<string, CodexMcpServer>): Record<string, CodexConfigValue> {
  const out: Record<string, CodexConfigValue> = {};
  if (!servers) return { mcp_servers: out };
  for (const [name, server] of Object.entries(servers)) {
    out[name] = {
      url: server.url,
      ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}),
      ...(server.allowedTools?.length ? { enabled_tools: server.allowedTools } : {}),
      startup_timeout_sec: 30,
      tool_timeout_sec: 300,
    };
  }
  return { mcp_servers: out };
}

export async function* streamSdkTurn(
  opts: CodexRunOptions,
  config: CodexRuntimeConfig,
  model: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<ThreadEvent> {
  // The production server is CommonJS, while the official SDK is ESM-only.
  const { Codex } = await import('@openai/codex-sdk');
  // One client per turn: `config` is a constructor option, so a shared client cannot carry a per-agent
  // tool allowlist. That isolation is the point — one specialist can never reach another's tools.
  const codex = new Codex({
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(bundledCodexPath() ? { codexPathOverride: bundledCodexPath() } : {}),
    env: env(opts.env),
    config: mcpConfig(opts.mcpServers),
  });
  const threadOptions = {
    ...(model ? { model } : {}),
    workingDirectory: config.workingDirectory || process.cwd(),
    sandboxMode: opts.sandboxMode ?? ('read-only' as const),
    approvalPolicy: opts.approvalPolicy ?? ('never' as const),
    // Hosted search is an explicit Codex capability, independent of shell network access.
    webSearchMode: opts.webSearchMode ?? ('disabled' as const),
    ...(opts.networkAccessEnabled !== undefined ? { networkAccessEnabled: opts.networkAccessEnabled } : {}),
    ...(opts.effort ? { modelReasoningEffort: opts.effort as any } : {}),
  };
  const thread = opts.threadId ? codex.resumeThread(opts.threadId, threadOptions) : codex.startThread(threadOptions);
  const streamed = await thread.runStreamed(prompt(opts), {
    signal,
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
  });
  yield* streamed.events;
}
