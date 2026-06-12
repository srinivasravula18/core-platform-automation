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

import type { AIProvider, ProviderAuthMode, ProviderName } from './providers/types';
import { DEFAULT_MODELS } from './providers/types';
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
  if (settings?.authMode === 'account') {
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
  return explicit === 'true' || (!env || env === 'development' || env === 'dev');
}

export function buildProvider(provider: ProviderName): AIProvider {
  const creds = getProviderCredentials(provider);
  if (!creds) {
    throw new Error(
      `No credentials configured for provider "${provider}". Add an API key in Settings → AI Providers.`,
    );
  }
  const model = creds.model || DEFAULT_MODELS[provider].default;
  if (creds.authMode === 'account') {
    if (!isLocalCliProviderAllowed()) {
      throw new Error(
        `Provider "${provider}" is configured for local subscription/account CLI auth, but CLI providers are disabled outside local development. Use API key mode in test and production.`,
      );
    }
    if (provider === 'openai') return new AccountCliProvider('openai', 'codex', model);
    if (provider === 'anthropic') return new AccountCliProvider('anthropic', 'claude', model);
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
  const validModels = [DEFAULT_MODELS[provider].default, ...DEFAULT_MODELS[provider].alternatives];
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

export class AgentOrchestrator {
  constructor(
    private provider: AIProvider,
    private agent: string,
    private workspaceId: string,
    private userId?: string,
  ) {}

  private async assembleSystem(pipeline: PipelineResult): Promise<string> {
    const override = await getActivePrompt(this.agent);
    if (override && override.body) {
      return `${override.body}\n\n[Guardrail pipeline: ${pipeline.requestId}]`;
    }
    return pipeline.systemPrompt;
  }

  async generateObject<T>(opts: { prompt: string; schema: unknown; temperature?: number; maxTokens?: number; userMessage?: string }) {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
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
    const result = await this.provider.generateObject<T>({
      system,
      prompt: opts.prompt,
      schema: opts.schema,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    await recordUsage({
      workspaceId: this.workspaceId,
      userId: this.userId,
      agent: this.agent,
      provider: this.provider.name,
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
      requestId: pipeline.requestId,
    });
    return { object: result.object, usage: result.usage, model: result.model, latencyMs: result.latencyMs, provider: this.provider.name };
  }

  async generateText(opts: { prompt: string; temperature?: number; maxTokens?: number; userMessage?: string }) {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
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
    });
    await recordUsage({
      workspaceId: this.workspaceId,
      userId: this.userId,
      agent: this.agent,
      provider: this.provider.name,
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
      requestId: pipeline.requestId,
    });
    return { text: result.text, usage: result.usage, model: result.model, latencyMs: result.latencyMs, provider: this.provider.name };
  }

  async *streamText(opts: { prompt: string; temperature?: number; maxTokens?: number; userMessage?: string }): AsyncIterable<string> {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
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
      const result = await this.provider.generateText({ system, prompt: opts.prompt, temperature: opts.temperature, maxTokens: opts.maxTokens });
      yield result.text;
      return;
    }
    for await (const delta of this.provider.generateTextStream({ system, prompt: opts.prompt, temperature: opts.temperature, maxTokens: opts.maxTokens })) {
      if (delta) yield delta;
    }
  }
}

export async function getOrchestrator(agent: string, opts: { workspaceId?: string; userId?: string } = {}): Promise<AgentOrchestrator> {
  // Resolve legacy agent names onto the 7 canonical roles so prompt overrides,
  // provider/model routing, and usage logging all use one consolidated identity.
  const canonical = canonicalAgent(agent);
  const provider = resolveProviderForAgent(canonical);
  const model = resolveModelForAgent(canonical, provider);
  const base = buildProvider(provider);
  if (model && (base as any).defaultModel !== model) {
    (base as any).defaultModel = model;
  }
  return new AgentOrchestrator(base, canonical, opts.workspaceId || 'default', opts.userId);
}
