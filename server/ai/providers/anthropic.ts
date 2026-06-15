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
import { ProviderError, classifyError, DEFAULT_MODELS, estimateCost } from './types';

/** Opus 4.7+ remove sampling params; sending `temperature` returns a 400. */
function acceptsTemperature(model: string): boolean {
  return !/opus-4-(?:[7-9]|1\d)/i.test(model);
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

function coerceToSchemaShape(parsed: unknown, schema: z.ZodTypeAny): unknown {
  const expectedArrayKeys = ['scripts', 'test_cases', 'flows', 'cases', 'playwright_scripts', 'tests', 'items'];
  try {
    const def: any = (schema as any)?._def;
    const isObjectSchema = def?.typeName === 'ZodObject' || def?.type === 'object';
    if (!isObjectSchema) return parsed;
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
    const keys = Object.keys(shape || {});
    if (!keys.length) return parsed;
    const arrayKey = keys.find((k) => {
      const childDef = (shape[k] as any)?._def;
      return childDef?.typeName === 'ZodArray' || childDef?.type === 'array';
    }) || keys[0];
    if (Array.isArray(parsed)) return { [arrayKey]: parsed };
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (obj[arrayKey] === undefined) {
        const namedArrayKey = expectedArrayKeys.find((k) => Array.isArray(obj[k]));
        const arrProp = namedArrayKey ? obj[namedArrayKey] : Object.values(obj).find((v) => Array.isArray(v));
        if (arrProp) obj[arrayKey] = arrProp;
      }
      return obj;
    }
    return parsed;
  } catch {
    return parsed;
  }
}

function coerceFromValidationError(parsed: unknown, error: any): unknown {
  const issue = Array.isArray(error?.issues)
    ? error.issues.find((i: any) => Array.isArray(i?.path) && i.path.length === 1 && i.expected === 'array')
    : undefined;
  const missingKey = issue?.path?.[0];
  if (!missingKey || typeof missingKey !== 'string') return parsed;
  if (Array.isArray(parsed)) return { [missingKey]: parsed };
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const arrProp = Object.values(obj).find((v) => Array.isArray(v));
    if (arrProp) return { ...obj, [missingKey]: arrProp };
  }
  return parsed;
}

function normalizePriority(value: unknown): 'Low' | 'Medium' | 'High' | 'Critical' {
  const text = String(value || '').toLowerCase();
  if (text.includes('critical')) return 'Critical';
  if (text.includes('high') || text.includes('bvt') || text.includes('smoke')) return 'High';
  if (text.includes('low')) return 'Low';
  return 'Medium';
}

function normalizeCaseType(value: unknown): 'Manual' | 'Automated' | 'Both' {
  const text = String(value || '').toLowerCase();
  if (text.includes('both')) return 'Both';
  if (text.includes('auto') || text.includes('playwright')) return 'Automated';
  return 'Manual';
}

function stringifyField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => stringifyField(item)).filter(Boolean).join('; ');
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map((item) => stringifyField(item)).filter(Boolean).join('; ');
  return value === undefined || value === null ? '' : String(value);
}

function normalizeTestCasePayload(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const root = parsed as Record<string, unknown>;
  const cases = Array.isArray(root.test_cases) ? root.test_cases : Array.isArray(root.cases) ? root.cases : undefined;
  if (!cases) return parsed;

  root.test_cases = cases.map((rawCase, index) => {
    const testCase = rawCase && typeof rawCase === 'object' ? { ...(rawCase as Record<string, unknown>) } : {};
    const title = stringifyField(testCase.title || testCase.name || testCase.scenario || `Test case ${index + 1}`);
    const normalizedSteps = (Array.isArray(testCase.steps) ? testCase.steps : []).map((rawStep, stepIndex) => {
      const step: Record<string, unknown> = rawStep && typeof rawStep === 'object' ? (rawStep as Record<string, unknown>) : { action: rawStep };
      const action = stringifyField(step.action || step.step || step.instruction || step.description || `Execute step ${stepIndex + 1}`);
      const expected = stringifyField(step.expected || step.expectedResult || step.expected_result || step.assertion || step.result || step.outcome)
        || 'The expected result for this step is observed.';
      return { action, expected };
    });

    return {
      ...testCase,
      title,
      description: stringifyField(testCase.description || testCase.summary || testCase.objective || testCase.purpose) || title,
      preconditions: stringifyField(testCase.preconditions || testCase.precondition || testCase.prerequisites) || 'Application is reachable and required test credentials are available.',
      tags: Array.isArray(testCase.tags) ? testCase.tags.map((tag) => stringifyField(tag)).filter(Boolean) : ['@ui', '@positive'],
      priority: normalizePriority(testCase.priority),
      type: normalizeCaseType(testCase.type),
      steps: normalizedSteps.length ? normalizedSteps : [{ action: 'Open the target page.', expected: 'The target page loads successfully.' }],
    };
  });
  return root;
}

function slugifyFilename(value: string, fallback: string): string {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || fallback}.spec.ts`;
}

function normalizeScriptPayload(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const root = parsed as Record<string, unknown>;
  const scripts = Array.isArray(root.scripts) ? root.scripts : Array.isArray(root.playwright_scripts) ? root.playwright_scripts : undefined;
  if (!scripts) return parsed;

  root.scripts = scripts.map((rawScript, index) => {
    const script: Record<string, unknown> = rawScript && typeof rawScript === 'object' ? { ...(rawScript as Record<string, unknown>) } : { code: rawScript };
    const title = stringifyField(script.test_case_title || script.title || script.name || script.testName || script.test_name || `Generated Playwright script ${index + 1}`);
    const code = stringifyField(script.code || script.script || script.source || script.content || script.playwright || script.test || script.body);
    return {
      ...script,
      test_case_title: title,
      filename: stringifyField(script.filename || script.file || script.path) || slugifyFilename(title, `generated-script-${index + 1}`),
      code: code || `import { test, expect } from '@playwright/test';\n\ntest('${title.replace(/'/g, "\\'")}', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.locator('body')).toBeVisible();\n});`,
    };
  });
  return root;
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
      max_tokens: opts.maxTokens ?? 2048,
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
      max_tokens: opts.maxTokens ?? 4096,
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
      max_tokens: opts.maxTokens ?? 2048,
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
      validated = schemaZ.parse(coerceFromValidationError(parsed, validationError));
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
