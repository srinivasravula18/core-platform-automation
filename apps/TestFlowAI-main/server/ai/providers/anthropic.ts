/**
 * Anthropic provider — direct REST calls to the Messages API.
 *
 * Uses fetch directly so we do not pull in the `@anthropic-ai/sdk` package.
 * Anthropic's Messages API does not support a strict JSON mode, so we
 * instruct the model via the system prompt to return ONLY JSON.
 */

import { z } from 'zod';
import type {
  AIProvider,
  GenerateObjectOptions,
  GenerateTextOptions,
  ProviderHealth,
  ProviderResponse,
  ProviderName,
} from './types';
import { classifyError, DEFAULT_MODELS, estimateCost } from './types';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicProvider implements AIProvider {
  readonly name: ProviderName = 'anthropic';
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel?: string) {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel || DEFAULT_MODELS.anthropic.default;
  }

  private modelId(opts: { model?: string }) {
    return opts.model || this.defaultModel;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.apiKey) {
      return { ok: false, provider: 'anthropic', model: this.defaultModel, error: 'ANTHROPIC_API_KEY not set', checkedAt };
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.defaultModel,
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw classifyError('anthropic', res.status, body);
      }
      return { ok: true, provider: 'anthropic', model: this.defaultModel, checkedAt };
    } catch (err: any) {
      return {
        ok: false,
        provider: 'anthropic',
        model: this.defaultModel,
        error: err?.message || String(err),
        checkedAt,
      };
    }
  }

  private async callMessages(
    opts: GenerateTextOptions,
    jsonMode: boolean,
  ): Promise<{ content: string; usage?: { input_tokens: number; output_tokens: number } }> {
    const modelId = this.modelId(opts);
    const systemParts: string[] = [];
    if (opts.system) systemParts.push(opts.system);
    if (jsonMode) {
      systemParts.push(
        'Return ONLY a single JSON object. No markdown, no code fences, no commentary before or after. The JSON must match the schema you have been given.',
      );
    }
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.2,
      messages: [{ role: 'user', content: opts.prompt }],
    };
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw classifyError('anthropic', res.status, errBody);
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    return { content: text, usage: data.usage };
  }

  async generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    const { content, usage } = await this.callMessages(opts, false);
    const usageObj = usage
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.input_tokens + usage.output_tokens,
          costUsd: estimateCost(modelId, {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            totalTokens: usage.input_tokens + usage.output_tokens,
          }),
        }
      : undefined;
    return {
      object: content,
      text: content,
      usage: usageObj,
      model: modelId,
      provider: 'anthropic',
      latencyMs: Date.now() - start,
    };
  }

  async generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    const schemaZ = opts.schema as z.ZodTypeAny;
    const jsonHint = opts.system
      ? `${opts.system}\n\nReturn ONLY a single JSON object matching this schema: ${JSON.stringify(schemaZ._def ?? schemaZ)}`
      : `Return ONLY a single JSON object matching this schema: ${JSON.stringify(schemaZ._def ?? schemaZ)}`;
    const { content, usage } = await this.callMessages({ ...opts, system: jsonHint }, true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw classifyError('anthropic', 200, 'Model did not return valid JSON');
      parsed = JSON.parse(match[0]);
    }
    const validated = schemaZ.parse(parsed);
    const usageObj = usage
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.input_tokens + usage.output_tokens,
          costUsd: estimateCost(modelId, {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            totalTokens: usage.input_tokens + usage.output_tokens,
          }),
        }
      : undefined;
    return {
      object: validated as T,
      text: content,
      usage: usageObj,
      model: modelId,
      provider: 'anthropic',
      latencyMs: Date.now() - start,
    };
  }
}
