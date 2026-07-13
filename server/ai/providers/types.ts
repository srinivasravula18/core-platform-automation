/**
 * Test Flow AI — AI Provider Abstraction
 *
 * This file defines the supported Provider interface and model registry.
 * Test Flow AI currently exposes Gemini, OpenAI, and Anthropic as service providers.
 *
 * All providers implement the same surface:
 *   - generateObject<T>({ system, prompt, schema, temperature }): T
 *   - generateText({ system, prompt, temperature }): { text, usage }
 *   - health(): { ok, model, error? }
 *   - name: ProviderName
 *
 * Errors are normalized to a single shape via the `ProviderError` class.
 */

export type ProviderName = 'gemini' | 'openai' | 'anthropic';
export type ProviderAuthMode = 'api_key' | 'account';

export interface GenerateObjectOptions<T> {
  system?: string;
  prompt: string;
  schema: T;
  temperature?: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  model?: string;
  signal?: AbortSignal;
}

export interface GenerateTextOptions {
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  model?: string;
  signal?: AbortSignal;
}

export interface ProviderUsage {
  /** Non-cached (freshly-processed) input tokens, billed at the base input rate. */
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens served from the prompt cache (billed at the cheaper cache-read rate). */
  cacheReadTokens?: number;
  /** Tokens written INTO the cache this call (billed at the cache-write rate; 0 for auto-cache providers). */
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ProviderResponse<T> {
  object: T;
  text: string;
  usage?: ProviderUsage;
  model: string;
  provider: ProviderName;
  latencyMs: number;
}

export interface ProviderHealth {
  ok: boolean;
  provider: ProviderName;
  model?: string;
  error?: string;
  checkedAt: string;
}

/* ----------------------------------------------------------------------------
 * Native tool-calling (function-calling) surface.
 *
 * `chatWithTools` is ONE round-trip: given the running message list and the tool
 * specs, the provider returns either final assistant text OR a set of tool-call
 * requests (using each SDK's native function-calling — Anthropic tool_use, OpenAI
 * tool_calls, Gemini functionCall). The agent LOOP (server/ai/agentLoop.ts) owns
 * the iteration: it executes the requested tools, appends the results as `tool`
 * messages, and calls chatWithTools again until the model returns text, an accept
 * check passes, or a budget is hit. No Vercel AI SDK — native SDKs only.
 * -------------------------------------------------------------------------- */

/** A tool exposed to the model. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  /** Provider-assigned call id (used to correlate the tool result). */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  /** Text content (assistant text, user text, or a serialized tool result). */
  content?: string;
  /** Present on assistant turns that requested tool calls. */
  toolCalls?: ToolCallRequest[];
  /** Present on role:'tool' messages — correlates to a prior ToolCallRequest.id. */
  toolCallId?: string;
  toolName?: string;
}

export interface ChatWithToolsOptions {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  model?: string;
  signal?: AbortSignal;
}

export interface ChatWithToolsResult {
  /** Final assistant text, if the model answered instead of calling tools. */
  text?: string;
  /** Tool calls the model wants executed this round (empty when it answered). */
  toolCalls: ToolCallRequest[];
  usage?: ProviderUsage;
  model: string;
  provider: ProviderName;
  stopReason: 'tool_calls' | 'stop' | 'length' | 'other';
  latencyMs: number;
}

