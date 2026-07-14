/**
 * OpenAI Responses API structured-call client — LangGraph migration, Phase 2.
 *
 * Used ONLY when a graph node's resolved provider is OpenAI; Anthropic/Gemini nodes use their
 * existing adapters (server/ai/providers/anthropic.ts / gemini.ts) unchanged. This is one branch
 * of a provider-neutral boundary, not a replacement for server/ai/providers/openai.ts (that class
 * keeps serving the legacy chat/tool-loop path untouched).
 *
 * The graph owns retries (its node retry policy, declared elsewhere) — this module makes exactly
 * one request per call and never loops or sleeps.
 */
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { estimateCost, type ProviderUsage } from '../providers/types';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES } from '../../features/agent/workflow/errors';

export interface CallOpenAIResponsesStructuredOptions<T> {
  apiKey: string;
  model: string;
  schema: z.ZodType<T>;
  /** zodTextFormat requires a name; also doubles as the schema tag in diagnostics. */
  schemaName: string;
  system?: string;
  prompt: string;
  effort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  /** Injected client for tests/fixtures — omit to construct a real one. */
  client?: OpenAI;
}

export interface OpenAIResponsesStructuredResult<T> {
  object: T | null;
  refusal: string | null;
  /** Raw text/parse-error detail for the caller's repair-call prompt when schemaValid is false. */
  rawContent: string | null;
  responseId: string;
  model: string;
  usage: ProviderUsage;
  schemaValid: boolean;
  latencyMs: number;
}

function toUsageObj(model: string, usage?: OpenAI.Responses.ResponseUsage): ProviderUsage {
  if (!usage) return {};
  // Mirrors OpenAIProvider.toUsageObj (providers/openai.ts): input_tokens INCLUDES cached tokens,
  // billed cheaper — split it out; OpenAI auto-caches, so there's no separate cache-write charge.
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  const inputTokens = Math.max(0, (usage.input_tokens ?? 0) - cacheReadTokens);
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens + cacheReadTokens;
  const usageObj = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, totalTokens };
  return { ...usageObj, costUsd: estimateCost(model, usageObj) };
}

export async function callOpenAIResponsesStructured<T>(
  opts: CallOpenAIResponsesStructuredOptions<T>,
): Promise<OpenAIResponsesStructuredResult<T>> {
  const start = Date.now();
  // maxRetries: 0 — the graph's node retry policy is the single retry owner; the SDK must not
  // multiply attempts underneath it (architecture plan, explicit requirement).
  const client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, maxRetries: 0 });

  const base = {
    model: opts.model,
    input: opts.prompt,
    ...(opts.system ? { instructions: opts.system } : {}),
    text: { format: zodTextFormat(opts.schema, opts.schemaName) },
    ...(opts.effort ? { reasoning: { effort: opts.effort } } : {}),
    // Explicit request-storage/privacy policy for the graph path (architecture plan).
    store: false as const,
  };

  try {
    const response = await client.responses.parse(base, { signal: opts.signal });
    const model = response.model || opts.model;
    const usage = toUsageObj(model, response.usage);
    const latencyMs = Date.now() - start;

    const refusalItem = response.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((c): c is OpenAI.Responses.ResponseOutputRefusal => c.type === 'refusal');
    if (refusalItem) {
      return {
        object: null, refusal: refusalItem.refusal, rawContent: null,
        responseId: response.id, model, usage, schemaValid: false, latencyMs,
      };
    }

    if (response.output_parsed === null) {
      return {
        object: null, refusal: null, rawContent: response.output_text || null,
        responseId: response.id, model, usage, schemaValid: false, latencyMs,
      };
    }

    return {
      object: response.output_parsed, refusal: null, rawContent: null,
      responseId: response.id, model, usage, schemaValid: true, latencyMs,
    };
  } catch (err: any) {
    // SDK-level parse/validation failure (not a refusal) — surfaced schema-invalid, symmetric with the
    // refusal branch above: both are inspectable-without-throwing here, throwable via the helpers below.
    return {
      object: null, refusal: null, rawContent: err?.message ? String(err.message) : String(err),
      responseId: '', model: opts.model, usage: {}, schemaValid: false, latencyMs: Date.now() - start,
    };
  }
}

/** Throws a classified MODEL_REFUSAL error when the model declined; no-op otherwise. */
export function throwIfRefused<T>(result: OpenAIResponsesStructuredResult<T>): void {
  if (result.refusal !== null) {
    throw new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.MODEL_REFUSAL, result.refusal, { responseId: result.responseId });
  }
}

/** Throws a classified SCHEMA_INVALID_OUTPUT error when parsing/validation failed; no-op otherwise. */
export function throwIfSchemaInvalid<T>(result: OpenAIResponsesStructuredResult<T>): void {
  if (!result.schemaValid && result.refusal === null) {
    throw new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.SCHEMA_INVALID_OUTPUT,
      'OpenAI Responses output did not match the expected schema.',
      { responseId: result.responseId, rawContent: result.rawContent },
    );
  }
}
