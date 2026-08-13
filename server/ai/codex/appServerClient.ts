/**
 * Codex App Server — stdio JSON-RPC transport.
 *
 * This is the ONE transport for every Codex turn. `codex app-server` speaks newline-delimited
 * JSON over stdio: client requests carry {id, method, params}, replies carry {id, result|error},
 * the server pushes notifications as {method, params}, and — crucially — the server can send
 * REQUESTS back to us.
 *
 * That last part is why the app server is used rather than `codex exec`: a native tool call
 * raises an approval request, and only a client that answers it can let the call through.
 * `codex exec` has no one to ask, so it auto-cancels every MCP tool call. Approvals are also a
 * security boundary, so this client answers them narrowly — see `handleServerRequest`.
 *
 * The process is lazily spawned, shared across turns, and torn down when idle.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface } from 'readline';
import { randomBytes } from 'crypto';

export type CodexAuthMode = 'chatgpt' | 'apikey' | string;

export interface CodexAuthStatus {
  authMethod: CodexAuthMode | null;
  requiresOpenaiAuth: boolean | null;
}

export interface CodexModelInfo {
  id: string;
  displayName?: string;
  supportedReasoningEfforts?: string[];
}

/** MCP server name the bridge registers under; only its tool calls are auto-approved. */
export const TRUSTED_MCP_SERVER = 'testflow';
/** Env var carrying the bridge bearer token into the Codex process. */
export const BRIDGE_TOKEN_ENV = 'TESTFLOW_MCP_TOKEN';

// One token per backend process, minted once and passed at spawn. It proves a bridge request
// came from OUR Codex process; per-session secrecy is the unguessable session path, which is
// revoked on close. Keeping the token stable matters: the CLI reads it from the environment at
// startup, so a per-session token would force a restart and kill any turn already running.
let processBridgeToken = '';
export function bridgeToken(): string {
  if (!processBridgeToken) processBridgeToken = randomBytes(32).toString('hex');
  return processBridgeToken;
}

/** The CLI binary name; Windows resolves through the npm shim. */
export function codexCommand(): string {
  return process.env.CODEX_CLI_PATH || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
}

/** Parent-session Codex env leaks make a nested CLI pick the wrong auth/runtime path. */
export function cleanCodexEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(extra || {}), NO_COLOR: '1' };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SANDBOX_NETWORK_DISABLED;
  delete env.CODEX_MANAGED_BY_NPM;
  delete env.CODEX_MANAGED_PACKAGE_ROOT;
  return env;
}

const REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.CODEX_APP_SERVER_TIMEOUT_MS) || 30_000);
/** A turn can legitimately run for many minutes (high effort, several tool calls). */
const TURN_TIMEOUT_MS = Math.max(60_000, Number(process.env.CODEX_TURN_TIMEOUT_MS) || 900_000);
const IDLE_SHUTDOWN_MS = Math.max(10_000, Number(process.env.CODEX_APP_SERVER_IDLE_MS) || 300_000);

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Notifications for one live turn, delivered to the runtime as they arrive. */
export type NotificationHandler = (method: string, params: any) => void;

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** threadId → handler, so concurrent turns on one process stay separated. */
  private subscribers = new Map<string, NotificationHandler>();
  /** Handlers for notifications with no thread of their own (account/login/completed, warnings). */
  private globalListeners = new Set<NotificationHandler>();
  /** Non-request work that must keep the shared process alive (e.g. a pending device login). */
  private holds = new Set<string>();

  /** Ensure one running app server. It is shared by every turn and never restarted mid-flight. */
  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      // A .cmd shim needs a shell; passing the whole line (no args array) keeps Node from
      // warning about unescaped shell arguments.
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexCommand());
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(
          useShell ? `"${codexCommand()}" app-server` : codexCommand(),
          useShell ? [] : ['app-server'],
          { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: cleanCodexEnv({ [BRIDGE_TOKEN_ENV]: bridgeToken() }), shell: useShell },
        ) as ChildProcessWithoutNullStreams;
      } catch (err: any) {
        reject(new Error(`Could not start the Codex app server: ${err?.message || err}`));
        return;
      }
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', (err) => {
        this.teardown(new Error(`Codex app server failed to start: ${err.message}`));
        reject(err);
      });
      child.on('close', (code) => {
        this.teardown(new Error(`Codex app server exited (${code})${stderr ? `: ${stderr.split(/\r?\n/).filter(Boolean).pop() || ''}` : ''}`));
      });
      this.child = child;
      this.reader = createInterface({ input: child.stdout });
      this.reader.on('line', (line) => this.onLine(line));
      resolve();
    }).finally(() => { this.starting = null; });
    await this.starting;
    // `initialize` must be the first exchange; it also proves the binary is usable.
    await this.request('initialize', {
      clientInfo: { name: 'testflow-ai', title: 'Test Flow AI', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, REQUEST_TIMEOUT_MS);
    // Required JSON-RPC lifecycle notification: requests after initialize are invalid without it.
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
  }

  private onLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let msg: any;
    try { msg = JSON.parse(trimmed); } catch { return; }

    // Server → client REQUEST (has both a method and an id): answer it.
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this.handleServerRequest(msg);
      return;
    }
    // Server → client NOTIFICATION.
    if (msg.method) {
      const threadId = msg.params?.threadId;
      const handler = threadId ? this.subscribers.get(String(threadId)) : undefined;
      // A subscriber must never kill the reader — one bad listener would stall every turn.
      if (handler) { try { handler(msg.method, msg.params); } catch { /* ignored */ } }
      for (const listener of this.globalListeners) {
        try { listener(msg.method, msg.params); } catch { /* ignored */ }
      }
      return;
    }
    // Reply to one of our requests.
    if (msg.id === undefined || msg.id === null) return;
    const pending = this.pending.get(Number(msg.id));
    if (!pending) return;
    this.pending.delete(Number(msg.id));
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error?.message || 'Codex app server error'));
    else pending.resolve(msg.result);
  }

  /**
   * Answer a server-initiated request. This is a SECURITY decision, not a formality:
   *   - tool calls from our own scoped bridge are accepted (the bridge already enforces the
   *     per-session allowlist and tenant scope),
   *   - tool calls from any other MCP server are declined,
   *   - sandbox escapes, shell-command escalations, and file writes are always denied — agents
   *     run read-only, and nothing about a test-authoring turn justifies escaping that.
   */
  private handleServerRequest(msg: any) {
    const reply = (result: unknown) => this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
    switch (msg.method) {
      case 'mcpServer/elicitation/request': {
        const trusted = msg.params?.serverName === TRUSTED_MCP_SERVER;
        reply({ action: trusted ? 'accept' : 'decline', content: {} });
        return;
      }
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval':
        reply({ decision: 'denied' });
        return;
      default:
        reply({});
    }
  }

  private teardown(error: Error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.subscribers.clear();
    this.globalListeners.clear();
    this.holds.clear();
    this.reader?.close();
    this.reader = null;
    this.child = null;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.pending.size && !this.subscribers.size && !this.holds.size) this.stop();
    }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  private request<T = any>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Codex app server is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app server request "${method}" timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      this.touchIdle();
    });
  }

  /** Call a method, starting the server on demand. */
  async call<T = any>(method: string, params: unknown = null, opts?: { timeoutMs?: number }): Promise<T> {
    await this.ensureStarted();
    return this.request<T>(method, params, opts?.timeoutMs);
  }

  /** Receive this thread's notifications until the returned function is called. */
  subscribe(threadId: string, handler: NotificationHandler): () => void {
    this.subscribers.set(threadId, handler);
    return () => { this.subscribers.delete(threadId); this.touchIdle(); };
  }

  /** Receive every notification, including those with no thread (login, warnings). */
  subscribeAll(handler: NotificationHandler): () => void {
    this.globalListeners.add(handler);
    return () => { this.globalListeners.delete(handler); this.touchIdle(); };
  }

  /** Keep the shared process alive while `key` is held — a device login outlives the idle timer. */
  hold(key: string): () => void {
    this.holds.add(key);
    return () => { this.holds.delete(key); this.touchIdle(); };
  }

  /** Longer-running call for turn execution. */
  async callTurn<T = any>(method: string, params: unknown): Promise<T> {
    return this.request<T>(method, params, TURN_TIMEOUT_MS);
  }

  async authStatus(): Promise<CodexAuthStatus> {
    const res = await this.call<any>('account/read', { refreshToken: false });
    return { authMethod: res?.account?.type ?? null, requiresOpenaiAuth: res?.requiresOpenaiAuth ?? null };
  }

  /** Models the local Codex runtime offers. Empty when the runtime declines to enumerate. */
  async listModels(): Promise<CodexModelInfo[]> {
    const res = await this.call<any>('model/list', {});
    const raw: any[] = Array.isArray(res) ? res : (res?.data || res?.models || res?.items || []);
    return raw
      .map((m) => ({
        id: String(m?.id ?? m?.model ?? m?.slug ?? ''),
        displayName: m?.displayName ?? undefined,
        supportedReasoningEfforts: (m?.supportedReasoningEfforts || []).map((e: any) => e?.reasoningEffort ?? e).filter(Boolean),
      }))
      .filter((m) => !!m.id);
  }

  stop() {
    const child = this.child;
    this.teardown(new Error('Codex app server stopped'));
    try { child?.kill(); } catch { /* already gone */ }
  }
}

let shared: CodexAppServerClient | null = null;

export function getAppServerClient(): CodexAppServerClient {
  if (!shared) shared = new CodexAppServerClient();
  return shared;
}
