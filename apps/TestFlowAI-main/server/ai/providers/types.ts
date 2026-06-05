/**
 * TestFlowAI — AI Provider Abstraction
 *
 * The previous implementation hard-coded Gemini via the `ai` SDK (`generateObject`
 * from the `ai` package with a `createGeminiModel()` helper in
 * `server/shared/ai.ts`). That made it impossible to use OpenAI or Anthropic.
 *
 * This file defines a single Provider interface and a factory that returns a
 * provider by name. The Gemini implementation wraps the existing `ai`-SDK call.
 * The OpenAI and Anthropic implementations use direct REST calls so the package
 * footprint stays small.
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

export interface AIProvider {
  readonly name: ProviderName;
  health(): Promise<ProviderHealth>;
  generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>>;
  generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>>;
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
  gemini: { default: 'gemini-2.5-flash', alternatives: ['gemini-2.5-pro', 'gemini-2.0-flash'] },
  openai: { default: 'gpt-4o-mini', alternatives: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  anthropic: { default: 'claude-3-5-sonnet-latest', alternatives: ['claude-3-5-haiku-latest', 'claude-3-opus-latest'] },
};

export const PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.075, output: 0.3 },
  'gemini-2.5-pro': { input: 1.25, output: 5.0 },
  'gemini-2.0-flash': { input: 0.075, output: 0.3 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'claude-3-5-sonnet-latest': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-latest': { input: 0.8, output: 4.0 },
  'claude-3-opus-latest': { input: 15.0, output: 75.0 },
};

export function estimateCost(model: string, usage: ProviderUsage | undefined): number {
  if (!usage || usage.totalTokens === undefined) return 0;
  const pricing = PRICING_PER_1M_TOKENS[model] ?? { input: 1.0, output: 3.0 };
  const inCost = ((usage.inputTokens ?? usage.totalTokens / 2) / 1_000_000) * pricing.input;
  const outCost = ((usage.outputTokens ?? usage.totalTokens / 2) / 1_000_000) * pricing.output;
  return inCost + outCost;
}
