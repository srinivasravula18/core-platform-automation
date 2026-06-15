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
  model?: string;
  signal?: AbortSignal;
}

export interface GenerateTextOptions {
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
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
  openai: { default: 'gpt-5.4-mini', alternatives: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-nano'] },
  anthropic: { default: 'claude-opus-4-8', alternatives: ['claude-sonnet-4-6', 'claude-haiku-4-5'] },
};

export const PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gemini-3.5-flash': { input: 0.3, output: 2.5 },
  'gemini-3.1-pro': { input: 2.0, output: 12.0 },
  'gemini-3.1-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.075, output: 0.3 },
  'gemini-2.5-pro': { input: 1.25, output: 5.0 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

export function estimateCost(model: string, usage: ProviderUsage | undefined): number {
  if (!usage || usage.totalTokens === undefined) return 0;
  const pricing = PRICING_PER_1M_TOKENS[model] ?? { input: 1.0, output: 3.0 };
  const inCost = ((usage.inputTokens ?? usage.totalTokens / 2) / 1_000_000) * pricing.input;
  const outCost = ((usage.outputTokens ?? usage.totalTokens / 2) / 1_000_000) * pricing.output;
  return inCost + outCost;
}
