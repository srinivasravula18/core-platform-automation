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
  ChatWithToolsOptions,
  ChatWithToolsResult,
  ToolCallRequest,
  ChatMessage,
} from './types';
import { ProviderError, classifyError, DEFAULT_MODELS, estimateCost } from './types';
// Shared, NON-FABRICATING structured-output helpers (one copy for every provider).
import {
  coerceToSchemaShape, repairValidationError, normalizeTestCasePayload, normalizeScriptPayload,
} from './structuredOutput';

/** Map a provider-agnostic ChatMessage to an OpenAI chat message param. */
function toOpenAIMessage(m: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId || '', content: m.content || '' };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
      })),
    };
  }
  if (m.role === 'assistant') return { role: 'assistant', content: m.content || '' };
  if (m.role === 'system') return { role: 'system', content: m.content || '' };
  return { role: 'user', content: m.content || '' };
}

export class OpenAIProvider implements AIProvider {
  readonly name: ProviderName;
  private client: OpenAI;
  private apiKey: string;
  private defaultModel: string;

  // `options.baseURL` + `options.name` keep this client flexible for compatible
  // endpoints, but only OpenAI is registered as a service provider.
  constructor(apiKey: string, defaultModel?: string, options?: { baseURL?: string; name?: ProviderName }) {
    this.name = options?.name || 'openai';
    this.apiKey = apiKey;
    this.defaultModel = defaultModel || DEFAULT_MODELS[this.name].default;
    // maxRetries: the SDK retries 429/5xx with exponential backoff.
    this.client = new OpenAI({ apiKey, baseURL: options?.baseURL, maxRetries: 8 });
  }

  private modelId(opts: { model?: string }) {
    return opts.model || this.defaultModel;
  }

  /**
   * Build per-model sampling params. Newer OpenAI models (gpt-5 family, o-series
   * reasoning models) reject the legacy `max_tokens` (require `max_completion_tokens`)
   * and only allow the default temperature — sending either errors with a 400. Older
   * chat models (gpt-4o, gpt-4, gpt-3.5) accept `max_completion_tokens` too. Only send
   * an output cap when the caller explicitly supplied one; otherwise let the selected
   * model/provider default apply.
   */
  private sampling(modelId: string, maxTokens?: number, temperature?: number): Record<string, any> {
    const m = (modelId || '').toLowerCase();
    const newStyle = /^(gpt-5|o1|o3|o4)/.test(m);
    const params: Record<string, any> = {};
    if (typeof maxTokens === 'number' && maxTokens > 0) params.max_completion_tokens = maxTokens;
    if (!newStyle) params.temperature = temperature ?? 0.2;
    return params;
  }

  private toProviderError(err: any): ProviderError {
    if (err instanceof ProviderError) return err;
    const status = err instanceof OpenAI.APIError ? err.status : undefined;
    const message = err?.message || String(err);
    return classifyError(this.name, status, message);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.apiKey) {
      return { ok: false, provider: this.name, model: this.defaultModel, error: `${this.name} API key not set`, checkedAt };
    }
    try {
      await this.client.chat.completions.create({
        model: this.defaultModel,
        messages: [{ role: 'user', content: 'ping' }],
        ...this.sampling(this.defaultModel, 16),
      });
      return { ok: true, provider: this.name, model: this.defaultModel, checkedAt };
    } catch (err: any) {
      return { ok: false, provider: this.name, model: this.defaultModel, error: this.toProviderError(err).message, checkedAt };
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
          ...this.sampling(modelId, opts.maxTokens, opts.temperature),
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

  /** Native tool-calling round-trip via OpenAI tools / tool_calls. */
  async chatWithTools(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    for (const m of opts.messages) messages.push(toOpenAIMessage(m));
    const tools = opts.tools?.length
      ? opts.tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined;
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: modelId,
          messages,
          ...(tools ? { tools, tool_choice: 'auto' as const } : {}),
          ...this.sampling(modelId, opts.maxTokens, opts.temperature),
        },
        { signal: opts.signal },
      );
      const choice = completion.choices?.[0];
      const msg = choice?.message;
      const toolCalls: ToolCallRequest[] = (msg?.tool_calls || [])
        .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageToolCall & { type: 'function' } => (tc as any).type === 'function')
        .map((tc) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse((tc as any).function.arguments || '{}'); } catch { args = {}; }
          return { id: tc.id, name: (tc as any).function.name, arguments: args };
        });
      const stopReason: ChatWithToolsResult['stopReason'] =
        choice?.finish_reason === 'tool_calls' ? 'tool_calls'
          : choice?.finish_reason === 'length' ? 'length'
            : choice?.finish_reason === 'stop' ? 'stop' : 'other';
      const u = completion.usage;
      return {
        text: msg?.content || undefined,
        toolCalls,
        usage: this.toUsageObj(modelId, u ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens } : undefined),
        model: modelId,
        provider: this.name,
        stopReason,
        latencyMs: Date.now() - start,
      };
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
        ...this.sampling(this.modelId(opts), opts.maxTokens, opts.temperature),
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
      provider: this.name,
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
      // Some models wrap JSON in prose/markdown — extract the first object or array.
      const match = content.match(/\{[\s\S]*\}/) || content.match(/\[[\s\S]*\]/);
      if (!match) throw classifyError(this.name, 200, 'Model did not return valid JSON');
      parsed = JSON.parse(match[0]);
    }
    // Coerce common model shape mistakes (e.g. returning a bare [...] instead of
    // { scripts: [...] }, or putting the array under a differently-named key) so a
    // schema-valid response isn't rejected over a wrapper-key difference.
    parsed = normalizeScriptPayload(normalizeTestCasePayload(coerceToSchemaShape(parsed, schemaZ)));
    let validated: unknown;
    try {
      validated = schemaZ.parse(parsed);
    } catch (validationError: any) {
      try {
        validated = schemaZ.parse(repairValidationError(parsed, validationError));
      } catch (stillInvalid: any) {
        // Never let a raw Zod issues array escape as the model's "answer". Summarize the
        // offending fields into a clean, classified provider error the caller can handle.
        const issues: any[] = Array.isArray(stillInvalid?.issues) ? stillInvalid.issues : [];
        const fields = issues.slice(0, 4).map((i) => (Array.isArray(i?.path) ? i.path.join('.') : '?')).filter(Boolean).join(', ');
        throw classifyError(this.name, 200, `Model response did not match the expected schema${fields ? ` (fields: ${fields})` : ''}.`);
      }
    }
    return {
      object: validated as T,
      text: content,
      usage: this.toUsageObj(modelId, usage),
      model: modelId,
      provider: this.name,
      latencyMs: Date.now() - start,
    };
  }
}
