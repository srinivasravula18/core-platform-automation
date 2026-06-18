/**
 * Anthropic provider — official `@anthropic-ai/sdk` (Messages API).
 *
 * The model is selected by the user in Settings and passed through per call.
 * The Messages API has no strict JSON mode, so generateObject instructs the
 * model to return ONLY JSON and then validates against the Zod schema.
 *
 * Note: Opus 4.7 / 4.8 reject `temperature` (400), so it is omitted for those
 * models; older models still receive it.
 */

import Anthropic from '@anthropic-ai/sdk';
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
import { ProviderError, classifyError, DEFAULT_MODELS, estimateCost, maxOutputFor } from './types';
// Shared, NON-FABRICATING structured-output helpers (one copy for every provider).
import {
  coerceToSchemaShape, repairValidationError, normalizeTestCasePayload, normalizeScriptPayload,
} from './structuredOutput';

/** Opus 4.7+ remove sampling params; sending `temperature` returns a 400. */
function acceptsTemperature(model: string): boolean {
  return !/opus-4-(?:[7-9]|1\d)/i.test(model);
}

function resolveRequiredMaxTokens(model: string, requested?: number): number {
  if (typeof requested === 'number' && requested > 0) return requested;
  // Anthropic's Messages API REQUIRES max_tokens (unlike Gemini/OpenAI, which fall back to the
  // model default when omitted). So derive the ceiling from the SELECTED model's real max-output
  // capability (maxOutputFor) instead of a fixed 8192/4096 that silently truncated long agent
  // outputs (scripts, large case sets). The user monitors actual spend via the cost tracker, so
  // a model-defined ceiling is the right default — the model only ever emits what it needs.
  return maxOutputFor(model);
}

/** Map a provider-agnostic ChatMessage to an Anthropic Messages param. */
function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.toolCallId || '', content: m.content || '' }],
    };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const tc of m.toolCalls) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
    }
    return { role: 'assistant', content: blocks };
  }
  // system is carried out-of-band via params.system; fold any stray one into user text.
  return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' };
}

