/**
 * Codex provider — the Codex runtime behind the existing AIProvider contract.
 *
 * Keeping the contract means every existing caller (orchestrator, tool loop, graph nodes,
 * settings health checks) works unchanged while the transport underneath becomes a single
 * Codex runtime. Structured output uses Codex's native `outputSchema` rather than
 * "please return JSON" prompting, then the existing Zod/domain validation still decides.
 */

import { z } from 'zod';
import type {
  AIProvider,
  GenerateObjectOptions,
  GenerateTextOptions,
  ProviderHealth,
  ProviderName,
  ProviderResponse,
} from './types';
import { classifyError } from './types';
import {
  coerceToSchemaShape, repairValidationError, normalizeTestCasePayload, normalizeScriptPayload,
  extractBalancedJson, structuredTruncationError,
} from './structuredOutput';
import { CodexRuntime, type CodexEffort, type CodexMcpServer } from '../codex/runtime';

/** JSON Schema Codex accepts: objects closed to extra keys, `required` left as authored. */
export function toCodexOutputSchema(schema: unknown): unknown {
  const json = schema instanceof z.ZodType ? z.toJSONSchema(schema as z.ZodTypeAny, { io: 'output' }) : schema;
  return closeObjects(json);
}

function closeObjects(node: any): any {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [key, value] of Object.entries(node)) out[key] = closeObjects(value);
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

/** Balanced-brace salvage: a truncated payload is REPORTED, never silently shortened. */
function extractJson(text: string, modelId: string, outputTokens?: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const { json, unterminated } = extractBalancedJson(text);
    if (unterminated) throw structuredTruncationError('codex', modelId, outputTokens);
    if (json) return JSON.parse(json);
    throw new Error('Codex did not return valid JSON');
  }
}

export class CodexProvider implements AIProvider {
  readonly name: ProviderName = 'codex';
  /** Read by the orchestrator when it overrides the Settings-selected model. */
  defaultModel: string;
  private runtime: CodexRuntime;
  /** Scoped MCP servers attached to every turn (set by the console session bridge). */
  mcpServers?: Record<string, CodexMcpServer>;

  constructor(apiKey: string, model: string, opts?: { explicitModel?: boolean }) {
    this.defaultModel = model;
    this.runtime = new CodexRuntime({
      apiKey: apiKey || undefined,
      defaultModel: model,
      explicitModel: !!opts?.explicitModel,
    });
  }

  /** The underlying runtime — the orchestrator drives native tool loops and threads through it. */
  get codex(): CodexRuntime {
    return this.runtime;
  }

  private effort(v?: string): CodexEffort | undefined {
    const value = String(v || '').trim();
    return /^[a-z][a-z0-9_-]{0,31}$/i.test(value) ? value : undefined;
  }

  async health(): Promise<ProviderHealth> {
    const h = await this.runtime.health();
    return { ok: h.ok, provider: this.name, model: h.model || this.defaultModel, error: h.error, checkedAt: h.checkedAt };
  }

  async generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>> {
    const start = Date.now();
    try {
      const res = await this.runtime.run({
        system: opts.system,
        prompt: opts.prompt,
        model: opts.model || this.defaultModel,
        effort: this.effort(opts.effort),
        signal: opts.signal,
        mcpServers: this.mcpServers,
      });
      return { object: res.text, text: res.text, usage: res.usage, model: res.model, provider: this.name, latencyMs: Date.now() - start };
    } catch (err: any) {
      throw classifyError(this.name, undefined, err?.message || String(err));
    }
  }

  /** Native token streaming — the runtime emits agent-message deltas as they are produced. */
  async *generateTextStream(opts: GenerateTextOptions): AsyncIterable<string> {
    for await (const event of this.runtime.stream({
      system: opts.system,
      prompt: opts.prompt,
      model: opts.model || this.defaultModel,
      effort: this.effort(opts.effort),
      signal: opts.signal,
      mcpServers: this.mcpServers,
    })) {
      if (event.type === 'text.delta' && event.delta) yield event.delta;
      if (event.type === 'failed') throw classifyError(this.name, undefined, event.message);
    }
  }

  async generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>> {
    const start = Date.now();
    const schemaZ = opts.schema as z.ZodTypeAny;
    let res: Awaited<ReturnType<CodexRuntime['run']>>;
    try {
      res = await this.runtime.run({
        system: opts.system,
        prompt: opts.prompt,
        model: opts.model || this.defaultModel,
        effort: this.effort(opts.effort),
        signal: opts.signal,
        outputSchema: toCodexOutputSchema(schemaZ),
        mcpServers: this.mcpServers,
      });
    } catch (err: any) {
      throw classifyError(this.name, undefined, err?.message || String(err));
    }
    try {
      const parsed = normalizeScriptPayload(normalizeTestCasePayload(
        coerceToSchemaShape(extractJson(res.text, res.model, res.usage.outputTokens), schemaZ),
      ));
      let object: T;
      try {
        object = schemaZ.parse(parsed) as T;
      } catch (validationError: any) {
        object = schemaZ.parse(repairValidationError(parsed, validationError)) as T;
      }
      return { object, text: res.text, usage: res.usage, model: res.model, provider: this.name, latencyMs: Date.now() - start };
    } catch (error: any) {
      const issues: any[] = Array.isArray(error?.issues) ? error.issues : [];
      if (issues.length) {
        const fields = issues.slice(0, 4).map((i) => (Array.isArray(i?.path) ? i.path.join('.') : '?')).filter(Boolean).join(', ');
        throw classifyError(this.name, 200, `Model response did not match the expected schema${fields ? ` (fields: ${fields})` : ''}.`);
      }
      throw classifyError(this.name, 200, error?.message || 'Codex did not return schema-valid JSON');
    }
  }

  /** Stop button support — aborts the live turn registered under `cancelKey`. */
  interrupt(cancelKey: string): boolean {
    return this.runtime.interrupt(cancelKey);
  }
}
