/**
 * Scoped internal MCP bridge.
 *
 * Codex calls application tools natively instead of the model being asked to describe a tool
 * call in prose. The tools keep running IN THIS PROCESS, so their existing in-memory state,
 * PostgreSQL access, and scope enforcement are unchanged — the bridge only exposes them.
 *
 * Security model, in layers:
 *   - the listener binds 127.0.0.1 on an ephemeral port, so it is unreachable off-box;
 *   - every request must carry the process bridge token, which only OUR Codex process is given
 *     (the CLI accepts a token solely from an environment variable, so it is minted once per
 *     backend process and passed at spawn — a per-session token would force a mid-flight restart);
 *   - per-turn secrecy is the session's unguessable URL path, revoked the moment it closes;
 *   - a session pins user/project/app/conversation plus an explicit tool allowlist, so a turn can
 *     never reach another tenant's data or a tool it was not granted.
 */

import http from 'http';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTool, ToolContext } from '../tools/types';
import type { CodexMcpServer } from './runtime';
import { BRIDGE_TOKEN_ENV, TRUSTED_MCP_SERVER, bridgeToken } from './appServerClient';

/** MCP server name Codex sees; tool calls are reported as `testflow/<tool>`. */
export const BRIDGE_SERVER_NAME = TRUSTED_MCP_SERVER;
export { BRIDGE_TOKEN_ENV };

const SESSION_TTL_MS = Math.max(60_000, Number(process.env.CODEX_MCP_SESSION_TTL_MS) || 30 * 60_000);
/** Tool results are bounded before they enter model context — the artifact store holds the full value. */
const MAX_RESULT_CHARS = Math.max(4_000, Number(process.env.CODEX_MCP_MAX_RESULT_CHARS) || 24_000);

export interface BridgeInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
  ms: number;
}

export type BridgeInvocationStart = Pick<BridgeInvocation, 'id' | 'name' | 'arguments'>;

export interface BridgeSession {
  /** Unguessable path segment — this is the per-session secret. */
  id: string;
  tools: Map<string, AgentTool>;
  ctx: ToolContext;
  expiresAt: number;
  /** Every call made this session, in order — the console renders these as tool steps. */
  invocations: BridgeInvocation[];
  /** Runaway backstop: calls past this many are refused instead of executed. */
  maxToolCalls: number;
  /** Fired as each call settles, so the caller can trace/persist without polling. */
  onInvocation?: (invocation: BridgeInvocation) => void;
  /** Fired immediately before a granted tool begins executing. */
  onInvocationStart?: (invocation: BridgeInvocationStart) => void;
}

const sessions = new Map<string, BridgeSession>();
let listener: http.Server | null = null;
let baseUrl = '';
let starting: Promise<string> | null = null;

function safeJson(value: unknown): string {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return (s ?? '').slice(0, MAX_RESULT_CHARS);
  } catch {
    return String(value).slice(0, MAX_RESULT_CHARS);
  }
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reapExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
}

/** A fresh MCP server bound to one session's tool allowlist and scope. */
function buildMcpServer(session: BridgeSession): Server {
  const server = new Server(
    { name: 'testflow-ai', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...session.tools.values()].map((tool) => ({
      name: tool.spec.name,
      description: tool.spec.description,
      inputSchema: tool.spec.parameters as any,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    const invocationId = randomUUID();
    const started = Date.now();
    const settle = (invocation: BridgeInvocation) => {
      session.invocations.push(invocation);
      try { session.onInvocation?.(invocation); } catch { /* observers never break a tool call */ }
    };
    // Budget exhaustion is reported to the model so it wraps up with what it has, rather than
    // the run being killed mid-thought with no answer.
    if (session.invocations.length >= session.maxToolCalls) {
      const error = `Tool-call budget of ${session.maxToolCalls} is exhausted. Answer now using what you have already gathered.`;
      settle({ id: randomUUID(), name, arguments: args, error, ms: 0 });
      return { content: [{ type: 'text' as const, text: `ERROR: ${error}` }], isError: true };
    }
    const tool = session.tools.get(name);
    // Denied names are reported as a tool ERROR, not a transport failure: the model can see
    // the refusal and choose a granted tool instead.
    if (!tool) {
      const error = `Tool "${name}" is not granted to this session.`;
      settle({ id: randomUUID(), name, arguments: args, error, ms: 0 });
      return { content: [{ type: 'text' as const, text: `ERROR: ${error}` }], isError: true };
    }
    try {
      try { session.onInvocationStart?.({ id: invocationId, name, arguments: args }); } catch { /* observers never break a tool call */ }
      const result = await tool.execute(args, session.ctx);
      settle({ id: invocationId, name, arguments: args, result, ms: Date.now() - started });
      return { content: [{ type: 'text' as const, text: safeJson(result) }] };
    } catch (err: any) {
      const error = err?.message || String(err);
      settle({ id: invocationId, name, arguments: args, error, ms: Date.now() - started });
      // Tool errors stay VISIBLE to Codex so it can self-correct rather than silently stalling.
      return { content: [{ type: 'text' as const, text: `ERROR: ${error}` }], isError: true };
    }
  });

  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const sessionId = url.pathname.split('/').filter(Boolean)[1] || '';
  reapExpired();
  const session = sessions.get(sessionId);
  const auth = String(req.headers.authorization || '');
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!session || !presented || !tokensMatch(presented, bridgeToken())) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const body = await new Promise<unknown>((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : undefined); } catch { resolve(undefined); } });
  });

  // A transport per request: stateless mode, so concurrent turns never share a session id.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildMcpServer(session);
  res.on('close', () => { transport.close().catch(() => undefined); server.close().catch(() => undefined); });
  await server.connect(transport);
  await transport.handleRequest(req as any, res, body);
}