export class AnthropicProvider implements AIProvider {
  readonly name: ProviderName = 'anthropic';
  private client: Anthropic;
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel?: string) {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel || DEFAULT_MODELS.anthropic.default;
    this.client = new Anthropic({ apiKey });
  }

  private modelId(opts: { model?: string }) {
    return opts.model || this.defaultModel;
  }

  private toProviderError(err: any): ProviderError {
    if (err instanceof ProviderError) return err;
    const status = err instanceof Anthropic.APIError ? err.status : undefined;
    const message = err?.message || String(err);
    return classifyError('anthropic', status, message);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.apiKey) {
      return { ok: false, provider: 'anthropic', model: this.defaultModel, error: 'ANTHROPIC_API_KEY not set', checkedAt };
    }
    try {
      await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true, provider: 'anthropic', model: this.defaultModel, checkedAt };
    } catch (err: any) {
      return { ok: false, provider: 'anthropic', model: this.defaultModel, error: this.toProviderError(err).message, checkedAt };
    }
  }

  private async callMessages(opts: GenerateTextOptions, jsonMode: boolean) {
    const modelId = this.modelId(opts);
    const systemParts: string[] = [];
    if (opts.system) systemParts.push(opts.system);
    if (jsonMode) {
      systemParts.push(
        'Return ONLY a single JSON object. No markdown, no code fences, no commentary before or after. The JSON must match the schema you have been given.',
      );
    }
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: modelId,
      max_tokens: resolveRequiredMaxTokens(modelId, opts.maxTokens),
      messages: [{ role: 'user', content: opts.prompt }],
    };
    if (systemParts.length > 0) params.system = systemParts.join('\n\n');
    if (acceptsTemperature(modelId)) params.temperature = opts.temperature ?? 0.2;

    try {
      const message = await this.client.messages.create(params, { signal: opts.signal });
      const text = (message.content || [])
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const usage = message.usage
        ? { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens }
        : undefined;
      return { content: text, usage, modelId };
    } catch (err: any) {
      throw this.toProviderError(err);
    }
  }

  /** Native tool-calling round-trip via Anthropic tool_use / tool_result blocks. */
  async chatWithTools(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
    const start = Date.now();
    const modelId = this.modelId(opts);
    const messages: Anthropic.MessageParam[] = opts.messages.map((m) => toAnthropicMessage(m));
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: modelId,
      max_tokens: resolveRequiredMaxTokens(modelId, opts.maxTokens),
      messages,
    };
    if (opts.system) params.system = opts.system;
    if (opts.tools?.length) {
      params.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      }));
    }
    if (acceptsTemperature(modelId)) params.temperature = opts.temperature ?? 0.2;

    try {
      const message = await this.client.messages.create(params, { signal: opts.signal });
      const text = (message.content || [])
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls: ToolCallRequest[] = (message.content || [])
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: (b.input as Record<string, unknown>) || {} }));
      const stopReason: ChatWithToolsResult['stopReason'] =
        message.stop_reason === 'tool_use' ? 'tool_calls'
          : message.stop_reason === 'max_tokens' ? 'length'
            : message.stop_reason === 'end_turn' ? 'stop' : 'other';
      return {
        text: text || undefined,
        toolCalls,
        usage: this.toUsageObj(modelId, message.usage ? { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens } : undefined),
        model: modelId,
        provider: 'anthropic',
        stopReason,
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      throw this.toProviderError(err);
    }
  }

  private toUsageObj(modelId: string, usage?: { input_tokens: number; output_tokens: number }) {
    if (!usage) return undefined;
    const totalTokens = usage.input_tokens + usage.output_tokens;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens,
      costUsd: estimateCost(modelId, { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens }),
    };
  }

  async *generateTextStream(opts: GenerateTextOptions): AsyncIterable<string> {
    const modelId = this.modelId(opts);
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: modelId,
      max_tokens: resolveRequiredMaxTokens(modelId, opts.maxTokens),
      messages: [{ role: 'user', content: opts.prompt }],
      stream: true,
    };
    if (opts.system) params.system = opts.system;
    if (acceptsTemperature(modelId)) params.temperature = opts.temperature ?? 0.2;
    const stream = this.client.messages.stream(params, { signal: opts.signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  async generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>> {
    const start = Date.now();
    const { content, usage, modelId } = await this.callMessages(opts, false);
    return {
      object: content,
      text: content,
      usage: this.toUsageObj(modelId, usage),
      model: modelId,
      provider: 'anthropic',
      latencyMs: Date.now() - start,
    };
  }

  async generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>> {
    const start = Date.now();
    const schemaZ = opts.schema as z.ZodTypeAny;
    const jsonHint = `${opts.system ? `${opts.system}\n\n` : ''}Return ONLY a single JSON object matching this schema: ${JSON.stringify(schemaZ._def ?? schemaZ)}`;
    const { content, usage, modelId } = await this.callMessages({ ...opts, system: jsonHint }, true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw classifyError('anthropic', 200, 'Model did not return valid JSON');
      parsed = JSON.parse(match[0]);
    }
    parsed = normalizeScriptPayload(normalizeTestCasePayload(coerceToSchemaShape(parsed, schemaZ)));
    let validated: unknown;
    try {
      validated = schemaZ.parse(parsed);
    } catch (validationError: any) {
      try {
        validated = schemaZ.parse(repairValidationError(parsed, validationError));
      } catch (stillInvalid: any) {
        // Never let a raw Zod issues array escape as the model's "answer".
        const issues: any[] = Array.isArray(stillInvalid?.issues) ? stillInvalid.issues : [];
        const fields = issues.slice(0, 4).map((i) => (Array.isArray(i?.path) ? i.path.join('.') : '?')).filter(Boolean).join(', ');
        throw classifyError('anthropic', 200, `Model response did not match the expected schema${fields ? ` (fields: ${fields})` : ''}.`);
      }
    }
    return {
      object: validated as T,
      text: content,
      usage: this.toUsageObj(modelId, usage),
      model: modelId,
      provider: 'anthropic',
      latencyMs: Date.now() - start,
    };
  }
}
