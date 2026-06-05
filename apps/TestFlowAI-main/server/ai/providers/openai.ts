/**
 * OpenAI provider — direct REST calls to the Chat Completions API.
 *
 * Uses fetch directly (Node 20+ has it built-in) so we do not pull in the
 * `openai` npm package. This keeps the dependency footprint small and lets
 * us swap providers without touching the call sites.
 *
 * The `generateObject` method sends a system prompt that instructs the model
 * to return strict JSON, then parses and validates it against the Zod schema.
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

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export class OpenAIProvider implements AIProvider {
  readonly name: ProviderName = 'openai';
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel?: string) {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel || DEFAULT_MODELS.openai.default;
  }

  private modelId(opts: { model?: string }) {
    return opts.model || this.defaultModel;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.apiKey) {
      return { ok: false, provider: 'openai', model: this.defaultModel, error: 'OPENAI_API_KEY not set', checkedAt };
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.defaultModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw classifyError('openai', res.status, body);
      }
      return { ok: true, provider: 'openai', model: this.defaultModel, checkedAt };
    } catch (err: any) {
      return {
        ok: false,
        provider: 'openai',
        model: this.defaultModel,
        error: err?.message || String(err),
        checkedAt,
      };
    }
  }

  private async callChat(
    opts: GenerateTextOptions,
    jsonMode: boolean,
  ): Promise<{ content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
    const modelId = this.modelId(opts);
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: opts.prompt },
      ],
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2048,
    };
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw classifyError('openai', res.status, errBody);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return { content, usage: data.usage };
  }

  async generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    const { content, usage } = await this.callChat(opts, false);
    const usageObj = usage
      ? {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          costUsd: estimateCost(modelId, {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }),
        }
      : undefined;
    return {
      object: content,
      text: content,
      usage: usageObj,
      model: modelId,
      provider: 'openai',
      latencyMs: Date.now() - start,
    };
  }

  async generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    const schemaZ = opts.schema as z.ZodTypeAny;
    const jsonHint = opts.system
      ? `${opts.system}\n\nReturn ONLY a JSON object that matches this schema: ${JSON.stringify(schemaZ._def ?? schemaZ)}\nDo not add commentary or markdown.`
      : `Return ONLY a JSON object that matches this schema: ${JSON.stringify(schemaZ._def ?? schemaZ)}\nDo not add commentary or markdown.`;
    const { content, usage } = await this.callChat({ ...opts, system: jsonHint }, true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw classifyError('openai', 200, 'Model did not return valid JSON');
      parsed = JSON.parse(match[0]);
    }
    const validated = schemaZ.parse(parsed);
    const usageObj = usage
      ? {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          costUsd: estimateCost(modelId, {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }),
        }
      : undefined;
    return {
      object: validated as T,
      text: content,
      usage: usageObj,
      model: modelId,
      provider: 'openai',
      latencyMs: Date.now() - start,
    };
  }
}
