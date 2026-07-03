/**
 * Provider factory and orchestrator.
 *
 * The factory builds a Provider by name from the workspace's stored credentials.
 * The orchestrator wraps the provider with the guardrail pipeline, cost tracking,
 * and the DB-backed prompt store so the rest of the app does not have to repeat
 * that setup.
 *
 * Usage in routes:
 *   const ai = await getOrchestrator(workspaceId, agentName);
 *   const { object, usage, model, latencyMs } = await ai.generateObject({...});
 */

import type { AIProvider, ProviderAuthMode, ProviderName, ChatMessage, ProviderResponse } from './providers/types';
import { DEFAULT_MODELS, listAvailableModels } from './providers/types';
import type { AgentStep, AgentRunResult, RunToolLoopOptions, ToolInvocation } from './tools/types';
import { GeminiProvider } from './providers/gemini';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { AccountCliProvider } from './providers/cli';
import { runGuardrailPipeline, type PipelineInput, type PipelineResult } from './guardrails';
import { getActivePrompt } from './promptStore';
import { recordUsage, getDailyCost } from './costTracker';
import { canonicalAgent } from './systemPrompts';
import { db } from '../shared/storage';

export interface ProviderCredentials {
  apiKey: string;
  model?: string;
  authMode: ProviderAuthMode;
}

const PROVIDERS: ProviderName[] = ['gemini', 'openai', 'anthropic'];

function isProviderName(value: unknown): value is ProviderName {
  return PROVIDERS.includes(value as ProviderName);
}

export function getProviderCredentials(provider: ProviderName): ProviderCredentials | null {
  const settings = db.settings?.providerSettings?.[provider];
  if (settings?.enabled === false) return null;
  if (settings?.authMode === 'account' && isLocalCliProviderAllowed()) {
    return { apiKey: '', model: settings.model, authMode: 'account' };
  }
  if (!settings?.apiKey) {
    if (provider === 'gemini') {
      const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (envKey) return { apiKey: envKey, authMode: 'api_key' };
    }
    if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      return { apiKey: process.env.OPENAI_API_KEY, authMode: 'api_key' };
    }
    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      return { apiKey: process.env.ANTHROPIC_API_KEY, authMode: 'api_key' };
    }
    return null;
  }
  return { apiKey: settings.apiKey, model: settings.model, authMode: settings.authMode || 'api_key' };
}

function isLocalCliProviderAllowed(): boolean {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  const explicit = String(process.env.ALLOW_LOCAL_CLI_PROVIDERS || '').toLowerCase();
  const deploymentMode = String(process.env.DEPLOYMENT_MODE || '').toLowerCase();
  const lifecycle = String(process.env.npm_lifecycle_event || '').toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return (
    !env ||
    env === 'development' ||
    env === 'dev' ||
    deploymentMode === 'local' ||
    lifecycle.startsWith('dev')
  );
}

export function buildProvider(provider: ProviderName, modelOverride?: string): AIProvider {
  const creds = getProviderCredentials(provider);
  if (!creds) {
    throw new Error(
      `No credentials configured for provider "${provider}". Add an API key in Settings → AI Providers.`,
    );
  }
  const model = modelOverride || creds.model || DEFAULT_MODELS[provider].default;
  if (creds.authMode === 'account') {
    if (!isLocalCliProviderAllowed()) {
      throw new Error(
        `Provider "${provider}" is configured for local subscription/account CLI auth, but CLI providers are disabled outside local development. Use API key mode in test and production.`,
      );
    }
    // explicitModel: only forward a model id to the CLI when the user actually chose
    // one in Settings — the CLI's own local config is the default otherwise.
    if (provider === 'openai') return new AccountCliProvider('openai', 'codex', model, { explicitModel: !!(modelOverride || creds.model) });
    if (provider === 'anthropic') return new AccountCliProvider('anthropic', 'claude', model, { explicitModel: !!(modelOverride || creds.model) });
    throw new Error(
      `Provider "${provider}" does not support subscription/account CLI auth in Test Flow AI. Use API key mode for this provider.`,
    );
  }
  switch (provider) {
    case 'gemini':
      return new GeminiProvider(creds.apiKey, model);
    case 'openai':
      return new OpenAIProvider(creds.apiKey, model);
    case 'anthropic':
      return new AnthropicProvider(creds.apiKey, model);
  }
}

export function listConfiguredProviders(): ProviderName[] {
  const out: ProviderName[] = [];
  for (const name of PROVIDERS) {
    if (getProviderCredentials(name)) out.push(name);
  }
  return out;
}

