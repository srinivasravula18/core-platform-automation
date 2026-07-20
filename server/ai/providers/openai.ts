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
import type { ProviderImage } from './types';
import { ProviderError, classifyError, DEFAULT_MODELS, estimateCost, maxOutputFor, sanitizeProviderImages } from './types';
// Shared, NON-FABRICATING structured-output helpers (one copy for every provider).
import {
  coerceToSchemaShape, repairValidationError, normalizeTestCasePayload, normalizeScriptPayload,
  extractBalancedJson, structuredTruncationError,
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

/** Convert neutral history into stateless Responses API input. Native output items
 * are replayed verbatim so reasoning and function-call correlation survive a tool turn. */
function toResponseInput(messages: ChatMessage[]): OpenAI.Responses.ResponseInputItem[] {
  const input: OpenAI.Responses.ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant' && message.providerItems?.length) {
      input.push(...message.providerItems as OpenAI.Responses.ResponseInputItem[]);
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId || '', output: message.content || '' });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      input.push(...message.toolCalls.map((call) => ({
        type: 'function_call' as const,
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments || {}),
      })));
      continue;
    }
    input.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content || '' });
  }
  return input;
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

  /** Emergency rollback for OpenAI-compatible endpoints that have not implemented Responses. */
  private useResponsesApi() {
    return process.env.OPENAI_RESPONSES_API !== 'false';
  }

  private responseParams(modelId: string, maxTokens?: number, effort?: 'low' | 'medium' | 'high') {
    return {
      ...(typeof maxTokens === 'number' && maxTokens > 0 ? { max_output_tokens: maxTokens } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
    };
  }

  /**
   * Build per-model sampling params. Newer OpenAI models (gpt-5 family, o-series
   * reasoning models) reject the legacy `max_tokens` (require `max_completion_tokens`)
   * and only allow the default temperature — sending either errors with a 400. Older
   * chat models (gpt-4o, gpt-4, gpt-3.5) accept `max_completion_tokens` too. Default the output cap to
   * the model's FULL max output (maxOutputFor) so agents use the model's exact budget — consistent with
   * Anthropic/Gemini — instead of the provider's lower implicit default.
   */
  private sampling(modelId: string, maxTokens?: number, temperature?: number): Record<string, any> {
    const m = (modelId || '').toLowerCase();
    const newStyle = /^(gpt-5|o1|o3|o4)/.test(m);
    const params: Record<string, any> = {};
    params.max_completion_tokens = (typeof maxTokens === 'number' && maxTokens > 0) ? maxTokens : maxOutputFor(modelId);
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
      if (this.useResponsesApi()) {
        await this.client.responses.create({
          model: this.defaultModel,
          input: 'ping',
          max_output_tokens: 16,
          store: false,
        });
        return { ok: true, provider: this.name, model: this.defaultModel, checkedAt };
      }
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

  private async callChat(opts: GenerateTextOptions & { images?: ProviderImage[] }, jsonMode: boolean) {
    // OpenAI rejects json_object requests with 400 unless the word "json" appears somewhere in the
    // prompt; guarantee it so no caller has to remember (e.g. caseReworker's prompt lacked it).
    if (jsonMode && !/json/i.test(`${opts.system || ''} ${opts.prompt || ''}`)) {
      opts = { ...opts, system: `${opts.system ? `${opts.system}\n\n` : ''}Respond with a single valid JSON object.` };
    }
    const modelId = this.modelId(opts);
    const images = sanitizeProviderImages(opts.images);
    try {
      if (this.useResponsesApi()) {
        // With images, the Responses input becomes one user turn of input_image + input_text parts.
        const input = images.length
          ? [{
              role: 'user' as const,
              content: [
                ...images.map((img) => ({ type: 'input_image' as const, image_url: `data:${img.mimeType};base64,${img.dataBase64}`, detail: 'auto' as const })),
                { type: 'input_text' as const, text: opts.prompt },
              ],
            }]
          : opts.prompt;
        const response = await this.client.responses.create({
          model: modelId,
          instructions: opts.system,
          input,
          store: false,
          include: ['reasoning.encrypted_content'],
          ...this.responseParams(modelId, opts.maxTokens, opts.effort),
          ...(jsonMode ? { text: { format: { type: 'json_object' as const } } } : {}),
        }, { signal: opts.signal });
        // Surface output-length truncation so generateObject can refuse to parse a partial payload.
        const finishReason = response.incomplete_details?.reason === 'max_output_tokens' ? 'length' as const : 'stop' as const;
        return { content: response.output_text || '', usage: response.usage, modelId, finishReason };
      }
      const completion = await this.client.chat.completions.create(
        {
          model: modelId,
          messages: [
            ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
            {
              role: 'user' as const,
              // With images, chat-completions user content becomes image_url + text parts.
              content: images.length
                ? [
                    ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } })),
                    { type: 'text' as const, text: opts.prompt },
                  ]
                : opts.prompt,
            },
          ],
          ...this.sampling(modelId, opts.maxTokens, opts.temperature),
          ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
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
      const finishReason = completion.choices?.[0]?.finish_reason === 'length' ? 'length' as const : 'stop' as const;
      return { content, usage, modelId, finishReason };
    } catch (err: any) {
      throw this.toProviderError(err);
    }
  }

  /** Native tool-calling round-trip via OpenAI tools / tool_calls. */
  async chatWithTools(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
    if (this.useResponsesApi()) return this.chatWithResponses(opts);
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
    // `reasoning_effort` is unsupported alongside FUNCTION TOOLS on /v1/chat/completions: reasoning models
    // reject it outright ("Function tools with reasoningeffort are not supported for <model> ... use
    // /v1/responses or set reasoningeffort to 'none'") and non-reasoning models don't accept the param at
    // all — so it must NEVER ride along with tools here, for ANY model. Model-name sniffing was fragile
    // (missed new families like gpt-5.6-terra/luna and routed/prefixed ids); reasoning still happens by
    // default. The non-tool paths (generateObject/generateText/stream) keep the effort hint.
    const includeEffort = Boolean(opts.effort) && !tools;
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: modelId,
          messages,
          ...(tools ? { tools, tool_choice: 'auto' as const } : {}),
          ...this.sampling(modelId, opts.maxTokens, opts.temperature),
          ...(includeEffort ? { reasoning_effort: opts.effort } : {}),
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

  private async chatWithResponses(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    const tools: OpenAI.Responses.FunctionTool[] | undefined = opts.tools?.length
      ? opts.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        }))
      : undefined;
    try {
      const response = await this.client.responses.create({
        model: modelId,
        instructions: opts.system,
        input: toResponseInput(opts.messages),
        ...(tools ? { tools, tool_choice: 'auto' as const } : {}),
        ...this.responseParams(modelId, opts.maxTokens, opts.effort),
        store: false,
        include: ['reasoning.encrypted_content'],
      }, { signal: opts.signal });
      const toolCalls: ToolCallRequest[] = response.output
        .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call')
        .map((item) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(item.arguments || '{}'); } catch { args = {}; }
          return { id: item.call_id, name: item.name, arguments: args };
        });
      const incompleteReason = response.incomplete_details?.reason;
      const stopReason: ChatWithToolsResult['stopReason'] = toolCalls.length
        ? 'tool_calls'
        : incompleteReason === 'max_output_tokens' ? 'length'
          : response.status === 'completed' ? 'stop' : 'other';
      return {
        text: response.output_text || undefined,
        toolCalls,
        providerItems: response.output,
        usage: this.toUsageObj(modelId, response.usage),
        model: modelId,
        provider: this.name,
        stopReason,
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      throw this.toProviderError(err);
    }
  }

  private toUsageObj(modelId: string, usage?: any) {
    if (!usage) return undefined;
    // OpenAI's `prompt_tokens` INCLUDES cached tokens; the cached portion is billed at the cheaper
    // cached-input rate, so split it out and bill only the remainder at the base input rate. OpenAI
    // auto-caches — there is no separate cache-WRITE charge.
    const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
    const inputTokens = Math.max(0, promptTokens - cacheReadTokens);
    const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? inputTokens + outputTokens + cacheReadTokens;
    const usageObj = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, totalTokens };
    return { ...usageObj, costUsd: estimateCost(modelId, usageObj) };
  }

  async *generateTextStream(opts: GenerateTextOptions): AsyncIterable<string> {
    if (this.useResponsesApi()) {
      const stream = await this.client.responses.create({
        model: this.modelId(opts),
        instructions: opts.system,
        input: opts.prompt,
        ...this.responseParams(this.modelId(opts), opts.maxTokens, opts.effort),
        store: false,
        include: ['reasoning.encrypted_content'],
        stream: true,
      }, { signal: opts.signal });
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta' && event.delta) yield event.delta;
      }
      return;
    }
    const stream = await this.client.chat.completions.create(
      {
        model: this.modelId(opts),
        messages: [
          ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
          { role: 'user' as const, content: opts.prompt },
        ],
        ...this.sampling(this.modelId(opts), opts.maxTokens, opts.temperature),
        ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
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
    const { content, usage, modelId, finishReason } = await this.callChat({ ...opts, system: jsonHint }, true);
    const outputTokens = (usage as any)?.completion_tokens ?? (usage as any)?.output_tokens;
    // Length-truncated JSON must FAIL (classified, retried by the orchestrator) — never be salvaged short.
    if (finishReason === 'length') throw structuredTruncationError(this.name, modelId, outputTokens);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Some models wrap JSON in prose/markdown — extract the first COMPLETE object or array.
      const { json, unterminated } = extractBalancedJson(content);
      if (unterminated) throw structuredTruncationError(this.name, modelId, outputTokens);
      if (!json) throw classifyError(this.name, 200, 'Model did not return valid JSON');
      parsed = JSON.parse(json);
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
