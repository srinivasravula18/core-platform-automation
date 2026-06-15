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

// Reconcile a parsed model response with a Zod object schema that has a single
// array field (e.g. { scripts: [...] }, { cases: [...] }, { test_cases: [...] }).
// Models on OpenAI-compatible endpoints sometimes return a bare array or use a
// different wrapper key; this rewrites those into the expected shape.
function coerceToSchemaShape(parsed: unknown, schema: z.ZodTypeAny): unknown {
  const expectedArrayKeys = ['scripts', 'test_cases', 'flows', 'cases', 'playwright_scripts', 'tests', 'items'];
  const expectedStringKeys = ['name', 'title', 'artifactName', 'artifact_name', 'label'];
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
    const stringKey = keys.find((k) => {
      const childDef = (shape[k] as any)?._def;
      return childDef?.typeName === 'ZodString' || childDef?.type === 'string';
    });
    // Model returned a bare array but an object is expected -> wrap it.
    if (Array.isArray(parsed)) return { [arrayKey]: parsed };
    // Model returned a bare string but an object is expected -> wrap it.
    if (stringKey && typeof parsed === 'string') return { [stringKey]: parsed };
    // Object is missing the expected array key -> fill it from the first array property.
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (obj[arrayKey] === undefined) {
        const namedArrayKey = expectedArrayKeys.find((k) => Array.isArray(obj[k]));
        const arrProp = namedArrayKey ? obj[namedArrayKey] : Object.values(obj).find((v) => Array.isArray(v));
        if (arrProp) obj[arrayKey] = arrProp;
      }
      if (stringKey && obj[stringKey] === undefined) {
        const namedStringKey = expectedStringKeys.find((k) => typeof obj[k] === 'string');
        const strProp = namedStringKey ? obj[namedStringKey] : Object.values(obj).find((v) => typeof v === 'string');
        if (strProp) obj[stringKey] = strProp;
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
    ? error.issues.find((i: any) => Array.isArray(i?.path) && i.path.length === 1 && ['array', 'string'].includes(i.expected))
    : undefined;
  const missingKey = issue?.path?.[0];
  if (!missingKey || typeof missingKey !== 'string') return parsed;
  if (issue.expected === 'array' && Array.isArray(parsed)) return { [missingKey]: parsed };
  if (issue.expected === 'string' && typeof parsed === 'string') return { [missingKey]: parsed };
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const prop = Object.values(obj).find((v) => issue.expected === 'array' ? Array.isArray(v) : typeof v === 'string');
    if (prop) return { ...obj, [missingKey]: prop };
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
    const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
    const normalizedSteps = steps.map((rawStep, stepIndex) => {
      const step: Record<string, unknown> = rawStep && typeof rawStep === 'object' ? (rawStep as Record<string, unknown>) : { action: rawStep };
      const action = stringifyField(step.action || step.step || step.instruction || step.description || `Execute step ${stepIndex + 1}`);
      const expected = stringifyField(step.expected || step.expectedResult || step.expected_result || step.assertion || step.result || step.outcome)
        || 'The expected result for this step is observed.';
      return { action, expected };
    });

    const description = stringifyField(testCase.description || testCase.summary || testCase.objective || testCase.purpose)
      || title;
    return {
      ...testCase,
      title,
      description,
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
   * chat models (gpt-4o, gpt-4, gpt-3.5) accept `max_completion_tokens` too, so we use
   * it everywhere and only attach `temperature` for models that support a custom value.
   */
  private sampling(modelId: string, maxTokens: number, temperature?: number): Record<string, any> {
    const m = (modelId || '').toLowerCase();
    const newStyle = /^(gpt-5|o1|o3|o4)/.test(m);
    const params: Record<string, any> = { max_completion_tokens: maxTokens };
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
          // Generous default so large structured outputs (e.g. full Playwright scripts) aren't truncated.
          ...this.sampling(modelId, opts.maxTokens ?? 8000, opts.temperature),
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
          ...this.sampling(modelId, opts.maxTokens ?? 4096, opts.temperature),
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
        ...this.sampling(this.modelId(opts), opts.maxTokens ?? 2048, opts.temperature),
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
      validated = schemaZ.parse(coerceFromValidationError(parsed, validationError));
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
