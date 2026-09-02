/**
 * CodexRuntime — the single model-execution seam.
 *
 * Plain and structured turns use the authenticated Codex SDK. Scoped MCP turns use App Server;
 * both transports expose the same normalized streaming, thread, and cancellation contract here.
 * App Server remains the approval-capable transport for scoped application tools.
 *
 * Everything above this file (guardrails, prompt assembly, evidence gates, usage, tracing) stays
 * application-owned. The runtime only executes turns.
 */

import { getAppServerClient, type CodexAccountInfo, type CodexModelInfo } from './appServerClient';
import { streamSdkTurn } from './sdkClient';
import { estimateCost, type ProviderUsage } from '../providers/types';
import { codexMcpServers } from './mcpConfig';

/** Runtime-reported value (for example low/medium/high/xhigh); kept open for future models. */
export type CodexEffort = string;
/** Hosted Codex web search only; it does not grant shell or package-network access. */
export type CodexWebSearchMode = 'disabled' | 'cached' | 'live';
export interface CodexWebSearchActivity {
  query: string;
  status: 'started' | 'completed';
}

/** Sentinel meaning "let the local Codex config choose" — never sent as a model id. */
export const CODEX_LOCAL_DEFAULT_MODEL = 'codex-default';

export interface CodexMcpServer {
  /** Streamable-HTTP endpoint of an MCP server Codex should load for this turn. */
  url: string;
  /** Env var the CLI reads the session bearer token from — it accepts no literal token. */
  bearerTokenEnvVar?: string;
  /** Tool names Codex may call; omitted means "all tools the server exposes". */
  allowedTools?: string[];
}

export interface CodexRunOptions {
  system?: string;
  prompt: string;
  model?: string;
  effort?: CodexEffort;
  signal?: AbortSignal;
  /** Optional observer used by higher-level streams while run() still collects the final result. */
  onTextDelta?: (delta: string) => void;
  /** JSON Schema for a strict structured answer. */
  outputSchema?: unknown;
  /** Resume this Codex thread instead of starting a new one. */
  threadId?: string;
  /** Local image paths sent alongside the prompt. */
  imagePaths?: string[];
  /** Scoped MCP servers exposed to this turn, keyed by server name. */
  mcpServers?: Record<string, CodexMcpServer>;
  /** Extra env for the runtime process — how the MCP session's bearer token is delivered. */
  env?: Record<string, string>;
  /** Per-agent execution policy. Reasoning specialists stay read-only; only capabilities get write scope. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  networkAccessEnabled?: boolean;
  /** Disabled unless a caller deliberately requests hosted Codex web search. */
  webSearchMode?: CodexWebSearchMode;
  /** Observes hosted-search activity while run() collects the final answer. */
  onWebSearch?: (activity: CodexWebSearchActivity) => void;
}

/** A tool call Codex made this turn, for tracing and console steps. */
export interface CodexToolCall {
  server: string;
  tool: string;
  arguments: unknown;
  error?: string;
}

export interface CodexRunResult {
  text: string;
  threadId: string | null;
  usage: ProviderUsage;
  model: string;
  toolCalls: CodexToolCall[];
}

/** Normalized turn events — the console renders these and the provider streams from them. */
export type CodexEvent =
  | { type: 'thread.started'; threadId: string }
  | { type: 'text.delta'; delta: string }
  | { type: 'reasoning'; text: string }
  | { type: 'web.search' } & CodexWebSearchActivity
  | { type: 'tool.started'; call: CodexToolCall }
  | { type: 'tool.completed'; call: CodexToolCall }
  | { type: 'message'; text: string }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'completed'; text: string }
  | { type: 'failed'; message: string };

export interface CodexHealth {
  ok: boolean;
  model?: string;
  authMethod?: string | null;
  error?: string;
  checkedAt: string;
}

/** API-key mode when a key is configured; otherwise the local ChatGPT/Codex login. */
export interface CodexRuntimeConfig {
  apiKey?: string;
  defaultModel?: string;
  /** True only when the user explicitly chose a model — account auth must not receive an app-side default. */
  explicitModel?: boolean;
  workingDirectory?: string;
}

/** Codex reports failures as prose; classify the few that have a real operator action. */
/** New suffix of `next` relative to what was already streamed; the whole text if the model rewrote it. */
function deltaSince(streamed: string, next: string): string {
  if (!next || next === streamed) return '';
  return next.startsWith(streamed) ? next.slice(streamed.length) : next;
}

