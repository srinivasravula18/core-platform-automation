/**
 * Playwright MCP bridge — runs the REAL @playwright/mcp server as a child process and
 * exposes its browser tools (browser_navigate, browser_snapshot, browser_click, …) to the
 * agent tool-loop as ordinary AgentTools. This lets the inspector drive a live browser
 * through the same Model-Context-Protocol surface that Claude/Cursor use, instead of our
 * in-process page tools.
 *
 * Server-safe by construction (works on headless Linux exactly like the rest of the
 * pipeline): the child is launched with --headless --no-sandbox and, when the deployment
 * pins a system Chromium via PLAYWRIGHT_CHROMIUM_PATH, --executable-path is forwarded so it
 * uses the SAME browser binary `npm run playwright:install` provisioned. Each session gets an
 * --isolated in-memory profile so concurrent runs never collide.
 *
 * Everything here is best-effort and disposable: startMcpSession() throws on any failure so
 * the caller can fall back to the classic/in-process inspector, and closeMcpSession() always
 * tears the child down.
 */

import { type ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import type { AgentTool } from './types';
import type { ToolSpec } from '../providers/types';
import { chromiumExecutablePath, CHROMIUM_LAUNCH_ARGS } from '../../shared/browser';

type McpToolDescriptor = {
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpListToolsResult = {
  tools?: McpToolDescriptor[];
};

type McpCallToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

type McpClientLike = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<McpListToolsResult>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<McpCallToolResult>;
  close(): Promise<void>;
};

export interface McpSession {
  client: McpClientLike;
  child: ChildProcess;
  tools: AgentTool[];
}

type McpSdkModule = {
  Client: new (...args: any[]) => McpClientLike;
};

type McpStdioModule = {
  StdioClientTransport: new (...args: any[]) => { _process?: ChildProcess };
};

async function importOptionalModule<T>(specifier: string): Promise<T | null> {
  try {
    return await new Function('s', 'return import(s)')(specifier) as Promise<T>;
  } catch {
    return null;
  }
}

async function loadMcpSdk(): Promise<{ ClientCtor: McpSdkModule['Client']; TransportCtor: McpStdioModule['StdioClientTransport'] }> {
  const clientModule = await importOptionalModule<McpSdkModule>('@modelcontextprotocol/sdk/client/index.js')
    || await importOptionalModule<McpSdkModule>('@modelcontextprotocol/sdk/client/index')
    || await importOptionalModule<McpSdkModule>('@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const stdioModule = await importOptionalModule<McpStdioModule>('@modelcontextprotocol/sdk/client/stdio.js')
    || await importOptionalModule<McpStdioModule>('@modelcontextprotocol/sdk/client/stdio')
    || await importOptionalModule<McpStdioModule>('@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

  if (!clientModule?.Client || !stdioModule?.StdioClientTransport) {
    throw new Error('@modelcontextprotocol/sdk client runtime is unavailable. Run npm install to restore the MCP SDK.');
  }
  return {
    ClientCtor: clientModule.Client,
    TransportCtor: stdioModule.StdioClientTransport,
  };
}

/** Resolve the @playwright/mcp CLI entry (cli.js) from node_modules, cross-platform.
 *  Uses the ambient CommonJS require (the backend is bundled to CJS by esbuild), so this
 *  works both under tsx (dev) and in the production dist/server.cjs bundle. */
function resolveMcpCli(): string {
  // Resolve WITHOUT require/import.meta so it works identically under tsx (ESM dev) and the
  // esbuild CJS prod bundle — both run from the repo root, so node_modules is under cwd.
  const candidates = [
    join(process.cwd(), 'node_modules', '@playwright', 'mcp', 'cli.js'),
    join(__dirname, '..', '..', '..', 'node_modules', '@playwright', 'mcp', 'cli.js'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('@playwright/mcp CLI not found — run npm install. Looked in: ' + candidates.join(', '));
}

/**
 * Launch the Playwright MCP server and return a connected client plus its tools wrapped as
 * AgentTools. `allowExecute` filters which MCP tools the loop may call (the inspector only
 * needs read/navigate/interact, never file writes).
 */
export async function startMcpSession(opts: {
  /** Only expose MCP tools whose name passes this test (default: allow all). */
  toolFilter?: (name: string) => boolean;
  /** Extra CLI args (e.g. --storage-state <path> to start already logged in). */
  extraArgs?: string[];
  timeoutMs?: number;
} = {}): Promise<McpSession> {
  const { ClientCtor, TransportCtor } = await loadMcpSdk();
  const cli = resolveMcpCli();
  const execPath = chromiumExecutablePath();
  const args = [
    cli,
    '--headless',
    '--isolated',
    '--no-sandbox',
    // Reuse one browser context across the session's tabs (the inspector drives one flow).
    '--shared-browser-context',
    ...(execPath ? ['--executable-path', execPath] : []),
    ...(opts.extraArgs || []),
  ];

  // stdio transport: the SDK spawns and owns the child process lifecycle.
  const transport = new TransportCtor({
    command: process.execPath, // the current node binary — portable across OSes
    args,
    // Forward the server-safe Chromium launch flags so the MCP-launched browser matches ours.
    env: {
      ...process.env,
      PLAYWRIGHT_LAUNCH_OPTIONS_ARGS: CHROMIUM_LAUNCH_ARGS.join(' '),
      NO_COLOR: '1',
    } as Record<string, string>,
  });

  const client = new ClientCtor({ name: 'core-platform-inspector', version: '1.0.0' }, { capabilities: {} });

  const timeoutMs = opts.timeoutMs ?? 30_000;
  await withTimeout(client.connect(transport), timeoutMs, 'MCP connect timed out');

  const listed = await withTimeout(client.listTools(), timeoutMs, 'MCP listTools timed out');
  const filter = opts.toolFilter || (() => true);
  const tools: AgentTool[] = (listed.tools || [])
    .filter((t) => filter(String(t.name)))
    .map((t): AgentTool => {
      const spec: ToolSpec = {
        name: String(t.name),
        description: String(t.description || `Playwright MCP tool ${t.name}`),
        parameters: (t.inputSchema && typeof t.inputSchema === 'object')
          ? t.inputSchema
          : { type: 'object', properties: {} },
      };
      return {
        spec,
        async execute(argsIn: Record<string, unknown>) {
          const res = await client.callTool({ name: spec.name, arguments: argsIn || {} });
          // MCP returns { content: [{type:'text', text}|{type:'image',...}], isError? }.
          // Collapse to a compact string the model can read; keep it bounded.
          const parts = Array.isArray(res?.content) ? res.content : [];
          const text = parts
            .map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image omitted]' : ''))
            .filter(Boolean)
            .join('\n')
            .slice(0, 12_000);
          if (res?.isError) return { error: text || 'MCP tool reported an error.' };
          return text || { ok: true };
        },
      };
    });

  const child = transport._process as ChildProcess;
  return { client, child, tools };
}

export async function closeMcpSession(session: McpSession | null | undefined): Promise<void> {
  if (!session) return;
  try { await session.client.close(); } catch { /* already gone */ }
  try {
    const c = session.child;
    if (c && !c.killed) {
      c.kill();
      // Hard-kill after a grace period so a wedged MCP child never leaks on the server.
      setTimeout(() => { try { if (!c.killed) c.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref?.();
    }
  } catch { /* best effort */ }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