export function resolveProviderForAgent(agent: string): ProviderName {
  const map = db.settings?.agentProviderMap;
  const rawPreferred = map && (map as any)[agent] ? (map as any)[agent] : db.settings?.defaultProvider;
  const preferred = isProviderName(rawPreferred) ? rawPreferred : undefined;
  if (preferred && getProviderCredentials(preferred)) return preferred;
  const configured = listConfiguredProviders();
  if (configured.length > 0) return configured[0];
  return preferred || 'gemini';
}

export function resolveModelForAgent(agent: string, provider: ProviderName): string {
  const validModels = listAvailableModels(provider, { includeLocalOnly: isLocalCliProviderAllowed() });
  // 1) per-agent override (Settings → AI Providers → per-agent model)
  const map = db.settings?.agentModelMap;
  const agentModel = map && (map as any)[agent] ? String((map as any)[agent]) : '';
  if (agentModel && validModels.includes(agentModel)) return agentModel;
  // 2) provider-level model chosen in the Settings panel (providerSettings[provider].model).
  //    Without this, getOrchestrator overwrites the UI-selected model with the hard default,
  //    so toggling the model in Settings never reached the agents.
  const providerModel = db.settings?.providerSettings?.[provider]?.model;
  if (providerModel && validModels.includes(providerModel)) return providerModel;
  // 3) hard default for the provider
  return DEFAULT_MODELS[provider].default;
}

type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Agents whose output quality depends directly on reasoning depth. These run at
 * 'high' effort unless the user explicitly configured an effort for them — the
 * shallow default was a major source of thin, low-coverage generated artifacts
 * (test cases, feature inventories) compared to the same prompt run manually in
 * a full reasoning model. Role-based, app-agnostic.
 */
const HIGH_EFFORT_AGENTS = new Set(['caseWriter', 'featureAnalyst', 'featureDiscoveryAgent', 'e2eFlowAgent', 'testPlanner']);

function isEffort(v: unknown): v is ReasoningEffort {
  return v === 'low' || v === 'medium' || v === 'high';
}

/**
 * Resolve the reasoning effort for an agent:
 *   explicit caller override (the topbar effort selector, carried on the run)
 *   → per-agent settings override → high-effort role floor → provider setting → medium.
 * The caller override is authoritative: when the user picks an effort in the Agent
 * Console topbar, that choice governs every agent in that run.
 */
export function resolveEffortForAgent(agent: string, provider: ProviderName, override?: string): ReasoningEffort {
  if (isEffort(override)) return override;
  const map = (db.settings as any)?.agentEffortMap;
  const perAgent = map && map[agent];
  if (isEffort(perAgent)) return perAgent;
  if (HIGH_EFFORT_AGENTS.has(agent)) return 'high';
  const stored = (db.settings?.providerSettings?.[provider] as any)?.effort;
  if (isEffort(stored)) return stored;
  return 'medium';
}

export class AgentOrchestrator {
  constructor(
    private provider: AIProvider,
    private agent: string,
    private workspaceId: string,
    private userId?: string,
    private effort?: ReasoningEffort,
  ) {}

  private async assembleSystem(pipeline: PipelineResult): Promise<string> {
    const override = await getActivePrompt(this.agent);
    if (override && override.body) {
      return `${override.body}\n\n[Guardrail pipeline: ${pipeline.requestId}]`;
    }
    return pipeline.systemPrompt;
  }