/** Start (once) the loopback-only listener and return its base URL. */
async function ensureListener(): Promise<string> {
  if (baseUrl) return baseUrl;
  if (starting) return starting;
  starting = new Promise<string>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (res.headersSent) return;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'bridge failure' }));
      });
    });
    srv.on('error', reject);
    // 127.0.0.1 only — the bridge must never be reachable off-box, whatever the app binds to.
    srv.listen(Number(process.env.CODEX_MCP_PORT) || 0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      listener = srv;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve(baseUrl);
    });
    srv.unref();
  }).finally(() => { starting = null; });
  return starting;
}

export interface OpenSessionOptions {
  tools: AgentTool[];
  ctx: ToolContext;
  /** Restrict to these tool names; omitted means every tool passed in `tools`. */
  allowedTools?: string[];
  ttlMs?: number;
  /** Tool-call ceiling for the session. Default 12. */
  maxToolCalls?: number;
  /** Fired as each call settles — used for tracing and artifact memory. */
  onInvocation?: (invocation: BridgeInvocation) => void;
  /** Fired immediately before a granted tool begins executing. */
  onInvocationStart?: (invocation: BridgeInvocationStart) => void;
}

export interface OpenSessionResult {
  session: BridgeSession;
  /** Pass to CodexRuntime.run/stream as `mcpServers`. */
  mcpServers: Record<string, CodexMcpServer>;
  /** Merge into the Codex process env so the CLI can read the bearer token. */
  env: Record<string, string>;
  close: () => void;
}

/** Grant one turn scoped access to a subset of the application's tools. */
export async function openBridgeSession(opts: OpenSessionOptions): Promise<OpenSessionResult> {
  const url = await ensureListener();
  const allowed = opts.allowedTools?.length ? new Set(opts.allowedTools) : null;
  const tools = new Map<string, AgentTool>();
  for (const tool of opts.tools) {
    if (allowed && !allowed.has(tool.spec.name)) continue;
    tools.set(tool.spec.name, tool);
  }
  const session: BridgeSession = {
    id: randomBytes(32).toString('hex'),
    tools,
    ctx: opts.ctx,
    expiresAt: Date.now() + (opts.ttlMs ?? SESSION_TTL_MS),
    invocations: [],
    maxToolCalls: opts.maxToolCalls ?? 12,
    onInvocation: opts.onInvocation,
    onInvocationStart: opts.onInvocationStart,
  };
  sessions.set(session.id, session);
  return {
    session,
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {
        url: `${url}/mcp/${session.id}`,
        bearerTokenEnvVar: BRIDGE_TOKEN_ENV,
        allowedTools: [...tools.keys()],
      },
    },
    env: { [BRIDGE_TOKEN_ENV]: bridgeToken() },
    close: () => { sessions.delete(session.id); },
  };
}

/** Test/shutdown helper — closes the listener and drops every session. */
export function stopBridge() {
  sessions.clear();
  listener?.close();
  listener = null;
  baseUrl = '';
}

/** Exposed for diagnostics: how many sessions are currently live. */
export function activeBridgeSessions(): number {
  reapExpired();
  return sessions.size;
}