export function describeCodexFailure(message: string): string {
  const text = String(message || '');
  if (/usage limit/i.test(text)) {
    const hint = text.match(/you'?ve? hit your usage limit[^\n]*/i);
    return `Codex usage limit reached — ${hint ? hint[0].trim() : 'top up at chatgpt.com/codex/settings/usage.'}`;
  }
  if (/not (?:logged in|authenticated)|unauthorized|401/i.test(text)) {
    return 'Codex is not authenticated — run "codex login" in a terminal, or set an OpenAI API key in Settings.';
  }
  if (/ENOENT|not recognized|command not found/i.test(text)) {
    return 'The Codex CLI is not installed or not on PATH. Install it with "npm i -g @openai/codex".';
  }
  return text.split(/\r?\n/)[0] || 'Codex turn failed.';
}

export function normalizeCodexUsage(breakdown: any, model: string, billed: boolean): ProviderUsage {
  const inputTokens = Math.max(0, Number(breakdown?.inputTokens) || 0);
  const cacheReadTokens = Math.max(0, Number(breakdown?.cachedInputTokens) || 0);
  const cacheWriteTokens = Math.max(0, Number(breakdown?.cacheWriteInputTokens) || 0);
  const freshInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = Math.max(0, Number(breakdown?.outputTokens) || 0);
  const usage: ProviderUsage = {
    // Codex includes cache writes in inputTokens, so each billing class must be disjoint.
    inputTokens: freshInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // App Server can report a cumulative total beside last-turn categories. Deriving this value
    // from the mutually exclusive categories keeps displayed and billed totals consistent.
    totalTokens: freshInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: 0,
  };
  // Subscription/account turns are not billed per token; only API-key mode has a rate.
  if (billed) usage.costUsd = estimateCost(model, usage);
  return usage;
}

/**
 * Model ids the local runtime has reported. The static registry in providers/types.ts holds
 * defaults, caps, and pricing; the runtime serves more than that (older GPT-5.x tiers, codex-spark).
 * Settings offers whatever the runtime lists, so the synchronous model resolver has to accept those
 * too — otherwise a model the user just picked is silently replaced by the default.
 */
const seenModelIds = new Set<string>();
let accountSdkModel = '';

export function rememberModelIds(ids: string[]): void {
  for (const id of ids) if (id) seenModelIds.add(id);
}

export function isKnownCodexModel(id: string): boolean {
  return seenModelIds.has(id);
}

export class CodexRuntime {
  private config: CodexRuntimeConfig;
  /** Live turns keyed by cancel key, so Stop maps to a real interrupt. */
  private inflight = new Map<string, { threadId: string; abort: AbortController }>();

  constructor(config: CodexRuntimeConfig = {}) {
    this.config = config;
  }

  get billed(): boolean {
    return !!this.config.apiKey;
  }

  /** The model id actually sent to Codex, or undefined to defer to the local config. */
  resolveModel(model?: string): string | undefined {
    const chosen = model || this.config.defaultModel;
    if (!chosen || chosen === CODEX_LOCAL_DEFAULT_MODEL) return undefined;
    // Account auth must not receive a model the user never chose; it can force API-key auth.
    if (!this.config.apiKey && !this.config.explicitModel && (!model || model === this.config.defaultModel)) return undefined;
    return chosen;
  }

  private async accountModel(model?: string): Promise<string | undefined> {
    const selected = this.resolveModel(model);
    if (selected || this.billed) return selected;
    if (!accountSdkModel) accountSdkModel = (await this.listModels())[0]?.id || '';
    if (!accountSdkModel) throw new Error('Codex did not report an account-supported model. Reconnect your ChatGPT account and retry.');
    return accountSdkModel;
  }

  private async threadParams(opts: CodexRunOptions) {
    const mcp = codexMcpServers(opts.mcpServers);
    const model = await this.accountModel(opts.model);
    return {
      ...(model ? { model } : {}),
      cwd: this.config.workingDirectory || process.cwd(),
      sandbox: 'read-only',
      // Escalations are denied by the client anyway; asking keeps tool approvals reaching us.
      approvalPolicy: 'on-request',
      // Always send the table, even empty: Codex merges the user's own ~/.codex/config.toml, so a
      // developer's global server (a Playwright one drives a REAL browser window) would otherwise be
      // inherited by every agent turn. Sending it explicitly makes our scoped set the only one.
      config: { mcp_servers: mcp, web_search: opts.webSearchMode ?? 'disabled' },
      ...(opts.system ? { developerInstructions: opts.system } : {}),
    };
  }

  private turnInput(opts: CodexRunOptions) {
    const input: any[] = [{ type: 'text', text: opts.prompt }];
    for (const path of opts.imagePaths || []) input.push({ type: 'localImage', path });
    return input;
  }

  private transport(opts: CodexRunOptions, streaming = false): 'sdk' | 'app-server' {
    const mode = String(process.env.CODEX_TRANSPORT || 'auto').toLowerCase();
    if (mode === 'app-server') return 'app-server';
    // Scoped MCP tools run over App Server. The SDK accepts `mcp_servers` via CodexOptions.config, but
    // live turns come back with the tool calls cancelled, so tool-bearing turns keep the proven path.
    if (opts.mcpServers && Object.keys(opts.mcpServers).length) return 'app-server';
    if (mode === 'sdk') return 'sdk';
    // The SDK's JSONL reports an agent message ONLY at item.completed — measured 1 delta vs App Server's
    // 149 for the same answer, and ~2x the time to first token. A live turn on it shows a blank pane until
    // the whole reply lands, so anything the user watches stream goes over App Server.
    if (streaming) return 'app-server';
    return 'sdk';
  }

  /** One turn, yielding normalized events from the SDK or the approval-capable fallback. */
  async *stream(opts: CodexRunOptions, cancelKey?: string, streaming = true): AsyncGenerator<CodexEvent> {
    if (this.transport(opts, streaming) === 'app-server') {
      yield* this.streamAppServer(opts, cancelKey);
      return;
    }
    let emitted = false;
    try {
      for await (const event of this.streamSdk(opts, cancelKey)) {
        emitted = true;
        yield event;
      }
    } catch (error: any) {
      const conflict = /thread-store conflict|active writer/i.test(String(error?.message || error));
      if (String(process.env.CODEX_TRANSPORT || 'auto').toLowerCase() !== 'auto' || emitted || !conflict) throw error;
      yield* this.streamAppServer(opts, cancelKey);
    }
  }

  private async *streamSdk(opts: CodexRunOptions, cancelKey?: string): AsyncGenerator<CodexEvent> {
    const model = this.resolveModel(opts.model) || this.config.defaultModel || CODEX_LOCAL_DEFAULT_MODEL;
    const abort = new AbortController();
    const onExternalAbort = () => abort.abort();
    if (opts.signal?.aborted) abort.abort();
    else opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (cancelKey) this.inflight.set(cancelKey, { threadId: opts.threadId || '', abort });
    let lastMessage = '';
    let streamedText = '';
    try {
      for await (const event of streamSdkTurn(opts, this.config, await this.accountModel(opts.model), abort.signal)) {
        switch (event.type) {
          case 'thread.started':
            if (cancelKey) this.inflight.set(cancelKey, { threadId: event.thread_id, abort });
            yield { type: 'thread.started', threadId: event.thread_id };
            break;
          case 'item.started':
            if (event.item.type === 'mcp_tool_call') {
              yield { type: 'tool.started', call: { server: event.item.server, tool: event.item.tool, arguments: event.item.arguments } };
            } else if (event.item.type === 'web_search') {
              yield { type: 'web.search', query: event.item.query, status: 'started' };
            } else if (event.item.type === 'agent_message') {
              streamedText = '';
            }
            break;
          // The SDK reports partial text on item.updated. Without this case the whole answer arrived as one
          // delta at item.completed — the transport streamed nothing and the user watched a blank pane.
          case 'item.updated':
            if (event.item.type === 'agent_message') {
              const delta = deltaSince(streamedText, event.item.text);
              if (delta) { streamedText = event.item.text; yield { type: 'text.delta', delta }; }
            }
            break;
          case 'item.completed':
            if (event.item.type === 'agent_message') {
              lastMessage = event.item.text;
              const tail = deltaSince(streamedText, event.item.text);
              if (tail) yield { type: 'text.delta', delta: tail };
              streamedText = '';
              yield { type: 'message', text: event.item.text };
            } else if (event.item.type === 'reasoning') {
              yield { type: 'reasoning', text: event.item.text };
            } else if (event.item.type === 'web_search') {
              yield { type: 'web.search', query: event.item.query, status: 'completed' };
            } else if (event.item.type === 'mcp_tool_call') {
              yield { type: 'tool.completed', call: { server: event.item.server, tool: event.item.tool, arguments: event.item.arguments, error: event.item.error?.message } };
            } else if (event.item.type === 'error') {
              yield { type: 'reasoning', text: event.item.message };
            }
            break;
          case 'turn.completed':
            yield { type: 'usage', usage: normalizeCodexUsage({
              inputTokens: event.usage.input_tokens,
              cachedInputTokens: event.usage.cached_input_tokens,
              cacheWriteInputTokens: event.usage.cache_write_input_tokens,
              outputTokens: event.usage.output_tokens,
              totalTokens: event.usage.input_tokens + event.usage.output_tokens,
            }, model, this.billed) };
            yield { type: 'completed', text: lastMessage };
            break;
          case 'turn.failed':
            yield { type: 'failed', message: describeCodexFailure(event.error.message) };
            break;
          case 'error':
            yield { type: 'failed', message: describeCodexFailure(event.message) };
            break;
          default:
        }
      }
      if (abort.signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
    } catch (error) {
      if (abort.signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
      throw error;
    } finally {
      opts.signal?.removeEventListener('abort', onExternalAbort);
      if (cancelKey) this.inflight.delete(cancelKey);
    }
  }

  /** Approval-capable App Server path for scoped MCP turns and migration fallback. */
  private async *streamAppServer(opts: CodexRunOptions, cancelKey?: string): AsyncGenerator<CodexEvent> {
    const client = getAppServerClient();

    let threadId = opts.threadId || '';
    if (threadId) {
      await client.call('thread/resume', { threadId, ...await this.threadParams(opts) });
    } else {
      const started = await client.call<any>('thread/start', await this.threadParams(opts));
      threadId = String(started?.thread?.id || started?.threadId || '');
      if (!threadId) throw new Error('Codex did not return a thread id.');
    }
    yield { type: 'thread.started', threadId };

    const model = this.resolveModel(opts.model) || this.config.defaultModel || CODEX_LOCAL_DEFAULT_MODEL;
    const abort = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) abort.abort();
      else opts.signal.addEventListener('abort', () => abort.abort(), { once: true });
    }
    if (cancelKey) this.inflight.set(cancelKey, { threadId, abort });

    // Notifications arrive out-of-band; buffer them into a queue this generator drains in order.
    const queue: CodexEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    let turnId = '';
    const push = (event: CodexEvent) => { queue.push(event); notify?.(); };

    const unsubscribe = client.subscribe(threadId, (method, params) => {
      switch (method) {
        case 'turn/started':
          turnId = String(params?.turn?.id || params?.turnId || '');
          return;
        case 'item/agentMessage/delta':
          if (params?.delta) push({ type: 'text.delta', delta: String(params.delta) });
          return;
        case 'item/started':
          if (params?.item?.type === 'mcpToolCall') {
            push({ type: 'tool.started', call: { server: params.item.server, tool: params.item.tool, arguments: params.item.arguments } });
          } else if (params?.item?.type === 'webSearch') {
            push({ type: 'web.search', query: String(params.item.query || ''), status: 'started' });
          }
          return;
        case 'item/completed': {
          const item = params?.item;
          if (!item) return;
          if (item.type === 'mcpToolCall') {
            push({ type: 'tool.completed', call: { server: item.server, tool: item.tool, arguments: item.arguments, error: item.error?.message } });
          } else if (item.type === 'webSearch') {
            push({ type: 'web.search', query: String(item.query || ''), status: 'completed' });
          } else if (item.type === 'agentMessage' && item.text) {
            push({ type: 'message', text: String(item.text) });
          } else if (item.type === 'reasoning' && item.text) {
            push({ type: 'reasoning', text: String(item.text) });
          } else if (item.type === 'error' && item.message) {
            push({ type: 'reasoning', text: String(item.message) });
          }
          return;
        }
        case 'thread/tokenUsage/updated':
          push({ type: 'usage', usage: normalizeCodexUsage(params?.tokenUsage?.last, model, this.billed) });
          return;
        case 'turn/completed': {
          if (params?.turn?.status === 'failed' || params?.turn?.error) {
            push({ type: 'failed', message: describeCodexFailure(params?.turn?.error?.message || 'Codex turn failed.') });
            done = true;
            notify?.();
            return;
          }
          const items: any[] = params?.turn?.items || [];
          const finalItem = [...items].reverse().find((i) => i?.type === 'agentMessage' && i?.text);
          push({ type: 'completed', text: finalItem ? String(finalItem.text) : '' });
          done = true;
          notify?.();
          return;
        }
        case 'turn/failed':
          push({ type: 'failed', message: describeCodexFailure(params?.error?.message || params?.message || 'Codex turn failed.') });
          done = true;
          notify?.();
          return;
        case 'error':
          push({ type: 'reasoning', text: String(params?.error?.message || params?.message || 'Codex runtime warning.') });
          return;
        default:
      }
    });

    const turnParams = {
      threadId,
      input: this.turnInput(opts),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    };

    // turn/start resolves when the turn ENDS; the queue carries progress meanwhile. Never awaited
    // on the way out — after an interrupt it can settle much later, and Stop must return at once.
    client.callTurn('turn/start', turnParams).catch((err: any) => {
      if (abort.signal.aborted) return;
      push({ type: 'failed', message: describeCodexFailure(err?.message || String(err)) });
      done = true;
      notify?.();
    });
    const onAbort = () => {
      client.call('turn/interrupt', { threadId, ...(turnId ? { turnId } : {}) }).catch(() => undefined);
      done = true;
      notify?.();
    };
    abort.signal.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((resolve) => { notify = resolve; });
        notify = null;
      }
      while (queue.length) yield queue.shift()!;
      if (abort.signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
    } finally {
      unsubscribe();
      abort.signal.removeEventListener('abort', onAbort);
      if (cancelKey) this.inflight.delete(cancelKey);
    }
  }

  /** One turn, returning the final text. Structured turns pass `outputSchema`. */
  async run(opts: CodexRunOptions, cancelKey?: string): Promise<CodexRunResult> {
    const model = this.resolveModel(opts.model) || this.config.defaultModel || CODEX_LOCAL_DEFAULT_MODEL;
    let threadId: string | null = opts.threadId || null;
    let text = '';
    let lastMessage = '';
    let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
    const toolCalls: CodexToolCall[] = [];
    let failure = '';

    // Only a caller that actually consumes deltas needs the streaming transport; a plain collect-the-text
    // turn keeps the SDK path (and its faster cancellation).
    for await (const event of this.stream(opts, cancelKey, Boolean(opts.onTextDelta))) {
      switch (event.type) {
        case 'thread.started': threadId = event.threadId; break;
        case 'text.delta': opts.onTextDelta?.(event.delta); break;
        case 'web.search': opts.onWebSearch?.({ query: event.query, status: event.status }); break;
        case 'tool.completed': toolCalls.push(event.call); break;
        case 'message': lastMessage = event.text; break;
        case 'usage': usage = event.usage; break;
        case 'completed': text = event.text || lastMessage; break;
        case 'failed': failure = event.message; break;
        default:
      }
    }
    if (failure && !text) throw new Error(failure);
    return { text, threadId, usage, model, toolCalls };
  }

  /** Stop button → interrupt the live turn. Returns false when nothing was running. */
  interrupt(cancelKey: string): boolean {
    const live = this.inflight.get(cancelKey);
    if (!live) return false;
    live.abort.abort();
    this.inflight.delete(cancelKey);
    return true;
  }

  async health(): Promise<CodexHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const status = await getAppServerClient().authStatus();
      const authed = !!status.authMethod || status.requiresOpenaiAuth === false || this.billed;
      return {
        ok: authed,
        model: this.config.defaultModel || CODEX_LOCAL_DEFAULT_MODEL,
        authMethod: this.billed ? 'apikey' : status.authMethod,
        error: authed ? undefined : 'Codex is not authenticated — run "codex login" in a terminal.',
        checkedAt,
      };
    } catch (err: any) {
      return { ok: false, model: this.config.defaultModel, error: describeCodexFailure(err?.message || String(err)), checkedAt };
    }
  }

  async accountInfo(model?: string): Promise<CodexAccountInfo> {
    return getAppServerClient().accountInfo(model);
  }

  /** Models the local runtime offers; empty when it declines to enumerate. */
  async listModels(): Promise<CodexModelInfo[]> {
    try {
      const models = await getAppServerClient().listModels();
      rememberModelIds(models.map((m) => m.id));
      return models;
    } catch {
      return [];
    }
  }
}
