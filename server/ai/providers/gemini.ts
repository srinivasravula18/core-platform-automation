/**
 * Gemini provider — wraps the existing `ai` SDK call.
 *
 * Keeps backward compatibility with the previous `createGeminiModel()` helper
 * while exposing the new unified Provider interface.
 */

import { generateObject, generateText as aiGenerateText, streamText as aiStreamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type {
  AIProvider,
  GenerateObjectOptions,
  GenerateTextOptions,
  ProviderHealth,
  ProviderResponse,
  ProviderName,
  ChatWithToolsOptions,
  ChatWithToolsResult,
  ToolCallRequest,
  ChatMessage,
} from './types';
import { classifyError, DEFAULT_MODELS, estimateCost, maxOutputFor, ProviderError, sanitizeProviderImages } from './types';
// Shared truncation guard (same classified error as the other providers).
import { structuredTruncationError } from './structuredOutput';

/** Build a ProviderUsage (with cost) from the Vercel AI SDK usage shape, splitting cached input out. */
function geminiSdkUsage(modelId: string, usage: any) {
  const cacheReadTokens = usage.cachedInputTokens ?? 0;
  const inputTokens = Math.max(0, (usage.promptTokens ?? 0) - cacheReadTokens);
  const outputTokens = usage.completionTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens + cacheReadTokens;
  const u = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, totalTokens };
  return { ...u, costUsd: estimateCost(modelId, u) };
}

/** Map a provider-agnostic ChatMessage to a @google/genai Content entry. */
function toGeminiContent(m: ChatMessage): { role: string; parts: any[] } {
  if (m.role === 'tool') {
    // Gemini requires functionResponse.response to be a JSON OBJECT (not an array or
    // primitive). Wrap anything that isn't a plain object under { output }.
    let response: Record<string, unknown>;
    try {
      const parsed = JSON.parse(m.content || '{}');
      response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { output: parsed };
    } catch {
      response = { output: m.content || '' };
    }
    return { role: 'user', parts: [{ functionResponse: { id: m.toolCallId, name: m.toolName, response } }] };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const parts: any[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const tc of m.toolCalls) parts.push({ functionCall: { id: tc.id, name: tc.name, args: tc.arguments } });
    return { role: 'model', parts };
  }
  if (m.role === 'assistant') return { role: 'model', parts: [{ text: m.content || '' }] };
  // system folded into user text (system is normally carried via config.systemInstruction).
  return { role: 'user', parts: [{ text: m.content || '' }] };
}

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

  /** Native tool-calling round-trip via @google/genai functionCall / functionResponse.
   * Uses the native SDK (NOT the `ai` SDK) per the agent-architecture decision. */
  async chatWithTools(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    const contents = opts.messages.map((m) => toGeminiContent(m));
    const config: Record<string, any> = {};
    if (opts.system) config.systemInstruction = opts.system;
    if (typeof opts.temperature === 'number') config.temperature = opts.temperature;
    // Use the model's FULL output budget by default (like Anthropic) so Gemini's own lower default never truncates.
    config.maxOutputTokens = opts.maxTokens ?? maxOutputFor(modelId);
    if (opts.tools?.length) {
      config.tools = [{
        functionDeclarations: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          // Pass JSON Schema directly — avoids the Type-enum conversion.
          parametersJsonSchema: t.parameters,
        })),
      }];
    }
    try {
      const resp = await ai.models.generateContent({ model: modelId, contents: contents as any, config });
      const calls = resp.functionCalls || [];
      const toolCalls: ToolCallRequest[] = calls.map((c, i) => ({
        id: c.id || `${c.name || 'call'}_${i}`,
        name: c.name || '',
        arguments: (c.args as Record<string, unknown>) || {},
      }));
      const u: any = resp.usageMetadata || {};
      // Gemini's promptTokenCount INCLUDES cached content; split it out so it bills at the cache-read rate.
      const cacheReadTokens = u.cachedContentTokenCount ?? 0;
      const inputTokens = Math.max(0, (u.promptTokenCount ?? 0) - cacheReadTokens);
      const outputTokens = u.candidatesTokenCount ?? 0;
      const totalTokens = u.totalTokenCount ?? (inputTokens + outputTokens + cacheReadTokens);
      let text: string | undefined;
      try { text = resp.text || undefined; } catch { text = undefined; }
      const usageObj = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, totalTokens };
      return {
        text: toolCalls.length ? undefined : text,
        toolCalls,
        usage: { ...usageObj, costUsd: estimateCost(modelId, usageObj) },
        model: modelId,
        provider: 'gemini',
        stopReason: toolCalls.length ? 'tool_calls' : 'stop',
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      throw classifyError('gemini', err?.status, err?.message || String(err));
    }
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
      const images = sanitizeProviderImages(opts.images);
      // With images, send one user message of image + text parts — the ai SDK serializes each image part to a Gemini inlineData({ mimeType, data }) part on the wire.
      const promptOrMessages = images.length
        ? {
            messages: [{
              role: 'user' as const,
              content: [
                ...images.map((img) => ({ type: 'image' as const, image: img.dataBase64, mediaType: img.mimeType })),
                { type: 'text' as const, text: opts.prompt },
              ],
            }],
          }
        : { prompt: opts.prompt };
      const { object, usage, finishReason } = await generateObject({
        model: client(modelId),
        system: opts.system,
        ...promptOrMessages,
        schema: schemaZ,
        temperature: opts.temperature,
        maxOutputTokens: opts.maxTokens ?? maxOutputFor(modelId),
        abortSignal: opts.signal,
      } as any);
      // Length-truncated JSON must FAIL (classified, retried by the orchestrator) — never be salvaged short.
      if (finishReason === 'length') throw structuredTruncationError('gemini', modelId, (usage as any)?.completionTokens ?? (usage as any)?.outputTokens);
      const text = JSON.stringify(object);
      const usageObj = usage ? geminiSdkUsage(modelId, usage as any) : undefined;
      return {
        object: object as T,
        text,
        usage: usageObj,
        model: modelId,
        provider: 'gemini',
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      // The ai SDK throws NoObjectGeneratedError on truncated JSON — it carries the finishReason.
      if (err?.finishReason === 'length' || err?.cause?.finishReason === 'length') {
        throw structuredTruncationError('gemini', modelId, err?.usage?.completionTokens ?? err?.usage?.outputTokens);
      }
      const status = err?.statusCode || err?.status;
      throw classifyError('gemini', status, err?.message || String(err));
    }
  }

  async *generateTextStream(opts: GenerateTextOptions): AsyncIterable<string> {
    const client = this.client();
    const modelId = this.modelId(opts);
    const { textStream } = aiStreamText({
      model: client(modelId),
      system: opts.system,
      prompt: opts.prompt,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxTokens ?? maxOutputFor(modelId),
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
        maxOutputTokens: opts.maxTokens ?? maxOutputFor(modelId),
        abortSignal: opts.signal,
      } as any);
      const usageObj = usage ? geminiSdkUsage(modelId, usage as any) : undefined;
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
