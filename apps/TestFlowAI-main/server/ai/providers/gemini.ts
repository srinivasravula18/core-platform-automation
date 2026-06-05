/**
 * Gemini provider — wraps the existing `ai` SDK call.
 *
 * Keeps backward compatibility with the previous `createGeminiModel()` helper
 * while exposing the new unified Provider interface.
 */

import { generateObject, generateText as aiGenerateText, streamText as aiStreamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
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

export class GeminiProvider implements AIProvider {
  readonly name: ProviderName = 'gemini';
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel?: string) {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel || DEFAULT_MODELS.gemini.default;
  }

  private client() {
    return createGoogleGenerativeAI({ apiKey: this.apiKey });
  }

  private modelId(opts: { model?: string }) {
    return opts.model || this.defaultModel;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.apiKey) {
      return { ok: false, provider: 'gemini', model: this.defaultModel, error: 'GEMINI_API_KEY not set', checkedAt };
    }
    try {
      const client = this.client();
      await aiGenerateText({
        model: client(this.defaultModel),
        prompt: 'ping',
        maxOutputTokens: 5,
      } as any);
      return { ok: true, provider: 'gemini', model: this.defaultModel, checkedAt };
    } catch (err: any) {
      return {
        ok: false,
        provider: 'gemini',
        model: this.defaultModel,
        error: err?.message || String(err),
        checkedAt,
      };
    }
  }

  async generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    try {
      const client = this.client();
      const schemaZ = opts.schema as z.ZodTypeAny;
      const { object, usage } = await generateObject({
        model: client(modelId),
        system: opts.system,
        prompt: opts.prompt,
        schema: schemaZ,
        temperature: opts.temperature,
        maxOutputTokens: opts.maxTokens,
        abortSignal: opts.signal,
      } as any);
      const text = JSON.stringify(object);
      const usageObj = usage
        ? {
            inputTokens: (usage as any).promptTokens,
            outputTokens: (usage as any).completionTokens,
            totalTokens: (usage as any).totalTokens,
            costUsd: estimateCost(modelId, (usage as any)),
          }
        : undefined;
      return {
        object: object as T,
        text,
        usage: usageObj,
        model: modelId,
        provider: 'gemini',
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      const status = err?.statusCode || err?.status;
      throw classifyError('gemini', status, err?.message || String(err));
    }
  }

  async *generateTextStream(opts: GenerateTextOptions): AsyncIterable<string> {
    const client = this.client();
    const { textStream } = aiStreamText({
      model: client(this.modelId(opts)),
      system: opts.system,
      prompt: opts.prompt,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxTokens,
      abortSignal: opts.signal,
    } as any);
    for await (const delta of textStream) yield delta as string;
  }

  async generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    try {
      const client = this.client();
      const { text, usage } = await aiGenerateText({
        model: client(modelId),
        system: opts.system,
        prompt: opts.prompt,
        temperature: opts.temperature,
        maxOutputTokens: opts.maxTokens,
        abortSignal: opts.signal,
      } as any);
      const usageObj = usage
        ? {
            inputTokens: (usage as any).promptTokens,
            outputTokens: (usage as any).completionTokens,
            totalTokens: (usage as any).totalTokens,
            costUsd: estimateCost(modelId, (usage as any)),
          }
        : undefined;
      return {
        object: text,
        text,
        usage: usageObj,
        model: modelId,
        provider: 'gemini',
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      const status = err?.statusCode || err?.status;
      throw classifyError('gemini', status, err?.message || String(err));
    }
  }
}