  async generateObject<T>(opts: { prompt: string; schema: unknown; temperature?: number; maxTokens?: number; userMessage?: string; hasHistory?: boolean }) {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
      hasHistory: opts.hasHistory,
    } as PipelineInput);
    if (pipeline.policyVerdict.kind === 'respond') {
      return { shortCircuit: pipeline.policyVerdict.reply, object: undefined, usage: undefined, model: '', latencyMs: 0 };
    }
    if (pipeline.policyVerdict.kind === 'reject') {
      const err: any = new Error(pipeline.policyVerdict.error);
      err.status = pipeline.policyVerdict.code;
      throw err;
    }
    const system = await this.assembleSystem(pipeline);
    // GLOBAL resilience: a provider can occasionally return off-schema JSON (esp. smaller /
    // low-effort models like a Codex mini). Rather than fail the whole agent stage on a
    // one-off bad response, retry the structured-output call once with a firm reminder to
    // emit ONLY valid JSON for the schema. This is a retry — NOT fabrication — so a real,
    // persistent mismatch still surfaces honestly.
    // Retry when the model's output is unusable — EITHER off-schema OR malformed/truncated
    // JSON (a parse error). Both are "the model produced bad structured output"; a fresh
    // attempt usually fixes it. NOT a retry for auth/network (callWithRetry handles those).
    const isBadOutput = (e: any) => /schema|invalid_type|invalid_value|expected .*received|did not match|valid json|received undefined|unexpected token|unexpected end of (json|input)|in json at position|after property value|not valid json|json\.parse/i.test(String(e?.message || ''));
    let result: ProviderResponse<T>;
    try {
      result = await this.provider.generateObject<T>({ system, prompt: opts.prompt, schema: opts.schema, temperature: opts.temperature, maxTokens: opts.maxTokens, effort: this.effort });
    } catch (err: any) {
      if (!isBadOutput(err)) throw err;
      const retrySystem = `${system}\n\nIMPORTANT: Your previous reply was not usable — it was not a single valid JSON object matching the required schema (it was malformed, truncated, or off-schema). Reply with ONLY one complete, valid JSON object that exactly matches the schema — all required fields present, correct types, properly closed braces/brackets, no prose, no markdown, no code fences.`;
      result = await this.provider.generateObject<T>({ system: retrySystem, prompt: opts.prompt, schema: opts.schema, temperature: opts.temperature, maxTokens: opts.maxTokens, effort: this.effort });
    }
    await recordUsage({
      workspaceId: this.workspaceId,
      userId: this.userId,
      agent: this.agent,
      provider: this.provider.name,
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
      requestId: pipeline.requestId,
    });
    return { object: result.object, usage: result.usage, model: result.model, latencyMs: result.latencyMs, provider: this.provider.name };
  }

  async generateText(opts: { prompt: string; temperature?: number; maxTokens?: number; userMessage?: string; hasHistory?: boolean }) {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
      hasHistory: opts.hasHistory,
    } as PipelineInput);
    if (pipeline.policyVerdict.kind === 'respond') {
      return { shortCircuit: pipeline.policyVerdict.reply, text: '', usage: undefined, model: '', latencyMs: 0 };
    }
    if (pipeline.policyVerdict.kind === 'reject') {
      const err: any = new Error(pipeline.policyVerdict.error);
      err.status = pipeline.policyVerdict.code;
      throw err;
    }
    const system = await this.assembleSystem(pipeline);
    const result = await this.provider.generateText({
      system,
      prompt: opts.prompt,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      effort: this.effort,
    });
    await recordUsage({
      workspaceId: this.workspaceId,
      userId: this.userId,
      agent: this.agent,
      provider: this.provider.name,
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
      requestId: pipeline.requestId,
    });
    return { text: result.text, usage: result.usage, model: result.model, latencyMs: result.latencyMs, provider: this.provider.name };
  }

  async *streamText(opts: { prompt: string; temperature?: number; maxTokens?: number; userMessage?: string; hasHistory?: boolean }): AsyncIterable<string> {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
      hasHistory: opts.hasHistory,
    } as PipelineInput);
    if (pipeline.policyVerdict.kind === 'respond') {
      yield pipeline.policyVerdict.reply;
      return;
    }
    if (pipeline.policyVerdict.kind === 'reject') {
      const err: any = new Error(pipeline.policyVerdict.error);
      err.status = pipeline.policyVerdict.code;
      throw err;
    }
    const system = await this.assembleSystem(pipeline);
    if (!this.provider.generateTextStream) {
      // Providers without native streaming (the account/CLI runner) return the whole
      // answer at once. Emit it in small word-grouped chunks so the UI still renders
      // progressively instead of dumping a wall of text. (True low-latency token
      // streaming still requires an API-key/SDK provider.)
      const result = await this.provider.generateText({ system, prompt: opts.prompt, temperature: opts.temperature, maxTokens: opts.maxTokens, effort: this.effort });
      const full = result.text || '';
      const tokens = full.match(/\S+\s*/g) || (full ? [full] : []);
      let buf = '';
      for (let i = 0; i < tokens.length; i += 1) {
        buf += tokens[i];
        // Flush every few words so the client paints incrementally.
        if ((i + 1) % 4 === 0) { yield buf; buf = ''; }
      }
      if (buf) yield buf;
      return;
    }
    for await (const delta of this.provider.generateTextStream({ system, prompt: opts.prompt, temperature: opts.temperature, maxTokens: opts.maxTokens, effort: this.effort })) {
      if (delta) yield delta;
    }
  }

  /**
   * Run a grounded agentic tool loop: the model repeatedly calls tools, observes the
   * results, and continues until it answers, an accept-check passes, or a budget is hit.
   * Uses the provider's NATIVE function-calling (chatWithTools). This is the core of the
   * re-architected agents — no more one-shot prompt→JSON.
   */
  async runToolLoop(opts: RunToolLoopOptions): Promise<AgentRunResult> {
    if (!this.provider.chatWithTools) {
      throw new Error(`Provider "${this.provider.name}" does not support tool calling (no chatWithTools). Pick an API-key provider in Settings.`);
    }
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.task,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
      hasHistory: true, // a tool loop is an ongoing task, never a bare one-liner to short-circuit
    } as PipelineInput);
    if (pipeline.policyVerdict.kind === 'reject') {
      const err: any = new Error(pipeline.policyVerdict.error);
      err.status = pipeline.policyVerdict.code;
      throw err;
    }
    const system = opts.system || (await this.assembleSystem(pipeline));
    const toolSpecs = opts.tools.map((t) => t.spec);
    const toolByName = new Map(opts.tools.map((t) => [t.spec.name, t]));
    const ctx = opts.toolContext || {};
    const maxSteps = opts.maxSteps ?? 12;
    const maxAcceptRetries = opts.maxAcceptRetries ?? 2;

    const messages: ChatMessage[] = [{ role: 'user', content: opts.task }];
    const steps: AgentStep[] = [];
    const toolResults: AgentRunResult['toolResults'] = [];
    const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
    let acceptRetries = 0;
    let finalText = '';
    let stoppedReason: AgentRunResult['stoppedReason'] = 'max_steps';

    for (let i = 0; i < maxSteps; i += 1) {
      if (opts.signal?.aborted) { stoppedReason = 'aborted'; break; }
      if (opts.maxTotalTokens && totalUsage.totalTokens >= opts.maxTotalTokens) { stoppedReason = 'budget'; break; }

      const res = await callWithRetry(() => this.provider.chatWithTools!({
        system,
        messages,
        tools: toolSpecs,
        temperature: opts.temperature,
        maxTokens: opts.maxTokensPerCall,
        effort: this.effort,
        signal: opts.signal,
      }), opts.signal);
      if (res.usage) {
        totalUsage.inputTokens += res.usage.inputTokens ?? 0;
        totalUsage.outputTokens += res.usage.outputTokens ?? 0;
        totalUsage.totalTokens += res.usage.totalTokens ?? 0;
        totalUsage.costUsd += res.usage.costUsd ?? 0;
      }
      await recordUsage({
        workspaceId: this.workspaceId,
        userId: this.userId,
        agent: this.agent,
        provider: this.provider.name,
        model: res.model,
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
        cacheReadTokens: res.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: res.usage?.cacheWriteTokens ?? 0,
        costUsd: res.usage?.costUsd ?? 0,
        requestId: pipeline.requestId,
      });

      const step: AgentStep = { index: i, text: res.text, toolCalls: [], usage: res.usage };

      if (res.toolCalls.length) {
        // Record the assistant's tool-call turn so the provider sees the full exchange.
        messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
        for (const call of res.toolCalls) {
          const inv: ToolInvocation = { id: call.id, name: call.name, arguments: call.arguments };
          const tool = toolByName.get(call.name);
          const t0 = Date.now();
          if (!tool) {
            inv.error = `Unknown tool "${call.name}".`;
          } else {
            try {
              const result = await tool.execute(call.arguments, ctx);
              inv.result = result;
              toolResults.push({ name: call.name, arguments: call.arguments, result });
            } catch (err: any) {
              inv.error = err?.message || String(err);
            }
          }
          inv.ms = Date.now() - t0;
          step.toolCalls.push(inv);
          // Feed the result (or error) back to the model as a tool message.
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: inv.error
              ? `ERROR: ${inv.error}`
              : safeJson(inv.result),
          });
        }
        steps.push(step);
        opts.onStep?.(step);
        continue;
      }

      // No tool calls → the model produced what it considers a final answer.
      finalText = res.text || '';
      messages.push({ role: 'assistant', content: finalText });
      steps.push(step);
      opts.onStep?.(step);

      // HONESTY GATE: an empty/whitespace final answer is NOT a success, and neither is a
      // response the provider flagged as truncated (stopReason === 'length'). Reporting
      // `accepted: true` with no real content is exactly the fake-green failure we are
      // eliminating. Detect these here so they either trigger a Reflexion retry (when an
      // accept() critic exists) or surface an honest not-accepted verdict.
      const isEmptyFinal = finalText.trim().length === 0;
      const isTruncated = res.stopReason === 'length';
      if (isEmptyFinal || isTruncated) {
        const why = isEmptyFinal
          ? 'the model returned an empty final answer'
          : 'the model output was truncated (hit the token limit) before completing';
        if (acceptRetries < maxAcceptRetries) {
          acceptRetries += 1;
          // Give the agent a chance to actually produce a complete answer.
          messages.push({
            role: 'user',
            content: `Your result was not accepted because ${why}. Produce a complete, non-empty final answer.`,
          });
          continue;
        }
        // Out of retries: fail loudly rather than masquerading as a clean final answer.
        stoppedReason = isEmptyFinal ? 'empty_response' : 'truncated';
        return { finalText, steps, accepted: false, stoppedReason, toolResults, totalUsage };
      }

      if (opts.accept) {
        const verdict = await opts.accept({ finalText, steps, ctx });
        if (!verdict.ok && acceptRetries < maxAcceptRetries) {
          acceptRetries += 1;
          // Grounded Reflexion: append the critique and let the agent try again.
          messages.push({
            role: 'user',
            content: `Your result was not accepted. ${verdict.feedback || 'It did not meet the acceptance criteria.'} Diagnose why and try again — do not repeat the same approach.`,
          });
          continue;
        }
        stoppedReason = verdict.ok ? 'accepted' : 'max_steps';
        return { finalText, steps, accepted: verdict.ok, stoppedReason, toolResults, totalUsage };
      }

      stoppedReason = 'final_text';
      return { finalText, steps, accepted: true, stoppedReason, toolResults, totalUsage };
    }

    return { finalText, steps, accepted: false, stoppedReason, toolResults, totalUsage };
  }
}

