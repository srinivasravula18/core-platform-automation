/**
 * Test Flow AI — AI Provider Abstraction
 *
 * One runtime: Codex. This file keeps the provider-shaped seam every caller already uses
 * (generateObject / generateText / generateTextStream / health) plus the model registry that
 * governs context, output ceilings, and cost. Tool calling is native to the runtime — Codex
 * reaches the application's tools through the scoped MCP bridge, not through this interface.
 *
 * The provider implements:
 *   - generateObject<T>({ system, prompt, schema, temperature }): T
 *   - generateText({ system, prompt, temperature }): { text, usage }
 *   - health(): { ok, model, error? }
 *   - name: ProviderName
 *
 * Errors are normalized to a single shape via the `ProviderError` class.
 */

export type ProviderName = 'codex';
export type ProviderAuthMode = 'api_key' | 'account';

/** An inline image attachment (raw base64, no data: prefix) for multimodal structured output. */
export interface ProviderImage {
  mimeType: string;
  dataBase64: string;
}

/** Mime types every multimodal provider here accepts inline. */
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const MAX_IMAGES_PER_REQUEST = 4;

/** Keeps at most 4 supported images (png/jpeg/webp/gif), warning when any are dropped. */
export function sanitizeProviderImages(images?: ProviderImage[]): ProviderImage[] {
  if (!images?.length) return [];
  const kept = images
    .filter((img) => !!img?.dataBase64 && SUPPORTED_IMAGE_MIME_TYPES.has(String(img?.mimeType || '').toLowerCase()))
    .slice(0, MAX_IMAGES_PER_REQUEST);
  if (kept.length < images.length) console.warn(`[providers] dropped ${images.length - kept.length} image attachment(s): max ${MAX_IMAGES_PER_REQUEST} per request, png/jpeg/webp/gif only`);
  return kept;
}

export interface GenerateObjectOptions<T> {
  system?: string;
  prompt: string;
  schema: T;
  temperature?: number;
  maxTokens?: number;
  effort?: string;
  model?: string;
  signal?: AbortSignal;
  /** Optional inline images sent with the prompt; providers without multimodal support ignore them. */
  images?: ProviderImage[];
}

export interface GenerateTextOptions {
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  effort?: string;
  model?: string;
  signal?: AbortSignal;
  /** Streaming yields text only, so usage has to come back out of band or the turn bills as zero. */
  onUsage?: (usage: ProviderUsage, model?: string) => void;
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

export interface ProviderCacheMetrics {
  readTokens: number;
  writeTokens: number;
  freshInputTokens: number;
  reusableInputTokens: number;
  hitRate: number;
}

/** Provider usage categories are mutually exclusive after runtime normalization. */
export function providerCacheMetrics(usage?: ProviderUsage): ProviderCacheMetrics {
  const readTokens = Math.max(0, Number(usage?.cacheReadTokens) || 0);
  const writeTokens = Math.max(0, Number(usage?.cacheWriteTokens) || 0);
  const freshInputTokens = Math.max(0, Number(usage?.inputTokens) || 0);
  const reusableInputTokens = readTokens + writeTokens + freshInputTokens;
  return {
    readTokens,
    writeTokens,
    freshInputTokens,
    reusableInputTokens,
    hitRate: reusableInputTokens ? readTokens / reusableInputTokens : 0,
  };
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

/** A tool exposed to the model. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AIProvider {
  readonly name: ProviderName;
  health(): Promise<ProviderHealth>;
  generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>>;
  generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>>;
  /** Token stream. Yields text deltas as they arrive. */
  generateTextStream?(opts: GenerateTextOptions): AsyncIterable<string>;
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

/** `codex-default` defers to the local Codex config instead of pinning a model id. */
export const DEFAULT_MODELS: Record<ProviderName, { default: string; alternatives: string[] }> = {
  codex: { default: 'gpt-5.6-sol', alternatives: ['gpt-5.6-terra', 'gpt-5.6-luna', 'codex-default'] },
};

export function listAvailableModels(provider: ProviderName = 'codex'): string[] {
  return [DEFAULT_MODELS[provider].default, ...DEFAULT_MODELS[provider].alternatives];
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

// Per-1M-token prices from developers.openai.com/api/docs/pricing (verified July 2026).
// GPT-5.6 (Sol/Terra/Luna, GA 2026-07-09): cache-write = 1.25× input, cached READS discounted 90%.
// Only billed in API-key mode — subscription/ChatGPT Codex turns record zero cost.
export const PRICING_PER_1M_TOKENS: Record<string, ModelPricing> = {
  'gpt-5.6-sol': { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'gpt-5.6-terra': { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 3.125 },
  'gpt-5.6-luna': { input: 1.0, output: 6.0, cacheRead: 0.1, cacheWrite: 1.25 },
};

/* ----------------------------------------------------------------------------
 * Model capability registry — context window + max OUTPUT tokens per model.
 *
 * Limits follow the MODEL the user picks in Settings, never a scattered hardcoded cap.
 * Context budgeting reads these to size prompts against the real limit. Update here only
 * when Codex ships new context/output sizes — this is the single source of truth.
 * -------------------------------------------------------------------------- */
export interface ModelCaps {
  /** Total context window (input + output) the model accepts, in tokens. */
  contextWindow: number;
  /** Maximum OUTPUT tokens the model can produce in one response. */
  maxOutput: number;
}

// Verified against developers.openai.com model docs (June 2026).
export const MODEL_CAPS: Record<string, ModelCaps> = {
  'gpt-5.6-sol': { contextWindow: 1_050_000, maxOutput: 128_000 },
  'gpt-5.6-terra': { contextWindow: 1_050_000, maxOutput: 128_000 },
  'gpt-5.6-luna': { contextWindow: 1_050_000, maxOutput: 128_000 },
};

/** Fallback so an unknown/newer Codex model id still gets sane caps. */
function familyCaps(model: string): ModelCaps {
  const m = String(model || '').toLowerCase();
  if (m.includes('gpt') || m.includes('codex')) return { contextWindow: 400_000, maxOutput: 128_000 };
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
