/**
 * OpenAI provider — official `openai` SDK.
 *
 * The model is selected by the user in Settings and passed through per call;
 * this wrapper does not pick a model. generateObject uses JSON mode and then
 * validates against the provided Zod schema.
 */

import OpenAI from 'openai';
import { z } from 'zod';
import type {
  AIProvider,
  GenerateObjectOptions,
  GenerateTextOptions,
  ProviderHealth,
  ProviderResponse,
  ProviderName,
} from './types';
import { ProviderError, classifyError, DEFAULT_MODELS, estimateCost } from './types';

export class OpenAIProvider implements AIProvider {
  readonly name: ProviderName = 'openai';
  private client: OpenAI;
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel?: string) {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel || DEFAULT_MODELS.openai.default;
    this.client = new OpenAI({ apiKey });
  }

  private modelId(opts: { model?: string }) {
    return opts.model || this.defaultModel;
  }

  private toProviderError(err: any): ProviderError {
    if (err instanceof ProviderError) return err;
    const status = err instanceof OpenAI.APIError ? err.status : undefined;
    const message = err?.message || String(err);
    return classifyError('openai', status, message);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.apiKey) {
      return { ok: false, provider: 'openai', model: this.defaultModel, error: 'OPENAI_API_KEY not set', checkedAt };
    }
    try {
      await this.client.chat.completions.create({
        model: this.defaultModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
      });
      return { ok: true, provider: 'openai', model: this.defaultModel, checkedAt };
    } catch (err: any) {
      return { ok: false, provider: 'openai', model: this.defaultModel, error: this.toProviderError(err).message, checkedAt };
    }
  }

  private async callChat(opts: GenerateTextOptions, jsonMode: boolean) {
    const modelId = this.modelId(opts);
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: modelId,
          messages: [
            ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
            { role: 'user' as const, content: opts.prompt },
          ],
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 2048,
          ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        },
        { signal: opts.signal },
      );
      const content = completion.choices?.[0]?.message?.content ?? '';
      const usage = completion.usage
        ? {
            prompt_tokens: completion.usage.prompt_tokens,
            completion_tokens: completion.usage.completion_tokens,
            total_tokens: completion.usage.total_tokens,
          }
        : undefined;
      return { content, usage, modelId };
    } catch (err: any) {
      throw this.toProviderError(err);
    }
  }

  private toUsageObj(modelId: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUsd: estimateCost(modelId, {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      }),
    };
  }

  async *generateTextStream(opts: GenerateTextOptions): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.modelId(opts),
        messages: [
          ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
          { role: 'user' as const, content: opts.prompt },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 2048,
        stream: true,
      },
      { signal: opts.signal },
    );
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>> {
    const start = Date.now();
    const { content, usage, modelId } = await this.callChat(opts, false);
    return {
      object: content,
      text: content,
      usage: this.toUsageObj(modelId, usage),
      model: modelId,
      provider: 'openai',
      latencyMs: Date.now() - start,
    };
  }

  async generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>> {
    const start = Date.now();
    const schemaZ = opts.schema as z.ZodTypeAny;
    const jsonHint = `${opts.system ? `${opts.system}\n\n` : ''}Return ONLY a JSON object that matches this schema: ${JSON.stringify(schemaZ._def ?? schemaZ)}\nDo not add commentary or markdown.`;
    const { content, usage, modelId } = await this.callChat({ ...opts, system: jsonHint }, true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw classifyError('openai', 200, 'Model did not return valid JSON');
      parsed = JSON.parse(match[0]);
    }
    const validated = schemaZ.parse(parsed);
    return {
      object: validated as T,
      text: content,
      usage: this.toUsageObj(modelId, usage),
      model: modelId,
      provider: 'openai',
      latencyMs: Date.now() - start,
    };
  }
}