export interface AIProvider {
  readonly name: ProviderName;
  health(): Promise<ProviderHealth>;
  generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>>;
  generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>>;
  /** Optional token stream. Yields text deltas as they arrive. */
  generateTextStream?(opts: GenerateTextOptions): AsyncIterable<string>;
  /** Optional native tool-calling round-trip. Providers that implement it enable
   * the agent loop; the account/CLI provider may omit it. */
  chatWithTools?(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult>;
}

export class ProviderError extends Error {
  constructor(
    public provider: ProviderName,
    public code: 'auth' | 'rate_limit' | 'quota' | 'bad_request' | 'network' | 'unknown',
    message: string,
    public status?: number,
  ) {
    super(`[${provider}] ${code}: ${message}`);
  }
}

export function classifyError(provider: ProviderName, status: number | undefined, body: string): ProviderError {
  if (status === 401 || status === 403) return new ProviderError(provider, 'auth', body, status);
  if (status === 429) return new ProviderError(provider, 'rate_limit', body, status);
  if (status === 400) return new ProviderError(provider, 'bad_request', body, status);
  if (status === 402) return new ProviderError(provider, 'quota', body, status);
  if (status && status >= 500) return new ProviderError(provider, 'network', body, status);
  return new ProviderError(provider, 'unknown', body, status);
}

export const DEFAULT_MODELS: Record<ProviderName, { default: string; alternatives: string[] }> = {
  gemini: { default: 'gemini-2.5-flash', alternatives: ['gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'] },
  openai: { default: 'gpt-5.6-sol', alternatives: ['gpt-5.6-terra', 'gpt-5.6-luna'] },
  anthropic: { default: 'claude-opus-4-8', alternatives: ['claude-sonnet-4-6', 'claude-haiku-4-5'] },
};

export const LOCAL_ONLY_MODELS: Partial<Record<ProviderName, string[]>> = {
  openai: ['codex-spark'],
};

export function listAvailableModels(provider: ProviderName, opts?: { includeLocalOnly?: boolean }): string[] {
  const base = [DEFAULT_MODELS[provider].default, ...DEFAULT_MODELS[provider].alternatives];
  if (!opts?.includeLocalOnly) return base;
  return [...base, ...(LOCAL_ONLY_MODELS[provider] || [])];
}

export interface ModelPricing {
  /** Base (non-cached) input, per 1M tokens. */
  input: number;
  /** Output, per 1M tokens. */
  output: number;
  /** Cache-read (hit), per 1M tokens. Defaults to 0.1× input when unset. */
  cacheRead?: number;
  /** Cache-write (5-minute creation), per 1M tokens. For auto-cache providers (OpenAI/Gemini) this
   *  equals the input rate (no extra write charge). Defaults to 1.25× input when unset. */
  cacheWrite?: number;
}

// Per-1M-token prices from each provider's OFFICIAL pricing page (verified July 2026):
//   OpenAI  developers.openai.com/api/docs/pricing  (cache-write = input; only cached READS are discounted)
//   Anthropic platform.claude.com/docs/en/about-claude/pricing (5m cache-write = 1.25× input, read = 0.1× input)
//   Google  ai.google.dev/gemini-api/docs/pricing  (standard tier; cache-write billed as hourly storage, approximated as input here)
export const PRICING_PER_1M_TOKENS: Record<string, ModelPricing> = {
  // OpenAI GPT-5.x
  'gpt-5.5': { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 5.0 },
  'gpt-5.4': { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 2.5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
  // Anthropic Claude
  'claude-fable-5': { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 }, // intro thru 2026-08-31
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  // Google Gemini (standard tier)
  'gemini-3.5-flash': { input: 1.5, output: 9.0, cacheRead: 0.15, cacheWrite: 1.5 },
  'gemini-3.1-pro': { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.0 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
};

/* ----------------------------------------------------------------------------
 * Model capability registry — context window + max OUTPUT tokens per model.
 *
 * The point: limits follow the MODEL the user picks in Settings, never a scattered
 * hardcoded cap. Providers derive their default max-output from `maxOutputFor(model)`
 * instead of a fixed 8192/4096 (which truncated long agent outputs). For API-key usage
 * the user monitors real spend via the cost tracker, so a roomy model-defined ceiling is
 * the right default. Update these when a provider ships new context/output sizes — it is
 * the single source of truth.
 * -------------------------------------------------------------------------- */
export interface ModelCaps {
  /** Total context window (input + output) the model accepts, in tokens. */
  contextWindow: number;
  /** Maximum OUTPUT tokens the model can produce in one response. */
  maxOutput: number;
}

// Verified against official provider docs (June 2026): platform.claude.com/docs (Models
// overview), developers.openai.com (GPT-5.4/5.5), ai.google.dev (Gemini). Update here only.
export const MODEL_CAPS: Record<string, ModelCaps> = {
  // Gemini — 1,048,576 context, 65,536 max output.
  'gemini-2.5-flash': { contextWindow: 1_048_576, maxOutput: 65_536 },
  'gemini-2.5-flash-lite': { contextWindow: 1_048_576, maxOutput: 65_536 },
  'gemini-2.5-pro': { contextWindow: 1_048_576, maxOutput: 65_536 },
  'gemini-3.5-flash': { contextWindow: 1_048_576, maxOutput: 65_536 },
  'gemini-3.1-pro': { contextWindow: 1_048_576, maxOutput: 65_536 },
  'gemini-3.1-flash-lite': { contextWindow: 1_048_576, maxOutput: 65_536 },
  // OpenAI GPT-5.x — GPT-5.4 / 5.5 have a 1.05M context window, 128k max output. (mini/nano
  // specs aren't published separately; kept conservative at 400k context, 128k output.)
  'gpt-5.5': { contextWindow: 1_050_000, maxOutput: 128_000 },
  'gpt-5.4': { contextWindow: 1_050_000, maxOutput: 128_000 },
  'gpt-5.4-mini': { contextWindow: 400_000, maxOutput: 128_000 },
  'gpt-5.4-nano': { contextWindow: 400_000, maxOutput: 128_000 },
  'codex-spark': { contextWindow: 400_000, maxOutput: 128_000 },
  // Anthropic Claude 4.x — Opus 4.8 & Sonnet 4.6 are 1M context; Haiku 4.5 is 200k. Max output:
  // Opus 128k, Sonnet & Haiku 64k. (Batch API can extend output to 300k via beta header.)
  'claude-opus-4-8': { contextWindow: 1_000_000, maxOutput: 128_000 },
  'claude-sonnet-4-6': { contextWindow: 1_000_000, maxOutput: 64_000 },
  'claude-haiku-4-5': { contextWindow: 200_000, maxOutput: 64_000 },
  'claude-fable-5': { contextWindow: 1_000_000, maxOutput: 128_000 },
};

/** Family-based fallback so an unknown/newer model id still gets sane, model-appropriate caps. */
function familyCaps(model: string): ModelCaps {
  const m = String(model || '').toLowerCase();
  if (m.includes('gemini')) return { contextWindow: 1_048_576, maxOutput: 65_536 };
  if (m.includes('gpt') || m.startsWith('o')) return { contextWindow: 400_000, maxOutput: 128_000 };
  if (m.includes('haiku')) return { contextWindow: 200_000, maxOutput: 64_000 };
  if (m.includes('opus') || m.includes('fable') || m.includes('mythos')) return { contextWindow: 1_000_000, maxOutput: 128_000 };
  if (m.includes('sonnet') || m.includes('claude')) return { contextWindow: 1_000_000, maxOutput: 64_000 };
  return { contextWindow: 128_000, maxOutput: 16_000 };
}

export function modelCaps(model: string): ModelCaps {
  return MODEL_CAPS[model] || familyCaps(model);
}
/** The model's max OUTPUT tokens — providers use this as the default ceiling (not a hardcode). */
export function maxOutputFor(model: string): number {
  return modelCaps(model).maxOutput;
}
/** The model's total context window — for budgeting input + history against the real limit. */
export function contextWindowFor(model: string): number {
  return modelCaps(model).contextWindow;
}

/** Resolved pricing for a model, filling cache rates from the standard multipliers when a model
 *  omits them (5m write = 1.25× input, read = 0.1× input). Unknown models get a conservative default. */
export function pricingFor(model: string): Required<ModelPricing> {
  const p = PRICING_PER_1M_TOKENS[model] ?? { input: 1.0, output: 3.0 };
  return {
    input: p.input,
    output: p.output,
    cacheRead: p.cacheRead ?? p.input * 0.1,
    cacheWrite: p.cacheWrite ?? p.input * 1.25,
  };
}

/** Cost in USD for a call, pricing each token class separately: non-cached input, output, cache
 *  reads (cheap), and cache writes (dearer). inputTokens must already EXCLUDE cached tokens. */
export function estimateCost(model: string, usage: ProviderUsage | undefined): number {
  if (!usage || usage.totalTokens === undefined) return 0;
  const p = pricingFor(model);
  const input = usage.inputTokens ?? usage.totalTokens / 2;
  const output = usage.outputTokens ?? usage.totalTokens / 2;
  return (
    (input / 1_000_000) * p.input +
    (output / 1_000_000) * p.output +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * p.cacheRead +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) * p.cacheWrite
  );
}