/** Retry transient provider errors (rate_limit / network / 429 / 5xx) with exponential
 * backoff. Gemini and Anthropic SDKs do not retry on their own, so a single 503 would
 * otherwise abort a whole agent run. Non-transient errors (auth, bad_request) throw
 * immediately. */
async function callWithRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, attempts = 4): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i += 1) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code = err?.code;
      const status = err?.status;
      const retryable = code === 'rate_limit' || code === 'network' || status === 429 || (status >= 500 && status < 600);
      if (!retryable || i === attempts - 1) throw err;
      const delayMs = Math.min(8000, 500 * 2 ** i);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function safeJson(value: unknown): string {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return (s ?? '').slice(0, 8000);
  } catch {
    return String(value).slice(0, 8000);
  }
}

/**
 * Like getOrchestrator, but guarantees a provider that supports NATIVE tool-calling
 * (chatWithTools). The agent loop needs this. We honour the Settings-selected provider
 * when it can do tools; if it is in account/CLI mode (no function-calling), we fall back
 * to the first configured API-key provider that can, so the loop still runs.
 */
export async function getToolCapableOrchestrator(agent: string, opts: { workspaceId?: string; userId?: string; effort?: string } = {}): Promise<AgentOrchestrator> {
  const canonical = canonicalAgent(agent);
  const preferred = resolveProviderForAgent(canonical);
  const order: ProviderName[] = [preferred, ...listConfiguredProviders().filter((p) => p !== preferred)];
  for (const provider of order) {
    const creds = getProviderCredentials(provider);
    if (!creds) continue;
    let base: AIProvider;
    try { base = buildProvider(provider); } catch { continue; }
    // Any provider that exposes chatWithTools works: API-key providers do it natively;
    // the account/CLI provider (codex/claude subscription) emulates it via prompting.
    if (!base.chatWithTools) continue;
    const model = resolveModelForAgent(canonical, provider);
    if (model && (base as any).defaultModel !== model) (base as any).defaultModel = model;
    return new AgentOrchestrator(base, canonical, opts.workspaceId || 'default', opts.userId, resolveEffortForAgent(canonical, provider, opts.effort));
  }
  throw new Error(
    'No tool-capable AI provider is configured. Enable a provider in Settings → AI Providers (Gemini/OpenAI/Anthropic API key, or codex/claude in account mode).',
  );
}

export async function getOrchestrator(agent: string, opts: { workspaceId?: string; userId?: string; effort?: string } = {}): Promise<AgentOrchestrator> {
  // Resolve legacy agent names onto the 7 canonical roles so prompt overrides,
  // provider/model routing, and usage logging all use one consolidated identity.
  const canonical = canonicalAgent(agent);
  const provider = resolveProviderForAgent(canonical);
  const model = resolveModelForAgent(canonical, provider);
  const base = buildProvider(provider);
  if (model && (base as any).defaultModel !== model) {
    (base as any).defaultModel = model;
  }
  return new AgentOrchestrator(base, canonical, opts.workspaceId || 'default', opts.userId, resolveEffortForAgent(canonical, provider, opts.effort));
}
